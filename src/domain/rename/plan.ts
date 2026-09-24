import type { ArtifactFinding, ReconciliationReport } from "../reconcile/index.js";
import {
  duplicateCollision,
  joinPath,
  occupiedPaths,
  parentOf,
  type CollisionReason,
  type PlanCollision,
} from "../plans/collisions.js";

export { RenameSlotContradictionError, type CollisionReason } from "../plans/collisions.js";
export type RenameCollision = PlanCollision;

export interface RenameCandidate {
  /** Library-relative, no leading slash. */
  path: string;
  currentName: string;
  targetName: string;
  /** Library-relative path this file occupies once renamed. Always in the same folder as `path`. */
  targetPath: string;
  client: string;
}

export interface RenamePairing {
  candidates: RenameCandidate[];
  collisions: RenameCollision[];
}

/**
 * A `misnamed` finding whose own fields contradict what `misnamed` means.
 *
 * Thrown rather than skipped. A skip would hide a change in the engine's own
 * contract behind a plan that merely looked short, and `misnamed` versus
 * `misnamed_and_misplaced` is exactly the distinction this function depends on.
 *
 * The throw aborts `pairMisnamedArtifacts` for the whole report, across every
 * client, not only for the one malformed finding. That is deliberate: a report
 * whose findings contradict the engine's own contract is not a report this
 * function can safely build a partial rename plan from, and a plan feeds
 * straight into renaming real files.
 */
export class MisnamedArtifactShapeError extends Error {
  constructor(detail: string) {
    super(
      `A misnamed artifact finding has a shape a rename cannot act on: ${detail}. ` +
        "misnamed means the file is in the correct folder under an incorrect name, so its match must sit in " +
        "the folder its expected path names, under a different name. Refused rather than guessed at, because " +
        "guessing here would move a file rather than rename it.",
    );
    this.name = "MisnamedArtifactShapeError";
  }
}

function candidateFrom(artifact: ArtifactFinding): RenameCandidate | undefined {
  if (artifact.state !== "misnamed") return undefined;
  const matched = artifact.matched;
  // A misnamed finding with no match is not reachable from today's engine.
  // Skipped rather than refused, because unlike the two shapes below it names
  // no contradiction: there is simply nothing to rename.
  if (matched === undefined) return undefined;
  // A file found by the Microsoft Search cross-check lives in another library,
  // and putting it right is a move, which is phase 6b.
  //
  // Unreachable by construction, like the occupied-path branch below: `misnamed`
  // and a `library` cannot occur together. `computeState` in
  // `src/domain/reconcile/match.ts` sets `locationCorrect` to
  // `parsed.file.library === undefined && actualFolder === parsedFolder`, and
  // returns `misnamed` only when `locationCorrect` is true, so a match carrying
  // a library is always `misplaced` or `misnamed_and_misplaced` and never
  // reaches here. Retained anyway, and deliberately rather than by oversight:
  // this is a write path, and a guard whose absence would turn a cross-library
  // finding into a same-library rename is not the guard to remove on the
  // strength of a negative nobody can prove.
  if (matched.library !== undefined) return undefined;

  // expectedPath is the expected FOLDER, not a full file path; expectedName is
  // the expected filename. The engine reports them as two separate fields,
  // rendered independently in expected.ts from the taxonomy and the naming
  // template respectively, so they are composed into a full path here rather
  // than assumed to already arrive composed. An earlier version of this
  // function called parentOf on expectedPath, which is wrong for a value that
  // is already a folder: it stripped one segment too many and rejected every
  // correctly-shaped misnamed artifact as a folder mismatch. Reach for this
  // comment before reaching for parentOf on expectedPath again.
  const folder = parentOf(matched.path);
  if (folder !== artifact.expectedPath) {
    throw new MisnamedArtifactShapeError(
      `"${matched.path}" sits in "${folder}" while its expected folder is "${artifact.expectedPath}"`,
    );
  }
  if (matched.name === artifact.expectedName) {
    throw new MisnamedArtifactShapeError(
      `"${matched.path}" already carries its expected name "${artifact.expectedName}"`,
    );
  }

  return {
    path: matched.path,
    currentName: matched.name,
    targetName: artifact.expectedName,
    targetPath: joinPath(artifact.expectedPath, artifact.expectedName),
    client: artifact.client,
  };
}

function collisionFrom(candidate: RenameCandidate, reason: CollisionReason): RenameCollision {
  return {
    path: candidate.path,
    currentName: candidate.currentName,
    targetName: candidate.targetName,
    client: candidate.client,
    reason,
  };
}

/**
 * Turns a reconciliation report into the from-and-to pairs a rename plan holds,
 * plus the pairs that cannot be attempted and why.
 *
 * Pure, and over the whole report. The caller narrows the result to the clients
 * it was asked about; this function must not, because the collision rules read
 * paths belonging to clients the caller may be excluding.
 *
 * The canonical name for a slot is a pure function of that slot, so two files
 * that would both claim one canonical path necessarily parse to the same
 * slot, and `matchArtifacts` resolves that competition before this function
 * ever sees the report: one candidate wins and becomes the slot's single
 * `ArtifactFinding`, and every other candidate for that slot becomes a
 * `DuplicateFinding`. Two artifacts sharing a target path is therefore not a
 * shape this engine can produce, and a rename plan learns about a losing file
 * from `report.duplicates`, never from a second artifact grouped by target
 * path. An earlier version of this function grouped candidates by target
 * path looking for that grouping, and it could never fire.
 */
export function pairMisnamedArtifacts(report: ReconciliationReport): RenamePairing {
  const occupied = occupiedPaths(report);

  const candidates: RenameCandidate[] = [];
  const collisions: RenameCollision[] = [];

  for (const artifact of report.artifacts) {
    const candidate = candidateFrom(artifact);
    if (candidate === undefined) continue;
    // `!== candidate.path` rather than a bare membership test: the candidate's
    // own current path is in `occupied` by construction, and the target path
    // can never equal it, since a rename with the same name is refused above.
    // The comparison is kept anyway so a future change to that rule cannot
    // turn every candidate into a collision with itself. This branch has no
    // constructed reachable case at all, for either an artifact, a duplicate
    // or an orphan occupying the target: see occupiedPaths's own comment for
    // why each is retained deliberately rather than by oversight. The
    // duplicates pass below is what actually reports a slot already spoken
    // for, today.
    if (occupied.has(candidate.targetPath) && candidate.targetPath !== candidate.path) {
      collisions.push(collisionFrom(candidate, "target_path_already_occupied"));
      continue;
    }
    candidates.push(candidate);
  }

  for (const duplicate of report.duplicates) {
    // The library half of this condition is unreachable by construction, for
    // the same reason `candidateFrom`'s own library guard is: a duplicate's
    // `state` is the loser's state from the same `computeState`, which cannot
    // return `misnamed` for a file carrying a library. It is kept for the same
    // reason too.
    if (duplicate.state !== "misnamed" || duplicate.library !== undefined) continue;
    collisions.push(duplicateCollision(report, duplicate));
  }

  return { candidates, collisions };
}
