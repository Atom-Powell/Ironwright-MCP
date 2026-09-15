/**
 * Builds a synthetic tree in a SharePoint document library, so `npm run scan`'s
 * own Graph request count can be checked against something realistically
 * sized. Pain-Points.txt's founding complaint is that the old recursive
 * enumeration costs "hundreds of operations" against a large inventory, and
 * this project's answer is delta query plus a persisted continuation link. That
 * claim has never been checked, because no tenant has ever held a library big
 * enough for the two approaches to look different: the existing runbook's
 * synthetic library is two client folders and a handful of files, where the
 * recursive baseline is about four requests and delta is three. This script
 * exists to make the difference visible, not to prove the mechanism works
 * again.
 *
 * Imports exactly two things from src/domain/, both by scripts/seed/expected.ts,
 * and both legitimate for the same underlying reason: a caller of the engine
 * should not have to re-derive what the engine already derives. The
 * reconciliation engine's front door, src/domain/reconcile/index.js, predicts
 * the report this seed should produce; that is what the front door is for,
 * and the alternative is a second implementation of the rolling window, the
 * quarterly anchor and the effective-date rule, which is the duplication the
 * single-entry rule exists to prevent. And the profile schema,
 * src/domain/profile/schema.js, because reconcile takes a validated Profile
 * while this script starts from raw JSON, so something has to parse and
 * validate it, and writing a second validator by hand would be the same
 * duplication in a different place.
 *
 * The token substitution below is still a local reimplementation of just
 * enough of naming.template's placeholder syntax, not a second copy of the
 * domain's renderer, and that stays deliberate: a fixture generator is not a
 * legitimate consumer of the renderer the engine uses to decide compliance.
 *
 * Authenticates as the grant issuer (IW_BOOTSTRAP_CLIENT_ID and
 * IW_BOOTSTRAP_CLIENT_SECRET), the same application docs/SETUP.md's
 * --create-bootstrap creates. That application already holds tenant-wide
 * Sites.FullControl.All, so it can write here, which keeps the server's own
 * application read-only for exactly the request count this script exists to
 * let an operator measure: a production scan never writes, so measuring it
 * with a credential that can is the wrong yardstick.
 */

import { pathToFileURL } from "node:url";
import { GRAPH_BASE, type GraphClient } from "../src/graph/client.js";
import { resolveDrive } from "../src/graph/drive.js";
import { GraphRequestError, graphErrorCodeFromBody } from "../src/graph/errors.js";
import { driveItemPath } from "../src/graph/paths.js";
import { clientCredentialsTokenProvider, type ClientCredentials, type TokenProvider } from "../src/graph/token.js";
import { readProfile } from "../src/scan/cli.js";
import { expectedReport, formatExpectedReport } from "./seed/expected.js";
import { createSeedWorkbook } from "./seed/workbook.js";

// ---------------------------------------------------------------------------
// Profile input: only the fields this script reads, validated by hand rather
// than against the full zod schema in src/domain/profile/schema.ts, since
// reaching for that schema would mean importing the domain layer this file is
// not allowed to depend on. A profile that fails this script's own, narrower
// checks may still be a perfectly valid profile for the scan; this validation
// only promises that the four fields the tree-builder needs are usable.
// ---------------------------------------------------------------------------

export interface SeedProfileIdentity {
  siteUrl: string;
  library: string;
  workbookPath: string;
}

export interface SeedProfileTaxonomy {
  segments: string[];
}

export interface SeedProfileNaming {
  template: string;
}

export interface SeedProfileDeliverable {
  token: string;
  cadence: string;
}

export interface SeedProfileInput {
  identity: SeedProfileIdentity;
  taxonomy: SeedProfileTaxonomy;
  naming: SeedProfileNaming;
  deliverables: SeedProfileDeliverable[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function loadSeedProfile(raw: unknown): SeedProfileInput {
  if (!isRecord(raw)) {
    throw new Error("The profile is not a JSON object.");
  }

  const identityRaw = raw.identity;
  if (!isRecord(identityRaw) || typeof identityRaw.siteUrl !== "string" || typeof identityRaw.library !== "string") {
    throw new Error(
      'The profile\'s "identity" section must carry a "siteUrl" string and a "library" string; the seeder ' +
        "resolves the same site and library the scan does.",
    );
  }

  if (typeof identityRaw.workbookPath !== "string" || identityRaw.workbookPath.length === 0) {
    throw new Error(
      'The profile\'s "identity.workbookPath" must be a non-empty string; it names the workbook this seeder ' +
        "replaces with a freshly built one.",
    );
  }

  const taxonomyRaw = raw.taxonomy;
  const segments = isRecord(taxonomyRaw) ? taxonomyRaw.segments : undefined;
  if (
    !Array.isArray(segments) ||
    segments.length === 0 ||
    !segments.every((segment): segment is string => typeof segment === "string")
  ) {
    throw new Error(
      'The profile\'s "taxonomy.segments" must be a non-empty array of strings. The seeder derives the folder ' +
        "shape it builds from this array, so there is nothing to build without it.",
    );
  }

  const namingRaw = raw.naming;
  const template = isRecord(namingRaw) ? namingRaw.template : undefined;
  if (typeof template !== "string" || template.length === 0) {
    throw new Error(
      'The profile\'s "naming.template" must be a non-empty string; it names the files the seeder creates.',
    );
  }

  const deliverablesRaw = raw.deliverables;
  if (!Array.isArray(deliverablesRaw)) {
    throw new Error(
      'The profile\'s "deliverables" must be an array; the seeder reads each entry\'s token and cadence.',
    );
  }

  const deliverables = deliverablesRaw.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.token !== "string" || typeof entry.cadence !== "string") {
      throw new Error(
        `The profile's "deliverables[${index}]" must carry a string "token" and a string "cadence". The seeder ` +
          'places one file per "monthly" entry every month, and, if requested, one file per "quarterly" entry ' +
          "at the end of each quarter.",
      );
    }
    return { token: entry.token, cadence: entry.cadence };
  });

  return {
    identity: { siteUrl: identityRaw.siteUrl, library: identityRaw.library, workbookPath: identityRaw.workbookPath },
    taxonomy: { segments },
    naming: { template },
    deliverables,
  };
}

// ---------------------------------------------------------------------------
// Token substitution. Supports exactly the tokens naming.template and
// taxonomy.segments use in examples/profiles/example.json: {year}, {client},
// {month:02}, {monthName}, and {deliverable}. A template using any other
// token is refused rather than left with a literal, unsubstituted "{...}" in
// a path Graph would otherwise happily create.
// ---------------------------------------------------------------------------

export interface TokenValues {
  year: string;
  client?: string;
  monthNumber?: string;
  monthName?: string;
  deliverable?: string;
}

const SUPPORTED_TOKEN_PATTERN = /\{(year|client|month:02|monthName|deliverable)\}/g;

export function substituteTokens(template: string, values: TokenValues): string {
  const substituted = template.replace(SUPPORTED_TOKEN_PATTERN, (match, token: string) => {
    switch (token) {
      case "year":
        return values.year;
      case "client":
        if (values.client === undefined) {
          throw new Error(`The template "${template}" uses {client}, but no client value was supplied for it.`);
        }
        return values.client;
      case "month:02":
        if (values.monthNumber === undefined) {
          throw new Error(`The template "${template}" uses {month:02}, but no month value was supplied for it.`);
        }
        return values.monthNumber;
      case "monthName":
        if (values.monthName === undefined) {
          throw new Error(`The template "${template}" uses {monthName}, but no month value was supplied for it.`);
        }
        return values.monthName;
      case "deliverable":
        if (values.deliverable === undefined) {
          throw new Error(
            `The template "${template}" uses {deliverable}, but no deliverable value was supplied for it.`,
          );
        }
        return values.deliverable;
      default:
        // Unreachable: SUPPORTED_TOKEN_PATTERN's capture group only ever
        // matches one of the five cases above.
        return match;
    }
  });

  const leftover = /\{[^{}]*\}/.exec(substituted);
  if (leftover !== null) {
    throw new Error(
      `The template "${template}" contains a token this seeder does not support: "${leftover[0]}". Supported ` +
        "tokens are {year}, {client}, {month:02}, {monthName}, and {deliverable}.",
    );
  }

  return substituted;
}

// ---------------------------------------------------------------------------
// Tree enumeration: a pure function from a profile plus sizing options to the
// list of folder paths and file paths a seed run intends to create. Every
// other seaming decision, the dry-run estimate and the execution layer alike,
// reads from this same list rather than recomputing anything, so the two
// cannot drift apart.
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// The last month of each calendar quarter. This is a simplified stand-in for
// a deliverable's own periodAnchor (src/domain/profile/schema.ts), which this
// script does not read: periodAnchor selection is domain-schema behavior, and
// reaching for it would mean reaching for the domain layer this file is not
// allowed to depend on. "Last month of the quarter" is a reasonable synthetic
// placement on its own and does not have to match that field's exact
// semantics to serve this script's one purpose, sizing a tree for a request
// count comparison.
const QUARTER_END_MONTHS = new Set([3, 6, 9, 12]);

export const DEFAULT_CLIENT_COUNT = 12;

export interface SeedOptions {
  clientCount: number;
  year: number;
  includeQuarterly: boolean;
  throughMonth: number;
}

export interface SeedTree {
  folderPaths: string[];
  filePaths: string[];
}

function clientName(index: number): string {
  return `Client${String(index).padStart(2, "0")}`;
}

export function buildSeedTree(profile: SeedProfileInput, options: SeedOptions): SeedTree {
  if (!Number.isInteger(options.clientCount) || options.clientCount < 1) {
    throw new Error(`clientCount must be a positive whole number, got ${options.clientCount}.`);
  }
  if (!Number.isInteger(options.throughMonth) || options.throughMonth < 1 || options.throughMonth > 12) {
    throw new Error(`throughMonth must be a whole number from 1 through 12, got ${options.throughMonth}.`);
  }
  if (profile.taxonomy.segments.length === 0) {
    throw new Error("profile.taxonomy.segments is empty; there is no folder shape to seed.");
  }

  const monthlyDeliverable = profile.deliverables.find((entry) => entry.cadence === "monthly");
  if (monthlyDeliverable === undefined) {
    throw new Error(
      'The profile carries no deliverable with cadence "monthly", so the seeder has no token to name the file ' +
        "it creates in every month folder.",
    );
  }

  const quarterlyDeliverable = profile.deliverables.find((entry) => entry.cadence === "quarterly");
  if (options.includeQuarterly && quarterlyDeliverable === undefined) {
    throw new Error(
      'includeQuarterly was requested but the profile carries no deliverable with cadence "quarterly". Pass ' +
        "--no-quarterly, or use a profile that defines one.",
    );
  }

  // A Set preserves insertion order in JS and de-duplicates for free, which is
  // exactly what a shared ancestor needs: "2026" and "2026/Client01" recur
  // across every month of every client, and each must be created once, before
  // anything nested inside it, never once per recurrence.
  const folderPaths = new Set<string>();
  const filePaths: string[] = [];
  const year = String(options.year);

  for (let clientIndex = 1; clientIndex <= options.clientCount; clientIndex += 1) {
    const client = clientName(clientIndex);

    for (let month = 1; month <= options.throughMonth; month += 1) {
      const monthName = MONTH_NAMES[month - 1];
      if (monthName === undefined) {
        // Unreachable: the loop bound keeps month within 1..12, matching the
        // fixed twelve-entry array above.
        throw new Error(`Internal error: no month name is defined for month ${month}.`);
      }
      const monthNumber = String(month).padStart(2, "0");
      const values: TokenValues = { year, client, monthNumber, monthName };

      let cursor = "";
      for (const segment of profile.taxonomy.segments) {
        const rendered = substituteTokens(segment, values);
        cursor = cursor === "" ? rendered : `${cursor}/${rendered}`;
        folderPaths.add(cursor);
      }
      const leafFolder = cursor;

      const monthlyFileName = substituteTokens(profile.naming.template, {
        ...values,
        deliverable: monthlyDeliverable.token,
      });
      filePaths.push(`${leafFolder}/${monthlyFileName}`);

      if (options.includeQuarterly && quarterlyDeliverable !== undefined && QUARTER_END_MONTHS.has(month)) {
        const quarterlyFileName = substituteTokens(profile.naming.template, {
          ...values,
          deliverable: quarterlyDeliverable.token,
        });
        filePaths.push(`${leafFolder}/${quarterlyFileName}`);
      }
    }
  }

  return { folderPaths: [...folderPaths], filePaths };
}

// ---------------------------------------------------------------------------
// The seed plan: the tree buildSeedTree produces, plus the fixed set of
// planted discrepancies a later reconciliation run is meant to find. Kept as
// a second, thin layer over buildSeedTree rather than folded into it, because
// planting drift is a concern specific to the workbook-and-reconciliation
// exercise this seeder is building toward, not a property of "a synthetic
// tree" in general; npm run scan's request-count measurement, the one
// buildSeedTree alone still serves, has no use for it.
// ---------------------------------------------------------------------------

/**
 * The three planted discrepancies. Fixed rather than random, because the
 * expected report this seed prints has to stay true across a re-seed, and
 * because an operator comparing a live report against it needs to know which
 * findings were put there on purpose.
 */
export const ABSENT_CLIENT = "Client13";
export const MISSING_FILE_CLIENT = "Client04";
export const MISNAMED_FILE_CLIENT = "Client09";

// Both planted months are January, not a later, more illustrative month.
// throughMonth caps the tree at the current month when the seeded year is
// the current year, so a plant placed later in the year is unreachable for
// however much of the year has not happened yet: at month 7 this plant was
// unreachable from January through June, and at month 3 it was unreachable
// in January and February too. January is always within range, because
// throughMonth is never below 1, and it is on or after the January 1
// effective date every client gets, so the window still expects it. Leave
// this at 1.
export const MISSING_FILE_MONTH = 1;
export const MISNAMED_FILE_MONTH = 1;

/**
 * The misnamed file uses the example profile's vendor-token recognizer, not
 * its legacy-spaced one. legacy-spaced anchors its client capture on
 * [A-Z0-9]+, which cannot match "Client09", so a file in that shape would
 * land as an unrecognized orphan and exercise the recognizer path not at all.
 */
const MISNAMED_DELIVERABLE_TOKEN = "VendorTraining";

function clientIndexFromPlantedName(name: string): number {
  const match = /^Client(\d+)$/.exec(name);
  if (match === null) {
    // Unreachable today: both planted client constants above are written by
    // hand in the same Client<NN> shape clientName produces below. Checked
    // anyway so a future edit to either constant fails here, with a clear
    // reason, rather than silently computing a floor of NaN.
    throw new Error(`Internal error: "${name}" is not in the Client<NN> shape clientName produces.`);
  }
  return Number.parseInt(match[1] as string, 10);
}

// The lowest clientCount that can carry the fixed planted set. Below it,
// buildSeedTree never creates a folder for one of the two clients the plant
// names, so planting would fail for a reason that has nothing to do with the
// naming template. Derived from the constants above, not hardcoded, so a
// future edit to either one cannot leave this floor behind.
const MINIMUM_CLIENT_COUNT_FOR_PLANTED_DRIFT = Math.max(
  clientIndexFromPlantedName(MISSING_FILE_CLIENT),
  clientIndexFromPlantedName(MISNAMED_FILE_CLIENT),
);

// The highest clientCount that leaves ABSENT_CLIENT out of the tree. At or
// above it, buildSeedTree builds a folder for the very client this plant
// means to report as missing from the repository, and workbookClients below
// would then list it twice: once from the built clients array, once from the
// explicit ABSENT_CLIENT append. Derived from the constant above, not
// hardcoded, so a future edit to ABSENT_CLIENT cannot leave this ceiling
// behind.
const MAXIMUM_CLIENT_COUNT_FOR_PLANTED_DRIFT = clientIndexFromPlantedName(ABSENT_CLIENT) - 1;

export interface SeedPlan {
  clients: string[];
  workbookClients: string[];
  year: number;
  throughMonth: number;
  includeQuarterly: boolean;
  tree: SeedTree;
}

export function buildSeedPlan(profile: SeedProfileInput, options: SeedOptions): SeedPlan {
  if (options.clientCount < MINIMUM_CLIENT_COUNT_FOR_PLANTED_DRIFT) {
    // Refused rather than seeded without the plant: this seed's whole point
    // is to put one of each interesting finding in front of the
    // reconciliation engine, and a run that silently drops the planted drift
    // would make the expectation a later task prints against this tree false.
    throw new Error(
      `clientCount must be at least ${MINIMUM_CLIENT_COUNT_FOR_PLANTED_DRIFT} to plant this seed's fixed ` +
        `discrepancy set, which names ${MISSING_FILE_CLIENT} and ${MISNAMED_FILE_CLIENT}. Got ` +
        `${options.clientCount}.`,
    );
  }
  if (options.clientCount > MAXIMUM_CLIENT_COUNT_FOR_PLANTED_DRIFT) {
    // Refused for the same reason as the floor guard above, from the other
    // direction: at clientCount 13 or higher, buildSeedTree would build a
    // folder for Client13, the client this plant means to report as absent
    // from the repository, and this function would list it twice in
    // workbookClients without ever noticing.
    throw new Error(
      `clientCount must be at most ${MAXIMUM_CLIENT_COUNT_FOR_PLANTED_DRIFT} so ${ABSENT_CLIENT} stays absent ` +
        `from the tree, which is what this plant needs it to be. Got ${options.clientCount}.`,
    );
  }

  const base = buildSeedTree(profile, options);
  const clients: string[] = [];
  for (let index = 1; index <= options.clientCount; index += 1) clients.push(clientName(index));

  const year = String(options.year);
  if (MONTH_NAMES[MISSING_FILE_MONTH - 1] === undefined || MONTH_NAMES[MISNAMED_FILE_MONTH - 1] === undefined) {
    // Unreachable today: both constants are within 1..12 and MONTH_NAMES has
    // twelve entries. Checked anyway so a future edit to either constant fails
    // here rather than producing a path with "undefined" in it.
    throw new Error("Internal error: a planted month has no name in MONTH_NAMES.");
  }

  const monthlyToken = profile.deliverables.find((entry) => entry.cadence === "monthly")?.token;
  if (monthlyToken === undefined) {
    throw new Error(
      'The profile carries no deliverable with cadence "monthly", so this seed has no artifact to plant against.',
    );
  }

  const omitted = plantedPath(profile, year, MISSING_FILE_CLIENT, MISSING_FILE_MONTH, monthlyToken);
  const replacedFrom = plantedPath(profile, year, MISNAMED_FILE_CLIENT, MISNAMED_FILE_MONTH, monthlyToken);
  const replacedTo = plantedPath(profile, year, MISNAMED_FILE_CLIENT, MISNAMED_FILE_MONTH, MISNAMED_DELIVERABLE_TOKEN);

  // Checked individually, by path presence, and before the filter/map below
  // runs: a `.map` silently no-ops when its own target is absent, so a single
  // check on the resulting array's length cannot see a failed rename the way
  // it can see a failed removal (removing nothing changes the length; a
  // no-op rename does not). Each message leads with the fact this function
  // actually observed: the path is not in the tree buildSeedTree produced.
  // Only then does it name a likely cause. That inference is sound here,
  // where it would not have been for a bare length check: clientCount is
  // guarded on both sides above (MINIMUM_CLIENT_COUNT_FOR_PLANTED_DRIFT and
  // MAXIMUM_CLIENT_COUNT_FOR_PLANTED_DRIFT), and both planted months are
  // fixed at 1, always within throughMonth's 1..12 range, so neither plant's
  // client nor its month can be why its path is missing. What is left is a
  // disagreement between the profile's naming template and this seed's
  // planted set.
  if (!base.filePaths.includes(replacedFrom)) {
    throw new Error(
      `${replacedFrom} is not in the tree buildSeedTree produced, so the misnamed-file plant for ` +
        `${MISNAMED_FILE_CLIENT} cannot rename it to ${replacedTo}. clientCount and month are both guaranteed in ` +
        "range here, so the profile's naming template and this seed's planted set must have diverged.",
    );
  }
  if (!base.filePaths.includes(omitted)) {
    throw new Error(
      `${omitted} is not in the tree buildSeedTree produced, so the missing-file plant for ${MISSING_FILE_CLIENT} ` +
        "cannot remove it. clientCount and month are both guaranteed in range here, so the profile's naming " +
        "template and this seed's planted set must have diverged.",
    );
  }

  const filePaths = base.filePaths
    .filter((path) => path !== omitted)
    .map((path) => (path === replacedFrom ? replacedTo : path));

  return {
    clients,
    workbookClients: [...clients, ABSENT_CLIENT],
    year: options.year,
    throughMonth: options.throughMonth,
    includeQuarterly: options.includeQuarterly,
    tree: { folderPaths: base.folderPaths, filePaths },
  };
}

function plantedPath(
  profile: SeedProfileInput,
  year: string,
  client: string,
  month: number,
  deliverable: string,
): string {
  const monthNumber = String(month).padStart(2, "0");
  const monthName = MONTH_NAMES[month - 1] as string;
  const values = { year, client, monthNumber, monthName };
  let cursor = "";
  for (const segment of profile.taxonomy.segments) {
    const rendered = substituteTokens(segment, values);
    cursor = cursor === "" ? rendered : `${cursor}/${rendered}`;
  }
  return `${cursor}/${substituteTokens(profile.naming.template, { ...values, deliverable })}`;
}

// resolveDrive (src/graph/drive.ts) issues exactly two GET requests: one to
// resolve the site, one to list its drives. This constant mirrors that count
// rather than measuring it, so if resolveDrive's own request shape ever
// changes, this estimate silently drifts from it; there is no automated link
// between the two.
const RESOLVE_DRIVE_REQUEST_COUNT = 2;

// createSeedWorkbook (scripts/seed/workbook.ts) issues five requests once the
// workbook's parent folder exists: the blank upload, the range write, the
// Onboarded column's number format, the table add, and the table rename. This
// constant mirrors that count rather than measuring it, so if
// createSeedWorkbook's own call sequence ever changes, this estimate silently
// drifts from it; there is no automated link between the two.
const WORKBOOK_FIXED_REQUEST_COUNT = 5;

/**
 * The workbook's ancestor folders, root to leaf, the same walk
 * createSeedWorkbook performs before its own five fixed calls: one
 * createFolder per segment of the path above the workbook file itself. A
 * workbook sitting directly at the library root has no ancestor to create, so
 * this returns an empty array rather than a "-1" that would have to be
 * special-cased at every call site.
 */
function workbookAncestorSegments(workbookPath: string): string[] {
  const { parentPath } = splitPath(workbookPath.replace(/^\/+/, ""));
  return parentPath === "" ? [] : parentPath.split("/").filter((segment) => segment.length > 0);
}

/**
 * Derived from workbookPath rather than a flat constant, because the cost
 * this function estimates is not fixed: createSeedWorkbook walks the path's
 * own ancestor chain before its five fixed calls, so a workbook nested
 * several folders deep costs more than one at the library root. See
 * WORKBOOK_FIXED_REQUEST_COUNT above for why the five is a mirror, not a
 * measurement, of createSeedWorkbook's own call count.
 */
function estimateWorkbookRequests(workbookPath: string): number {
  return WORKBOOK_FIXED_REQUEST_COUNT + workbookAncestorSegments(workbookPath).length;
}

/**
 * Derived from the same tree the execution layer walks, not computed
 * separately: RESOLVE_DRIVE_REQUEST_COUNT aside, this is exactly
 * folderPaths.length POSTs plus filePaths.length PUTs, one request each,
 * because that is what executeSeed below actually issues, unconditionally,
 * with no existence check before it, plus estimateWorkbookRequests above for
 * the workbook createSeedWorkbook replaces afterward. It is still an
 * estimate, not a measured cost, because it assumes nothing is retried. It is
 * not, however, an estimate a re-run "beats": executeSeed issues the same
 * request for every tree entry whether or not that entry already exists, and
 * createSeedWorkbook always replaces the workbook outright, so a re-run
 * against a partially built tree costs the same number of requests as a
 * fresh one. What changes on a re-run is the side effect at each
 * already-existing path, not the request count.
 */
export function estimateGraphRequests(tree: SeedTree, workbookPath: string): number {
  return RESOLVE_DRIVE_REQUEST_COUNT + tree.folderPaths.length + tree.filePaths.length + estimateWorkbookRequests(workbookPath);
}

// ---------------------------------------------------------------------------
// Argument parsing, in the style of src/scan/cli.ts's parseScanArguments:
// pure, so it can be tested without touching the file system or the network.
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: npm run seed-library -- --profile <path to profile json> " +
  "[--clients <count>] [--year <yyyy>] [--no-quarterly] [--confirm]";

export interface SeedArguments {
  profilePath: string;
  clientCount: number;
  year: number;
  includeQuarterly: boolean;
  confirm: boolean;
  throughMonth: number;
}

export function parseSeedArguments(argv: readonly string[], options: { now?: () => Date } = {}): SeedArguments {
  const now = options.now ?? (() => new Date());
  let profilePath: string | undefined;
  let clientCount = DEFAULT_CLIENT_COUNT;
  let year = now().getFullYear();
  let includeQuarterly = true;
  let confirm = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    // A flag's value is read as a value only when it is not itself a flag, the
    // same guard src/scan/cli.ts uses, and for the same reason: without it
    // "--clients --confirm" would silently read "--confirm" as a client count.
    const value = argv[index + 1];
    const hasValue = value !== undefined && !value.startsWith("--");

    if (flag === "--profile") {
      if (!hasValue) throw new Error(`--profile needs a value. ${USAGE}`);
      profilePath = value;
      index += 1;
    } else if (flag === "--clients") {
      if (!hasValue) throw new Error(`--clients needs a value. ${USAGE}`);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
        throw new Error(`--clients must be a positive whole number, got "${value}". ${USAGE}`);
      }
      clientCount = parsed;
      index += 1;
    } else if (flag === "--year") {
      if (!hasValue) throw new Error(`--year needs a value. ${USAGE}`);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
        throw new Error(`--year must be a positive whole number, got "${value}". ${USAGE}`);
      }
      year = parsed;
      index += 1;
    } else if (flag === "--no-quarterly") {
      includeQuarterly = false;
    } else if (flag === "--confirm") {
      confirm = true;
    } else {
      throw new Error(`Unrecognized argument "${flag}". ${USAGE}`);
    }
  }

  if (profilePath === undefined) throw new Error(`--profile is required. ${USAGE}`);

  // A deliverable for a month that has not happened yet is not a realistic
  // synthetic library, and against a rolling window the engine reports each
  // one as an unexpected orphan: with twelve clients seeded in September that
  // is thirty-six findings burying the three this seed plants on purpose.
  const currentYear = now().getUTCFullYear();
  const throughMonth = year === currentYear ? now().getUTCMonth() + 1 : 12;

  return { profilePath, clientCount, year, includeQuarterly, confirm, throughMonth };
}

// ---------------------------------------------------------------------------
// Reporting. Both functions are pure and read only from values their callers
// already computed, so the estimate and the executed counts can never name a
// number that was not actually derived from the tree or the run.
// ---------------------------------------------------------------------------

export function formatDryRunReport(tree: SeedTree, args: SeedArguments, workbookPath: string): string[] {
  const estimate = estimateGraphRequests(tree, workbookPath);
  return [
    "Dry run: nothing was created. Pass --confirm to create this tree.",
    `Profile: ${args.profilePath}. Clients: ${args.clientCount}. Year: ${args.year}. ` +
      `Quarterly deliverable: ${args.includeQuarterly ? "included" : "excluded"}.`,
    `Folders that would be created: ${tree.folderPaths.length}.`,
    `Files that would be created: ${tree.filePaths.length}.`,
    `Workbook that would be replaced, not updated: ${workbookPath}.`,
    `Estimated Graph requests to build this tree and replace the workbook: ${estimate}. This is an estimate, ` +
      "not a measured cost: it assumes one request per folder, one per file, the two requests resolveDrive " +
      "issues to find the site and the library, and the fixed calls createSeedWorkbook issues to replace the " +
      "workbook (one createFolder per ancestor folder in its path, plus five to upload the blank file, write its " +
      "rows, format its date column, add its table, and name it). A re-run costs the same number of requests, " +
      "not fewer: executeSeed issues one request per tree entry regardless of whether that item already exists, " +
      "and createSeedWorkbook always replaces the workbook outright. What a re-run changes is the side effect, " +
      "not the count: an existing folder is left alone rather than recreated or erroring, an existing file is " +
      "overwritten with the same placeholder content it already had, and the workbook is overwritten with a " +
      "freshly built one either way.",
  ];
}

export interface SeedExecutionResult {
  driveId: string;
  foldersProcessed: number;
  filesProcessed: number;
  graphRequests: number;
  elapsedMs: number;
}

// workbookRequests is kept off SeedExecutionResult itself and carried as an
// intersection here instead, because executeSeed above never learns it:
// createSeedWorkbook runs after executeSeed returns, against the driveId
// executeSeed resolved, so the caller has to combine the two before this
// function ever sees them.
//
// Printed as its own line rather than folded into graphRequests, on purpose.
// graphRequests is the number this whole script exists to let an operator
// measure against the recursive-enumeration baseline Pain-Points.txt
// complains about; the workbook's calls have nothing to do with that
// comparison, and adding them into the same total would make that number
// stop meaning what it is supposed to mean.
export function formatExecutionReport(result: SeedExecutionResult & { workbookRequests: number }): string[] {
  return [
    `Seed complete against drive ${result.driveId}.`,
    `Folders processed: ${result.foldersProcessed}. Files processed: ${result.filesProcessed}.`,
    `Graph requests issued to build the tree: ${result.graphRequests}.`,
    `Graph requests issued to replace the workbook: ${result.workbookRequests}.`,
    `Elapsed: ${result.elapsedMs}ms.`,
  ];
}

// ---------------------------------------------------------------------------
// The thin execution layer: walks the tree buildSeedTree produced and issues
// exactly one Graph write per entry. Not unit tested against a real tenant,
// per the brief; it is exercised by the operator. What can be tested without
// a network is tested through SeedGraphClient's interface with a fake.
// ---------------------------------------------------------------------------

export function splitPath(path: string): { parentPath: string; name: string } {
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex === -1) return { parentPath: "", name: path };
  return { parentPath: path.slice(0, separatorIndex), name: path.slice(separatorIndex + 1) };
}

export interface SeedGraphClient extends GraphClient {
  createFolder(driveId: string, parentPath: string, name: string): Promise<{ status: number }>;
  createFile(driveId: string, parentPath: string, name: string, content: string): Promise<{ status: number }>;
  putBytes(driveId: string, path: string, bytes: Uint8Array, contentType: string): Promise<{ status: number }>;
  patch<T>(path: string, body?: unknown): Promise<T>;
}

export async function executeSeed(
  client: SeedGraphClient,
  identity: SeedProfileIdentity,
  tree: SeedTree,
): Promise<SeedExecutionResult> {
  const startedAt = Date.now();
  const requestsAtStart = client.requests();

  const { driveId } = await resolveDrive(client, identity.siteUrl, identity.library);

  // Folders first, and strictly in tree.folderPaths order: buildSeedTree
  // inserts every parent before any child built under it, and Graph's
  // children endpoint needs the parent to already exist before a child can be
  // created inside it.
  for (const folderPath of tree.folderPaths) {
    const { parentPath, name } = splitPath(folderPath);
    await client.createFolder(driveId, parentPath, name);
  }

  for (const filePath of tree.filePaths) {
    const { parentPath, name } = splitPath(filePath);
    await client.createFile(driveId, parentPath, name, PLACEHOLDER_FILE_CONTENT);
  }

  return {
    driveId,
    foldersProcessed: tree.folderPaths.length,
    filesProcessed: tree.filePaths.length,
    graphRequests: client.requests() - requestsAtStart,
    elapsedMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// The Graph client this script needs, beyond what src/graph/client.ts's
// createGraphClient offers: that client has no PUT, and it sends every body as
// JSON. Creating a folder is a POST it could make, but uploading a file is a
// PUT carrying the file's own bytes and content type, so this is a small,
// separate client rather than an extension of that one, sharing its token
// provider and its GRAPH_BASE constant, and its own request counter so the
// dry-run estimate and the executed count are comparing the same kind of
// number.
// ---------------------------------------------------------------------------

const PLACEHOLDER_FILE_CONTENT =
  "Synthetic file created by scripts/seed-library.ts to size a document library for a Graph request-count " +
  "comparison. Its content is a placeholder; only its existence and path matter.\n";

// Folders: "fail", Graph's own default, not "replace". A folder's content is
// its children, and Graph documents "replace" as overwriting the existing
// item; for a folder the plausible reading of "overwrite" is delete then
// recreate, taking everything nested under it along with it. That is exactly
// the scenario reconciliation testing depends on surviving: an operator adds
// files by hand under a seeded month folder to produce orphans and
// duplicates, then re-runs this script to top up a partial tree, and every
// leaf folder in the default tree is one this run revisits on that re-run.
// "fail" cannot destroy anything it did not itself just create, because it
// never touches an item that is already there. The 409 "nameAlreadyExists"
// it returns for a folder that already exists is tolerated below, by its
// exact code rather than by status alone, so any other failure still
// propagates. This has not been exercised against a live tenant in this
// change, because nothing in this change has run against one.
const FOLDER_CONFLICT_BEHAVIOR = "fail";

// Files: "replace", and deliberately the opposite of the folder choice above
// rather than an inconsistency left behind by accident. A file has no
// children for "replace" to take with it, and every file this script ever
// writes is the same placeholder content (PLACEHOLDER_FILE_CONTENT below), so
// overwriting an existing synthetic file with identical content loses
// nothing. The destructive reading that rules "replace" out for folders does
// not apply here: there is nothing nested under a file, and nothing this
// script would ever overwrite with content different from what is already
// there.
const FILE_CONFLICT_BEHAVIOR = "replace";

interface RawGraphResponse {
  status: number;
  body: string;
}

type SendBody = { text: string; contentType: string } | { bytes: Uint8Array; contentType: string };

export function createSeedGraphClient(options: {
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
}): SeedGraphClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  let requestCount = 0;

  async function send(path: string, method: string, body?: SendBody): Promise<RawGraphResponse> {
    const token = await options.tokenProvider.getToken();
    requestCount += 1;
    const response = await fetchImpl(`${GRAPH_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": body.contentType }),
      },
      // A workbook is binary, so its body cannot go through the text branch:
      // encoding those bytes as a UTF-8 string would corrupt every byte above
      // 0x7f and produce a file Graph refuses to open.
      ...(body === undefined ? {} : { body: "text" in body ? body.text : body.bytes }),
    });
    return { status: response.status, body: await response.text() };
  }

  return {
    requests: () => requestCount,

    // This script's one caller of get, resolveDrive, only ever passes a
    // relative path: unlike a scan, this script never follows an
    // @odata.nextLink or a deltaLink, so unlike src/graph/client.ts's own
    // get, there is no absolute-URL branch to carry here.
    //
    // `_headers` is accepted and dropped, and named rather than omitted so the
    // omission is visible at the signature. GraphClient's get takes per-call
    // headers, and handing this client to readWorkbookRange would silently
    // strip every workbook-session-id: Graph answers those calls anyway, in
    // non-session mode, so the read would succeed while the session it was
    // supposed to run inside did nothing. Nothing passes headers today. Send
    // them through send() before anything does.
    async get<T>(path: string, _headers?: Record<string, string>): Promise<T> {
      const response = await send(path, "GET");
      if (response.status < 200 || response.status >= 300) {
        throw new GraphRequestError({ method: "GET", path, status: response.status, body: response.body });
      }
      if (response.body.length === 0) return undefined as T;
      try {
        return JSON.parse(response.body) as T;
      } catch {
        throw new Error(
          `Graph GET ${path} returned ${response.status} with a body that is not JSON. Something other than ` +
            "Graph answered this request.",
        );
      }
    },

    // Not called by executeSeed today -- folder and file creation both go
    // through send() directly below, not through this generic entry point.
    // Implemented for real, rather than stubbed, because SeedGraphClient
    // extends GraphClient and a stub that throws would be a client claiming a
    // capability it silently refuses; the pattern matches get's above,
    // including the dropped `_headers` and the reason it is named.
    async post<T>(path: string, body?: unknown, _headers?: Record<string, string>): Promise<T> {
      const response = await send(
        path,
        "POST",
        body === undefined ? undefined : { text: JSON.stringify(body), contentType: "application/json" },
      );
      if (response.status < 200 || response.status >= 300) {
        throw new GraphRequestError({ method: "POST", path, status: response.status, body: response.body });
      }
      if (response.body.length === 0) return undefined as T;
      try {
        return JSON.parse(response.body) as T;
      } catch {
        throw new Error(
          `Graph POST ${path} returned ${response.status} with a body that is not JSON. Something other than ` +
            "Graph answered this request.",
        );
      }
    },

    async createFolder(driveId, parentPath, name) {
      const path = `${driveItemPath(driveId, parentPath)}/children`;
      const response = await send(path, "POST", {
        text: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": FOLDER_CONFLICT_BEHAVIOR }),
        contentType: "application/json",
      });
      if (response.status < 200 || response.status >= 300) {
        // Tolerated by its exact machine-readable code, not by status alone:
        // "fail" conflict behavior 409s a folder that already exists with
        // Graph's own "nameAlreadyExists" code, which is exactly the outcome a
        // re-run wants -- the folder is there, so there is nothing for this
        // call to do, and nothing at that path is touched. A 409 carrying any
        // other code, and every other status, is a real failure and
        // propagates, the same as any other call this client makes.
        if (response.status === 409 && graphErrorCodeFromBody(response.body) === "nameAlreadyExists") {
          return { status: response.status };
        }
        throw new GraphRequestError({ method: "POST", path, status: response.status, body: response.body });
      }
      return { status: response.status };
    },

    async createFile(driveId, parentPath, name, content) {
      const filePath = parentPath === "" ? name : `${parentPath}/${name}`;
      const path = `${driveItemPath(driveId, filePath)}/content?@microsoft.graph.conflictBehavior=${FILE_CONFLICT_BEHAVIOR}`;
      const response = await send(path, "PUT", { text: content, contentType: "text/plain" });
      if (response.status < 200 || response.status >= 300) {
        throw new GraphRequestError({ method: "PUT", path, status: response.status, body: response.body });
      }
      return { status: response.status };
    },

    async putBytes(driveId, filePath, bytes, contentType) {
      const path = `${driveItemPath(driveId, filePath)}/content`;
      const response = await send(path, "PUT", { bytes, contentType });
      if (response.status < 200 || response.status >= 300) {
        throw new GraphRequestError({ method: "PUT", path, status: response.status, body: response.body });
      }
      return { status: response.status };
    },

    async patch<T>(path: string, body?: unknown): Promise<T> {
      const response = await send(path, "PATCH", body === undefined ? undefined : { text: JSON.stringify(body), contentType: "application/json" });
      if (response.status < 200 || response.status >= 300) {
        throw new GraphRequestError({ method: "PATCH", path, status: response.status, body: response.body });
      }
      if (response.body.length === 0) return undefined as T;
      try {
        return JSON.parse(response.body) as T;
      } catch {
        throw new Error(
          `Graph PATCH ${path} returned ${response.status} with a body that is not JSON. Something other than ` +
            "Graph answered this request.",
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestration and the command-line entry point.
// ---------------------------------------------------------------------------

export interface SeedDependencies {
  readProfileFile: (path: string) => Promise<unknown>;
  /** Called only when --confirm is given: a dry run must issue no Graph call at all. */
  createGraphClient: () => SeedGraphClient;
  now: () => Date;
  log: (line: string) => void;
}

/**
 * Converts the injected clock to the Period reconcile takes as asOf, in UTC,
 * the same offset parseSeedArguments already uses to cap throughMonth at the
 * current month. Not exported: nothing outside this orchestration needs it,
 * and it stays a plain { year, month } literal rather than importing
 * src/domain/reconcile's Period type, because this file's only sanctioned
 * path into src/domain/ is through scripts/seed/expected.ts, per this file's
 * own header comment. Structural typing satisfies expectedReport's asOf
 * parameter without an import.
 */
function asOfFromClock(now: () => Date): { year: number; month: number } {
  const date = now();
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

export async function runSeed(argv: readonly string[], dependencies: SeedDependencies): Promise<void> {
  const args = parseSeedArguments(argv, { now: dependencies.now });
  // rawProfile, not profile, goes to expectedReport below: loadSeedProfile
  // only validates the four fields this script's own tree-building needs, but
  // expectedReport runs the real reconciliation engine, which needs the full
  // profile shape ProfileSchema validates, including workbookMapping, window,
  // and every recognizer. Keeping both around, rather than only the narrower
  // one, is what lets each side ask for exactly what it uses.
  const rawProfile = await dependencies.readProfileFile(args.profilePath);
  const profile = loadSeedProfile(rawProfile);
  const plan = buildSeedPlan(profile, {
    clientCount: args.clientCount,
    year: args.year,
    includeQuarterly: args.includeQuarterly,
    throughMonth: args.throughMonth,
  });

  if (!args.confirm) {
    for (const line of formatDryRunReport(plan.tree, args, profile.identity.workbookPath)) dependencies.log(line);
    return;
  }

  const client = dependencies.createGraphClient();
  const result = await executeSeed(client, profile.identity, plan.tree);
  const workbook = await createSeedWorkbook(client, result.driveId, profile.identity.workbookPath, plan);
  for (const line of formatExecutionReport({ ...result, workbookRequests: workbook.requests })) {
    dependencies.log(line);
  }
  for (const line of formatExpectedReport(expectedReport(rawProfile, plan, asOfFromClock(dependencies.now)))) {
    dependencies.log(line);
  }
}

function presentEnv(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Reads the grant issuer's own credentials, not the server application's:
 * IW_TENANT_ID (shared with the scan command) plus IW_BOOTSTRAP_CLIENT_ID and
 * IW_BOOTSTRAP_CLIENT_SECRET, the same two values docs/SETUP.md's
 * --create-bootstrap prints. Every missing variable is named in one message,
 * the same as src/config.ts's loadGraphCredentials, and for the same reason:
 * this is most often run for the first time against a tenant somebody else
 * set up. No rejected value is ever echoed, because one of the three is a
 * client secret.
 */
export function loadBootstrapCredentials(env: NodeJS.ProcessEnv): ClientCredentials {
  const tenantId = env.IW_TENANT_ID;
  const clientId = env.IW_BOOTSTRAP_CLIENT_ID;
  const clientSecret = env.IW_BOOTSTRAP_CLIENT_SECRET;

  const missing = [
    presentEnv(tenantId) ? undefined : "IW_TENANT_ID",
    presentEnv(clientId) ? undefined : "IW_BOOTSTRAP_CLIENT_ID",
    presentEnv(clientSecret) ? undefined : "IW_BOOTSTRAP_CLIENT_SECRET",
  ].filter((name): name is string => name !== undefined);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment ${missing.length === 1 ? "variable" : "variables"}: ${missing.join(", ")}. ` +
        "This script authenticates as the grant issuer, the same application docs/SETUP.md's --create-bootstrap " +
        "creates, because that application already holds Sites.FullControl.All and can write, which keeps the " +
        "server's own application read-only for the request count this script exists to let an operator measure.",
    );
  }

  return { tenantId: tenantId as string, clientId: clientId as string, clientSecret: clientSecret as string };
}

async function main(): Promise<void> {
  await runSeed(process.argv.slice(2), {
    readProfileFile: readProfile,
    createGraphClient: () =>
      createSeedGraphClient({ tokenProvider: clientCredentialsTokenProvider(loadBootstrapCredentials(process.env)) }),
    now: () => new Date(),
    log: (line) => console.log(line),
  });
}

// Guarded so importing this module, which every test does, never runs main().
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
