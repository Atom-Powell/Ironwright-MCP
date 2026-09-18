import type { Profile } from "../profile/schema.js";
import { findEmptyFolders } from "./empty-folders.js";
import { deriveExpected } from "./expected.js";
import { matchArtifacts } from "./match.js";
import { createFileParser } from "./parse.js";
import { windowBounds } from "./period.js";
import type {
  ArtifactFinding,
  ArtifactState,
  ClientSummary,
  DuplicateFinding,
  OrphanFinding,
  Period,
  ReconciliationReport,
  RepositoryFile,
  RepositorySnapshot,
  WorkbookSnapshot,
} from "./types.js";

// Only the entry point and the report's types leave this package. The four
// stages stay internal on purpose: a caller that could reach one of them
// could compute a second, slightly different answer to the same compliance
// question, and being the single authoritative answer is what the engine is
// for.
export type * from "./types.js";

// The one exception, and it exists to serve the same rule rather than to bend
// it. A caller that builds a WorkbookSnapshot has to decide which cells the
// engine can read before it hands them over, and the only alternative to
// exporting that test is for the caller to write its own copy of it. The
// workbook reader did exactly that, and the two copies disagreed in both
// directions. This export answers one question with one implementation; it
// computes no part of the compliance answer.
export { isIsoEffectiveFrom } from "./expected.js";

// A second, narrower exception, on the same footing as the one above:
// `query_repository` answers "which folders are empty" and "which filenames
// do not parse" straight from the stored inventory, with no workbook and
// therefore no `reconcile()` call to make. Both questions are still owed to
// the one implementation `reconcile()` itself calls, exactly as
// `isIsoEffectiveFrom` is: re-deriving either one against the repository
// snapshot inside the tool layer would be a second copy of engine logic, and
// a second copy is exactly the drift risk this file's own comment warns
// about. Neither export lets a caller reach `deriveExpected`, `matchArtifacts`
// or `windowBounds`, so no caller outside this package can compute a
// compliance verdict, only these two workbook-independent facts about the
// repository alone.
export { findEmptyFolders } from "./empty-folders.js";
export { createFileParser } from "./parse.js";

/**
 * Ordinary code-unit comparison rather than `localeCompare`. Sort order here
 * is part of the report's contract, compared against a golden file and diffed
 * by hand between runs, and `localeCompare` varies with the host's ICU data
 * and default locale.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePeriods(a: Period, b: Period): number {
  return a.year !== b.year ? a.year - b.year : a.month - b.month;
}

function compareArtifacts(a: ArtifactFinding, b: ArtifactFinding): number {
  const byClient = compareStrings(a.client, b.client);
  if (byClient !== 0) return byClient;
  const byDeliverable = compareStrings(a.deliverable, b.deliverable);
  if (byDeliverable !== 0) return byDeliverable;
  return comparePeriods(a.period, b.period);
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return compareStrings(a.path, b.path);
}

function emptyCounts(): Record<ArtifactState, number> {
  return { compliant: 0, misnamed: 0, misplaced: 0, misnamed_and_misplaced: 0, missing: 0 };
}

/**
 * Rolls the artifact findings up per client by tallying the findings
 * themselves. Nothing here re-derives what a client owes or re-decides a
 * state: every count is a tally over `artifacts`, so a summary that
 * contradicted the rows beneath it would have to come from a bug in this
 * loop rather than from two computations drifting apart.
 *
 * Clients are seeded from the workbook as well as from the findings, so a
 * client who owes nothing in this window still appears, with all-zero counts.
 * That is the only thing taken from outside the findings, and it cannot
 * create a disagreement: a client with no findings has nothing to disagree
 * with. Omitting them instead would make "owes nothing" and "not in the
 * workbook at all" the same absence, and `validate_structure` groups this
 * report by client, so it would have no honest answer for such a client.
 *
 * `compliant` is true only when every one of the client's artifacts is
 * compliant. It is therefore vacuously true for a client with no artifacts,
 * which the zero counts alongside it make legible.
 *
 * The predicate is written as "the compliant tally accounts for every
 * artifact" rather than as one `=== 0` check per non-compliant state, so the
 * state list has exactly one definition here as it does everywhere else. Four
 * explicit checks would silently count a sixth state as compliant the day one
 * is added; `emptyCounts` is typed over `ArtifactState`, so this form picks
 * the new state up with no edit at all.
 */
function rollUpByClient(workbook: WorkbookSnapshot, artifacts: ArtifactFinding[]): ClientSummary[] {
  const counts = new Map<string, Record<ArtifactState, number>>();

  for (const row of workbook.rows) {
    if (!counts.has(row.client)) counts.set(row.client, emptyCounts());
  }

  for (const artifact of artifacts) {
    let tally = counts.get(artifact.client);
    if (tally === undefined) {
      tally = emptyCounts();
      counts.set(artifact.client, tally);
    }
    tally[artifact.state] += 1;
  }

  return [...counts.entries()]
    .map(([client, tally]) => ({
      client,
      counts: tally,
      compliant: tally.compliant === Object.values(tally).reduce((total, count) => total + count, 0),
    }))
    .sort((a, b) => compareStrings(a.client, b.client));
}

/**
 * Whether `candidate` describes a later state of the file than `held` does,
 * for two entries already known to name the same path.
 *
 * Most recently modified first, exactly as `compareCandidates` in `match.ts`
 * separates two otherwise equal candidates. That is not a coincidence to be
 * tidied away later: "which of two records of this file is current" is one
 * question, and answering it twice, differently, is how two parts of a report
 * start disagreeing. Timestamps are ISO 8601 strings in one consistent format,
 * so a plain string compare orders them without parsing a `Date`, which the
 * domain layer must not do anyway.
 *
 * The remaining keys exist to make the choice total rather than to express a
 * preference. Two entries agreeing on `modified` and `etag` describe the same
 * version of the file, so nothing is at stake between them; picking by a fixed
 * rule rather than by which arrived first is what keeps the whole report
 * invariant under reordering, which is the only property here worth having.
 */
function supersedes(candidate: RepositoryFile, held: RepositoryFile): boolean {
  if (candidate.modified !== held.modified) return candidate.modified > held.modified;
  if (candidate.etag !== held.etag) return candidate.etag > held.etag;
  if (candidate.name !== held.name) return candidate.name > held.name;
  return candidate.size > held.size;
}

/**
 * A library-relative path names one item within one document library, not
 * across all of them: two other libraries on the same site routinely hold a
 * file at the identical relative path, and the Microsoft Search cross-check
 * that qualifies a foreign file with `library` guarantees exactly that
 * collision whenever a seeded deliverable is later filed away elsewhere with
 * its folder structure kept. Keying the collapse on the path alone would
 * treat a local file and an unrelated foreign one as one repeated listing of
 * the same item, let whichever supersedes win the slot, and silently drop the
 * other: a compliant local artifact would lose to a later-modified foreign
 * copy and be reported `misplaced` with an empty etag, or a local orphan
 * would vanish behind a qualified file that is exempt from orphan reporting.
 * That is the failure the orphan exclusion in match.ts exists to prevent,
 * arriving from the side nothing there guards. Keying on `library` and `path`
 * together keeps a local file and a foreign one at the same relative path as
 * two distinct entries, both of which reach matching, while two hits from the
 * *same* other library at the same path still collapse to one, exactly as two
 * local entries do.
 */
function dedupeKey(file: RepositoryFile): string {
  return `${file.library ?? ""}\u0000${file.path}`;
}

/**
 * One entry per (library, path), keeping each key's position from the first
 * time it was listed and its contents from whichever entry describes the
 * file's latest state.
 *
 * A path identifies one item within one document library, so two entries
 * naming one path in one library are one file listed twice rather than two
 * files. Left uncollapsed they became two candidates for one slot: one won
 * the slot and the other was reported as a duplicate at the winner's own
 * path, so the report said the same file was both the compliant artifact and
 * a redundant copy of it, and a move or cleanup plan built on the duplicate
 * list would have targeted the compliant file.
 *
 * A repeat is a transport artifact rather than a repository problem to report,
 * which is why this collapses quietly where a repeated workbook client throws:
 * delta query with a persisted deltaLink is what phase 2 builds its inventory
 * on, and a delta enumeration can emit the same item on more than one page. A
 * hand-maintained workbook's repeats are ambiguous and a machine-generated
 * listing's repeats are noise. `findEmptyFolders` already takes this view of
 * `folderPaths`, so the engine now holds it about both lists rather than one.
 *
 * Nothing here reads the entries' order, and it must not: `RepositorySnapshot`
 * promises no ordering on `files`, and the phase-2c layer that merges a delta
 * page with a Search cross-check leaves whatever order either had behind. The
 * survivor is chosen from what the entries say about themselves, by
 * `supersedes` above, so the same set of entries produces the same report
 * however it is arranged. What the collapse discards is a description of the
 * file that a later description supersedes; the item itself is still in the
 * report, which is the sense in which nothing is lost. The survivor's ETag is
 * what a phase-4 rename or move plan carries as its `If-Match` precondition,
 * so the wrong survivor is a stale precondition against a real client file.
 */
function dedupeFilesByPath(files: readonly RepositoryFile[]): RepositoryFile[] {
  const byKey = new Map<string, RepositoryFile>();
  for (const file of files) {
    const key = dedupeKey(file);
    const held = byKey.get(key);
    // Map.set on an existing key replaces the value and leaves the insertion
    // position alone, which is what keeps the path where it was first listed
    // while its contents come from the entry that supersedes.
    if (held === undefined || supersedes(file, held)) {
      byKey.set(key, file);
    }
  }
  return [...byKey.values()];
}

/**
 * The engine's only entry point: what the workbook says each client is owed,
 * diffed against what the repository actually holds.
 *
 * `asOf` is the reference month the rolling window ends at, and it is a
 * parameter rather than the clock because this function must be pure. A
 * report that read the clock could not be compared against a golden file,
 * could not be reproduced from its own inputs when someone disputes it, and
 * would quietly answer a different question depending on when it ran.
 *
 * Every list in the returned report is sorted, and the report carries no
 * timestamp of its own, so two runs over the same inputs serialize to the
 * same bytes.
 */
export function reconcile(
  profile: Profile,
  workbook: WorkbookSnapshot,
  repository: RepositorySnapshot,
  asOf: Period,
): ReconciliationReport {
  const expected = deriveExpected(profile, workbook, asOf);

  // Prepared once for the whole scan. The canonical pattern and every
  // recognizer regex depend only on the profile, and a repository scan can
  // carry thousands of files, so compiling them per file would repeat that
  // work for an identical result every time.
  const parse = createFileParser(profile);
  const parsed = dedupeFilesByPath(repository.files).map((file) => parse(file));

  const matched = matchArtifacts(profile, expected, parsed);

  const artifacts: ArtifactFinding[] = [...matched.artifacts].sort(compareArtifacts);
  const duplicates: DuplicateFinding[] = [...matched.duplicates].sort(byPath);
  const orphans: OrphanFinding[] = [...matched.orphans].sort(byPath);

  return {
    profileId: profile.profileId,
    window: windowBounds(asOf, profile.window.months),
    provenance: {
      scannedAt: repository.scannedAt,
      searchCrossCheckIncluded: repository.searchCrossCheckIncluded,
      workbookSource: workbook.source,
    },
    artifacts,
    duplicates,
    orphans,
    emptyFolders: findEmptyFolders(repository),
    clients: rollUpByClient(workbook, artifacts),
    rejectedWorkbookRows: workbook.rejectedRows,
  };
}
