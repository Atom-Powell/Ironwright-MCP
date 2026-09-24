import type { ArtifactFinding, ArtifactState, ReconciliationReport } from "../reconcile/index.js";
import { duplicateCollision, joinPath, occupiedPaths, parentOf, type CollisionReason } from "../plans/collisions.js";

export interface MoveCandidate {
  /** Library-relative, no leading slash. */
  path: string;
  currentName: string;
  targetName: string;
  /** Library-relative full path the file occupies once moved, in a different folder from `path`. */
  targetPath: string;
  client: string;
}

export type MoveExclusionKind = CollisionReason | "in_another_library" | "target_folder_absent";

export interface MoveExclusion {
  path: string;
  currentName: string;
  targetName: string;
  client: string;
  reason: MoveExclusionKind;
  /** Present only for `in_another_library`. */
  library?: string;
}

export interface MovePairing {
  candidates: MoveCandidate[];
  exclusions: MoveExclusion[];
}

/**
 * The states a move corrects. `misnamed` alone belongs to the rename plan, so
 * a file lands in exactly one kind of plan.
 */
const MOVE_STATES: ReadonlySet<ArtifactState> = new Set(["misplaced", "misnamed_and_misplaced"]);

export class MisplacedArtifactShapeError extends Error {
  constructor(detail: string) {
    super(
      `A misplaced artifact finding has a shape a move cannot act on: ${detail}. Misplaced means the file is in ` +
        "the wrong folder, so its match must sit outside the folder its expected path names. Refused rather than " +
        "guessed at, because a plan feeds straight into moving real files.",
    );
    this.name = "MisplacedArtifactShapeError";
  }
}

function base(artifact: ArtifactFinding, matched: NonNullable<ArtifactFinding["matched"]>) {
  return { path: matched.path, currentName: matched.name, targetName: artifact.expectedName, client: artifact.client };
}

/**
 * Turns a reconciliation report into the moves a plan holds, plus the files it
 * will not attempt and why. Pure, and over the whole report; the caller
 * narrows to the clients it was asked about, because the occupancy rule reads
 * paths belonging to clients a scoped call is excluding.
 *
 * Only a slot's winning artifact is ever a candidate. Every other file matching
 * that slot is a `DuplicateFinding`, demoted by `matchArtifacts`, and is
 * reported through the same duplicate rules the rename plan uses, never moved.
 *
 * `folderPaths` is the snapshot's own folder list. A target folder absent from
 * it is excluded rather than created, since creating a folder makes its
 * reversal a delete. The library root always exists, so an empty expected
 * path is never excluded on this ground.
 */
export function pairMisplacedArtifacts(report: ReconciliationReport, folderPaths: readonly string[]): MovePairing {
  const occupied = occupiedPaths(report);
  const folders = new Set(folderPaths);
  const candidates: MoveCandidate[] = [];
  const exclusions: MoveExclusion[] = [];

  for (const artifact of report.artifacts) {
    if (!MOVE_STATES.has(artifact.state)) continue;
    const matched = artifact.matched;
    // A misplaced finding with no match is not reachable from today's engine,
    // and names no contradiction: there is simply nothing to move.
    if (matched === undefined) continue;

    if (matched.library !== undefined) {
      // Found by the Microsoft Search cross-check in another library of the
      // same site. Moving between libraries is phase 6b-2, which begins with a
      // live probe of how Graph does it. No Graph request is spent here.
      exclusions.push({ ...base(artifact, matched), reason: "in_another_library", library: matched.library });
      continue;
    }
    if (parentOf(matched.path) === artifact.expectedPath) {
      throw new MisplacedArtifactShapeError(
        `"${matched.path}" already sits in its expected folder "${artifact.expectedPath}"`,
      );
    }
    if (artifact.expectedPath !== "" && !folders.has(artifact.expectedPath)) {
      exclusions.push({ ...base(artifact, matched), reason: "target_folder_absent" });
      continue;
    }

    const targetPath = joinPath(artifact.expectedPath, artifact.expectedName);
    // Expected to be unreachable for the reason occupiedPaths records: a file
    // at the canonical path parses to the same slot and wins it as compliant,
    // leaving this file a duplicate. Kept as a guard rather than removed.
    if (occupied.has(targetPath)) {
      exclusions.push({ ...base(artifact, matched), reason: "target_path_already_occupied" });
      continue;
    }
    candidates.push({ ...base(artifact, matched), targetPath });
  }

  for (const duplicate of report.duplicates) {
    // A duplicate carrying a library lives in another library and is not this
    // plan's to report, the same way the rename pairing skips one.
    if (!MOVE_STATES.has(duplicate.state) || duplicate.library !== undefined) continue;
    exclusions.push(duplicateCollision(report, duplicate));
  }

  return { candidates, exclusions };
}
