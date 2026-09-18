import { buildTaxonomyMatcher } from "../../domain/structure/conform.js";
import { createFileParser, type RepositoryFile, type RepositorySnapshot } from "../../domain/reconcile/index.js";
import type { Profile } from "../../domain/profile/schema.js";
import {
  MAX_CLIENT_DETAIL,
  type ClientValidation,
  type ValidateStructureOutput,
  type ValidateStructureVerdict,
} from "./output.js";

export { MAX_CLIENT_DETAIL };

/**
 * The client of a library-relative path, taken as the segment at the index the
 * taxonomy puts `{client}` in. A taxonomy with no `{client}` segment has no
 * per-client structure to validate, which `run.ts` refuses before reaching
 * here rather than returning an empty report that reads like a clean bill.
 */
export function clientSegmentIndex(profile: Profile): number {
  return profile.taxonomy.segments.findIndex((segment) => segment.includes("{client}"));
}

/**
 * Ordinary code-unit comparison rather than `localeCompare`, matching every
 * other shaper in this tool layer: the client list is part of a response a
 * test can pin, and `localeCompare` varies with the host's ICU data and
 * default locale.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The path segment at `index`, read positionally rather than by any semantic
 * check, so a path shorter than the taxonomy's client depth (the bare
 * "{year}" folder, say) correctly names no client instead of throwing.
 */
function segmentAt(path: string, index: number): string | undefined {
  const segments = path.split("/");
  return segments.length > index ? segments[index] : undefined;
}

/**
 * Every client with a folder present in the library, read positionally off
 * the taxonomy's own client index. There is no workbook here to consult for
 * who should exist; this is the closed set `run.ts` evaluates when the caller
 * names no `clients` argument, and it is why a client absent from the library
 * cannot be reported `missing` on that path: it never enters this set at all.
 */
function clientsPresent(snapshot: RepositorySnapshot, index: number): string[] {
  const present = new Set<string>();
  for (const path of snapshot.folderPaths) {
    const client = segmentAt(path, index);
    if (client !== undefined && client.length > 0) present.add(client);
  }
  return [...present].sort(compareStrings);
}

export interface ValidateShapeOptions {
  /** Overridden only by tests, so the truncation rule runs on a small fixture. */
  maxClientDetail?: number;
  /** Overridden only by tests, so the client-listing truncation rule runs on a small fixture. */
  maxClients?: number;
}

function namingFailureReason(profile: Profile): string {
  return (
    `This name does not match the profile's filename template "${profile.naming.template}" or any of its ` +
    `${profile.naming.recognizers.length} recognizers.`
  );
}

function evaluateClient(
  profile: Profile,
  snapshot: RepositorySnapshot,
  index: number,
  matches: (relativePath: string) => boolean,
  parse: (file: RepositoryFile) => { recognized: boolean },
  client: string,
  maxDetail: number,
): ClientValidation {
  const folders = snapshot.folderPaths.filter((path) => segmentAt(path, index) === client);

  // No folder for this client anywhere in the scanned library. This is the
  // only route to `missing`, and it is reachable at all only because `run.ts`
  // lets a caller name a client explicitly; the omitted-argument path builds
  // its client list from folders present and can never name one that fails
  // this check.
  if (folders.length === 0) {
    return {
      client,
      verdict: "missing",
      nonConformingFolders: [],
      nonConformingFoldersOmitted: 0,
      nonConformingFiles: [],
      nonConformingFilesOmitted: 0,
    };
  }

  // A file carrying `library` was found by the Microsoft Search cross-check in
  // a different document library of the same site, so it is not part of this
  // library's structure and must not be judged against this taxonomy.
  const files = snapshot.files.filter((file) => file.library === undefined && segmentAt(file.path, index) === client);

  const badFolders = folders.filter((path) => !matches(path)).sort(compareStrings);
  const badFiles = files
    .filter((file) => !parse(file).recognized)
    .map((file) => ({ path: file.path, reason: namingFailureReason(profile) }))
    .sort((a, b) => compareStrings(a.path, b.path));

  const verdict: ValidateStructureVerdict = badFolders.length > 0 || badFiles.length > 0 ? "non_compliant" : "compliant";

  const listedFolders = badFolders.slice(0, maxDetail);
  const listedFiles = badFiles.slice(0, maxDetail);

  return {
    client,
    verdict,
    nonConformingFolders: listedFolders,
    nonConformingFoldersOmitted: badFolders.length - listedFolders.length,
    nonConformingFiles: listedFiles,
    nonConformingFilesOmitted: badFiles.length - listedFiles.length,
  };
}

/**
 * Totals come from every client evaluated and the client listing is cut
 * afterward, in that order. Counting what survived the cut and presenting it
 * as a count of what exists is the substitution this project treats as its
 * worst failure, and it is one line away at every truncation site, including
 * the two nested inside each client's own detail lists.
 *
 * This function checks conformance only. It never asks which folders or files
 * a client owes, because that is a workbook field this tool deliberately
 * never reads; `reconcile_workbook_vs_repository` holds that answer.
 */
export function shapeValidateStructure(
  profileId: string,
  library: string,
  profile: Profile,
  snapshot: RepositorySnapshot,
  requestedClients: readonly string[] | undefined,
  graphRequests: number,
  scanSharedWithConcurrentCall: boolean,
  options: ValidateShapeOptions,
): ValidateStructureOutput {
  const index = clientSegmentIndex(profile);
  const maxDetail = options.maxClientDetail ?? MAX_CLIENT_DETAIL;
  const maxClients = options.maxClients ?? MAX_CLIENT_DETAIL;

  const matches = buildTaxonomyMatcher(profile);
  const parse = createFileParser(profile);

  const scope =
    requestedClients === undefined
      ? clientsPresent(snapshot, index)
      : [...new Set(requestedClients)].sort(compareStrings);

  const evaluated = scope.map((client) => evaluateClient(profile, snapshot, index, matches, parse, client, maxDetail));

  const totals = {
    clients: evaluated.length,
    compliant: evaluated.filter((entry) => entry.verdict === "compliant").length,
    nonCompliant: evaluated.filter((entry) => entry.verdict === "non_compliant").length,
    missing: evaluated.filter((entry) => entry.verdict === "missing").length,
  };

  const listed = evaluated.slice(0, maxClients);

  return {
    profileId,
    library,
    scannedAt: snapshot.scannedAt,
    totals,
    clients: listed,
    listing: {
      returned: listed.length,
      omitted: evaluated.length - listed.length,
      cap: maxClients,
      truncated: listed.length < evaluated.length,
    },
    graphRequests,
    scanSharedWithConcurrentCall,
  };
}
