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
 * Deliberately does not import anything from src/domain/: that layer is pure
 * and has one enforced entry point (the reconciliation engine), and a fixture
 * generator run against a live tenant is not a legitimate consumer of it. The
 * token substitution below is a small, local reimplementation of just enough
 * of naming.template's placeholder syntax to build file and folder names, not
 * a second copy of the domain's own renderer.
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
import { GraphRequestError } from "../src/graph/errors.js";
import { driveItemPath } from "../src/graph/paths.js";
import { clientCredentialsTokenProvider, type ClientCredentials, type TokenProvider } from "../src/graph/token.js";
import { readProfile } from "../src/scan/cli.js";

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
    identity: { siteUrl: identityRaw.siteUrl, library: identityRaw.library },
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

    for (let month = 1; month <= 12; month += 1) {
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

// resolveDrive (src/graph/drive.ts) issues exactly two GET requests: one to
// resolve the site, one to list its drives. This constant mirrors that count
// rather than measuring it, so if resolveDrive's own request shape ever
// changes, this estimate silently drifts from it; there is no automated link
// between the two.
const RESOLVE_DRIVE_REQUEST_COUNT = 2;

/**
 * Derived from the same tree the execution layer walks, not computed
 * separately: RESOLVE_DRIVE_REQUEST_COUNT aside, this is exactly
 * folderPaths.length POSTs plus filePaths.length PUTs, one request each,
 * because that is what executeSeed below actually issues. It is still an
 * estimate, not a measured cost: it assumes nothing is retried and nothing in
 * the tree already exists. A re-run against a partially built tree costs less,
 * because an existing folder or file is topped up rather than recreated.
 */
export function estimateGraphRequests(tree: SeedTree): number {
  return RESOLVE_DRIVE_REQUEST_COUNT + tree.folderPaths.length + tree.filePaths.length;
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
  return { profilePath, clientCount, year, includeQuarterly, confirm };
}

// ---------------------------------------------------------------------------
// Reporting. Both functions are pure and read only from values their callers
// already computed, so the estimate and the executed counts can never name a
// number that was not actually derived from the tree or the run.
// ---------------------------------------------------------------------------

export function formatDryRunReport(tree: SeedTree, args: SeedArguments): string[] {
  const estimate = estimateGraphRequests(tree);
  return [
    "Dry run: nothing was created. Pass --confirm to create this tree.",
    `Profile: ${args.profilePath}. Clients: ${args.clientCount}. Year: ${args.year}. ` +
      `Quarterly deliverable: ${args.includeQuarterly ? "included" : "excluded"}.`,
    `Folders that would be created: ${tree.folderPaths.length}.`,
    `Files that would be created: ${tree.filePaths.length}.`,
    `Estimated Graph requests to build this tree: ${estimate}. This is an estimate, not a measured cost: it ` +
      "assumes one request per folder, one per file, and the two requests resolveDrive issues to find the site " +
      "and the library, with nothing retried and nothing already there. A re-run against a tree this script " +
      "partly built already will cost less, because an existing folder or file is topped up rather than " +
      "recreated.",
  ];
}

export interface SeedExecutionResult {
  driveId: string;
  foldersProcessed: number;
  filesProcessed: number;
  graphRequests: number;
  elapsedMs: number;
}

export function formatExecutionReport(result: SeedExecutionResult): string[] {
  return [
    `Seed complete against drive ${result.driveId}.`,
    `Folders processed: ${result.foldersProcessed}. Files processed: ${result.filesProcessed}.`,
    `Graph requests issued: ${result.graphRequests}.`,
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
// createGraphClient offers: that client only ever GETs. Folder and file
// creation are POST and PUT, so this is a small, separate client rather than
// an extension of that one, sharing its token provider and its GRAPH_BASE
// constant, and its own request counter so the dry-run estimate and the
// executed count are comparing the same kind of number.
// ---------------------------------------------------------------------------

const PLACEHOLDER_FILE_CONTENT =
  "Synthetic file created by scripts/seed-library.ts to size a document library for a Graph request-count " +
  "comparison. Its content is a placeholder; only its existence and path matter.\n";

// Folders carry no content, so Graph's "replace" conflict behavior on a name
// collision under /children is effectively an upsert for them: it hands back
// the existing folder rather than deleting and recreating it. That is what
// lets a re-run top up a partial tree. "fail" (Graph's own default) would
// 409 on every folder that is already there and stop a re-run cold; "rename"
// would grow a second, third, and fourth copy of every folder on every
// re-run instead of topping anything up. This choice follows Graph's
// documented conflictBehavior semantics and the common "ensure folder
// exists" pattern built on them; it has not been exercised against a live
// tenant in this change, because nothing in this change has run against one.
const FOLDER_CONFLICT_BEHAVIOR = "replace";

// Files get the same choice, for a narrower reason: every file this script
// creates carries the same placeholder content (PLACEHOLDER_FILE_CONTENT
// above), so "replace" overwriting an existing synthetic file with identical
// content loses nothing. A re-run is idempotent for files the same way it is
// for folders, just for a different reason: there is nothing here worth
// keeping over recreating.
const FILE_CONFLICT_BEHAVIOR = "replace";

interface RawGraphResponse {
  status: number;
  body: string;
}

export function createSeedGraphClient(options: {
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
}): SeedGraphClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  let requestCount = 0;

  async function send(path: string, method: string, body?: { text: string; contentType: string }): Promise<RawGraphResponse> {
    const token = await options.tokenProvider.getToken();
    requestCount += 1;
    const response = await fetchImpl(`${GRAPH_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": body.contentType }),
      },
      ...(body === undefined ? {} : { body: body.text }),
    });
    return { status: response.status, body: await response.text() };
  }

  return {
    requests: () => requestCount,

    // This script's one caller of get, resolveDrive, only ever passes a
    // relative path: unlike a scan, this script never follows an
    // @odata.nextLink or a deltaLink, so unlike src/graph/client.ts's own
    // get, there is no absolute-URL branch to carry here.
    async get<T>(path: string): Promise<T> {
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

    async createFolder(driveId, parentPath, name) {
      const path = `${driveItemPath(driveId, parentPath)}/children`;
      const response = await send(path, "POST", {
        text: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": FOLDER_CONFLICT_BEHAVIOR }),
        contentType: "application/json",
      });
      if (response.status < 200 || response.status >= 300) {
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

export async function runSeed(argv: readonly string[], dependencies: SeedDependencies): Promise<void> {
  const args = parseSeedArguments(argv, { now: dependencies.now });
  const rawProfile = await dependencies.readProfileFile(args.profilePath);
  const profile = loadSeedProfile(rawProfile);
  const tree = buildSeedTree(profile, {
    clientCount: args.clientCount,
    year: args.year,
    includeQuarterly: args.includeQuarterly,
  });

  if (!args.confirm) {
    for (const line of formatDryRunReport(tree, args)) dependencies.log(line);
    return;
  }

  const client = dependencies.createGraphClient();
  const result = await executeSeed(client, profile.identity, tree);
  for (const line of formatExecutionReport(result)) dependencies.log(line);
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
