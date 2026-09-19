import type { ArtifactFinding, ReconciliationReport } from "../reconcile/index.js";

export interface RenameCandidate {
  /** Library-relative, no leading slash. */
  path: string;
  currentName: string;
  targetName: string;
  /** Library-relative path this file occupies once renamed. Always in the same folder as `path`. */
  targetPath: string;
  client: string;
}

/**
 * The two collisions this phase can detect and cannot resolve. Both need
 * `conflictBehavior`, which the design deliberately holds back, so both are
 * recorded in the plan as items that will not be attempted rather than being
 * discovered as failures during a write.
 */
export type CollisionReason = "target_path_already_occupied" | "two_files_share_one_target_name";

export interface RenameCollision {
  path: string;
  currentName: string;
  targetName: string;
  client: string;
  reason: CollisionReason;
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

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * Every library-relative path in this report that something already occupies.
 *
 * Built from the whole report rather than from the candidates, and always over
 * every client regardless of any scope the caller will apply afterwards: a plan
 * narrowed to one client must still refuse to rename a file onto a path another
 * client's file holds. Narrowing first is the same mistake `shapeReport` warns
 * against for orphans, in a place where the cost is a lost file rather than a
 * wrong count.
 *
 * Paths qualified by a `library` are excluded. Such a path is relative to a
 * library this plan does not write to, so it cannot collide with anything here,
 * and counting it would refuse a rename that is safe.
 */
function occupiedPaths(report: ReconciliationReport): Set<string> {
  const occupied = new Set<string>();

  for (const artifact of report.artifacts) {
    if (artifact.matched !== undefined && artifact.matched.library === undefined) {
      occupied.add(artifact.matched.path);
    }
  }
  for (const duplicate of report.duplicates) {
    if (duplicate.library === undefined) occupied.add(duplicate.path);
  }
  for (const orphan of report.orphans) {
    occupied.add(orphan.path);
  }

  return occupied;
}

function candidateFrom(artifact: ArtifactFinding): RenameCandidate | undefined {
  if (artifact.state !== "misnamed") return undefined;
  const matched = artifact.matched;
  // A misnamed finding with no match is not reachable from today's engine.
  // Skipped rather than refused, because unlike the two shapes below it names
  // no contradiction: there is simply nothing to rename.
  if (matched === undefined) return undefined;
  // A file found by the Microsoft Search cross-check lives in another library.
  // Putting it right is a move, which is phase 6b.
  if (matched.library !== undefined) return undefined;

  const folder = parentOf(matched.path);
  const expectedFolder = parentOf(artifact.expectedPath);
  if (folder !== expectedFolder) {
    throw new MisnamedArtifactShapeError(
      `"${matched.path}" sits in "${folder}" while its expected path "${artifact.expectedPath}" is in "${expectedFolder}"`,
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
    // Derived from the match's own folder rather than taken from
    // expectedPath, so the two are proven equal by the guard above rather
    // than assumed equal here.
    targetPath: folder === "" ? artifact.expectedName : `${folder}/${artifact.expectedName}`,
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
 */
export function pairMisnamedArtifacts(report: ReconciliationReport): RenamePairing {
  const occupied = occupiedPaths(report);

  const paired: RenameCandidate[] = [];
  for (const artifact of report.artifacts) {
    const candidate = candidateFrom(artifact);
    if (candidate !== undefined) paired.push(candidate);
  }

  const byTarget = new Map<string, RenameCandidate[]>();
  for (const candidate of paired) {
    const group = byTarget.get(candidate.targetPath);
    if (group === undefined) byTarget.set(candidate.targetPath, [candidate]);
    else group.push(candidate);
  }

  const candidates: RenameCandidate[] = [];
  const collisions: RenameCollision[] = [];

  for (const candidate of paired) {
    const sharing = byTarget.get(candidate.targetPath) ?? [];
    if (sharing.length > 1) {
      collisions.push(collisionFrom(candidate, "two_files_share_one_target_name"));
      continue;
    }
    // `!== candidate.path` rather than a bare membership test: the candidate's
    // own current path is in `occupied` by construction, and the target path
    // can never equal it, since a rename with the same name is refused above.
    // The comparison is kept anyway so a future change to that rule cannot
    // turn every candidate into a collision with itself.
    if (occupied.has(candidate.targetPath) && candidate.targetPath !== candidate.path) {
      collisions.push(collisionFrom(candidate, "target_path_already_occupied"));
      continue;
    }
    candidates.push(candidate);
  }

  return { candidates, collisions };
}
