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
 * One entry per path, keeping each path's position from the first time it was
 * listed and its contents from whichever entry describes the file's latest
 * state.
 *
 * A path identifies one item in a document library, so two entries naming one
 * path are one file listed twice rather than two files. Left uncollapsed they
 * became two candidates for one slot: one won the slot and the other was
 * reported as a duplicate at the winner's own path, so the report said the
 * same file was both the compliant artifact and a redundant copy of it, and a
 * move or cleanup plan built on the duplicate list would have targeted the
 * compliant file.
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
 * promises no ordering on `files`, and a phase-2 layer that merged a delta page
 * with a Search cross-check would leave whatever order either had behind. The
 * survivor is chosen from what the entries say about themselves, by
 * `supersedes` above, so the same set of entries produces the same report
 * however it is arranged. What the collapse discards is a description of the
 * file that a later description supersedes; the item itself is still in the
 * report, which is the sense in which nothing is lost. The survivor's ETag is
 * what a phase-4 rename or move plan carries as its `If-Match` precondition,
 * so the wrong survivor is a stale precondition against a real client file.
 */
function dedupeFilesByPath(files: readonly RepositoryFile[]): RepositoryFile[] {
  const byPath = new Map<string, RepositoryFile>();
  for (const file of files) {
    const held = byPath.get(file.path);
    // Map.set on an existing key replaces the value and leaves the insertion
    // position alone, which is what keeps the path where it was first listed
    // while its contents come from the entry that supersedes.
    if (held === undefined || supersedes(file, held)) {
      byPath.set(file.path, file);
    }
  }
  return [...byPath.values()];
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
