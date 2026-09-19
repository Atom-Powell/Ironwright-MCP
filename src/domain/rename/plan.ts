import type { ArtifactFinding, DuplicateFinding, ReconciliationReport, Slot } from "../reconcile/index.js";

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
 * The three collisions this phase can detect and cannot resolve, each naming
 * what the code actually observed rather than what it inferred:
 * `target_path_already_occupied` means a file already sits at the canonical
 * path; `slot_already_satisfied_by_another_file` means the slot's winner is
 * compliant under an accepted alias (a recognizer can declare
 * `verdict: "compliant"` for a name other than the canonical template) but is
 * not physically at the canonical path, so renaming here would only create a
 * second file for a slot already met; `two_files_share_one_target_name` means
 * the winner is not at the canonical path either and would also land there
 * once corrected. None is resolvable without `conflictBehavior`, which the
 * design deliberately holds back, so all three are recorded in the plan as
 * items that will not be attempted rather than being discovered as failures
 * during a write.
 */
export type CollisionReason =
  | "target_path_already_occupied"
  | "slot_already_satisfied_by_another_file"
  | "two_files_share_one_target_name";

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

/**
 * A duplicate whose slot contradicts what `matchArtifacts` guarantees: that
 * every `DuplicateFinding` is produced in the same pass that resolves its
 * slot's winning `ArtifactFinding`, with a matched file already attached.
 *
 * A separate class from `MisnamedArtifactShapeError` rather than a reuse of
 * it, because that error's fixed trailing sentences are about a misnamed
 * finding's own folder and name, and would send an operator reading this
 * message to check the wrong thing for a contradiction that is about slot
 * resolution instead.
 *
 * Thrown for the same reason `MisnamedArtifactShapeError` is: a report that
 * contradicts the engine's own contract is not one this function can safely
 * build a partial rename plan from, and a plan feeds straight into renaming
 * real files.
 */
export class RenameSlotContradictionError extends Error {
  constructor(detail: string) {
    super(
      `A duplicate finding names a slot that contradicts what matchArtifacts guarantees: ${detail}. ` +
        "Every duplicate is produced in the same pass that resolves its slot's winning artifact with a matched " +
        "file attached, so a report missing that winner, or missing its matched file, is not a report this " +
        "function can safely act on.",
    );
    this.name = "RenameSlotContradictionError";
  }
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * Every library-relative path in this report that something already occupies.
 *
 * No construction has been found where a candidate's own target path actually
 * appears in this set, for either of the two things folded into it:
 *
 * - An artifact's or a duplicate's own matched path: any same-library file
 *   sitting at that path carries the canonical name for that path's slot, so
 *   it parses back to that same slot and wins or loses it as an artifact or a
 *   duplicate, which is what makes the duplicates pass below the mechanism
 *   that actually reports a slot already spoken for today.
 * - An orphan's path: a file sitting at a candidate's target path would carry
 *   that slot's canonical name too, so it would parse to that slot and win it
 *   outright as a `compliant` artifact rather than being orphaned. An orphan
 *   requires either a parse failure or a slot nobody owes, and a candidate's
 *   target path is owed by construction, since the candidate's own existence
 *   proves it.
 *
 * Both are retained anyway as a guard against an engine change that would
 * make either path reachable, deliberately rather than by oversight: a
 * negative is not proven by not having found a counterexample, and removing a
 * guard on a write path is the worse risk of the two.
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
    // A library-root artifact renders an empty expectedPath (an empty
    // taxonomy), so the join must not always insert a slash: that would
    // produce a leading-slash path this library's paths never carry.
    targetPath:
      artifact.expectedPath === "" ? artifact.expectedName : `${artifact.expectedPath}/${artifact.expectedName}`,
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
 * A stable key for the (client, deliverable, period) a `Slot` names, shared by
 * `ArtifactFinding` and `DuplicateFinding.slot`. Kept local rather than
 * imported from `match.ts`, which does not export its own version of this:
 * the engine's internal stages, `match.ts` included, stay unreachable from
 * outside `src/domain/reconcile`, by that package's own entry-point rule.
 *
 * `JSON.stringify` of the tuple rather than a delimited string: a client name
 * or deliverable id can contain any printable character a workbook author
 * chose, so a hand-picked delimiter could be forged into a collision (two
 * different slots serializing to one key), where JSON's own escaping of `"`
 * and `\` inside each element cannot. `match.ts`'s own `slotKey` reaches for a
 * literal NUL byte to rule that out instead; this file does not, since a
 * literal NUL in tracked source fails this repo's own hygiene test.
 */
function slotKeyOf(slot: Slot): string {
  return JSON.stringify([slot.client, slot.deliverable, slot.period.year, slot.period.month]);
}

/**
 * The artifact that won the slot a duplicate names.
 *
 * The engine guarantees one exists: `matchArtifacts` only ever produces a
 * `DuplicateFinding` for a slot it also resolved a winner for, since a
 * duplicate is by definition a losing candidate for a slot something else
 * already claimed. A report where a duplicate's slot has no matching artifact,
 * or an artifact with no `matched` file, contradicts that guarantee, so this
 * throws rather than silently dropping the duplicate: a rename plan silently
 * missing a file it should have flagged is the exact failure this module's
 * other refusals exist to prevent.
 */
function winnerFor(report: ReconciliationReport, duplicate: DuplicateFinding): ArtifactFinding & { matched: NonNullable<ArtifactFinding["matched"]> } {
  const key = slotKeyOf(duplicate.slot);
  const winner = report.artifacts.find((artifact) => slotKeyOf(artifact) === key);
  if (winner === undefined) {
    throw new RenameSlotContradictionError(
      `a duplicate at "${duplicate.path}" names a slot (client "${duplicate.slot.client}", deliverable ` +
        `"${duplicate.slot.deliverable}", ${String(duplicate.slot.period.year)}-${String(duplicate.slot.period.month)}) ` +
        "with no artifact in this report to have won it",
    );
  }
  if (winner.matched === undefined) {
    throw new RenameSlotContradictionError(
      `the artifact for the slot a duplicate at "${duplicate.path}" names has no matched file, which the ` +
        "engine cannot produce for a slot that also produced a duplicate",
    );
  }
  return { ...winner, matched: winner.matched };
}

/**
 * A losing candidate for a slot this report's engine already resolved.
 *
 * Only a duplicate whose own state is "misnamed" is relevant here: that is the
 * state meaning "this file sits in the right folder under the wrong name," the
 * same meaning `candidateFrom` acts on for the slot's winner. A duplicate
 * carrying a `library` came from the Microsoft Search cross-check and lives in
 * another library, so it is excluded the same way `candidateFrom` excludes a
 * foreign match: correcting it is a move, not a rename.
 *
 * The reason is chosen from two observations rather than a switch on the
 * winner's state, since a switch would have to enumerate every state that can
 * legally win a slot holding a "misnamed" loser, and miss one the way this
 * function's first version missed "misplaced":
 *
 * - Does the winner's own matched path already equal the target this
 *   duplicate and the winner both converge on? If so, something is physically
 *   there today: `target_path_already_occupied`. This is only true for a
 *   "compliant" winner, since compliant is the only state whose matched path
 *   already equals the canonical target.
 * - Otherwise, is the winner "compliant" anyway? A recognizer can declare
 *   `verdict: "compliant"` for a name other than the canonical template (see
 *   `src/domain/profile/schema.ts`'s recognizer schema), so a winner can
 *   satisfy its slot under an accepted alias while sitting somewhere other
 *   than the canonical path. Nothing occupies that path, but renaming this
 *   duplicate onto it would create a second file for a slot already met:
 *   `slot_already_satisfied_by_another_file`.
 * - Otherwise the winner is itself not at the canonical path yet either
 *   (misnamed or misplaced) and would also land there once corrected, by
 *   rename or by phase 6b's move: `two_files_share_one_target_name`.
 */
function excludedFromDuplicate(report: ReconciliationReport, duplicate: DuplicateFinding): RenameCollision {
  const winner = winnerFor(report, duplicate);
  const targetPath =
    winner.expectedPath === "" ? winner.expectedName : `${winner.expectedPath}/${winner.expectedName}`;

  let reason: CollisionReason;
  if (winner.matched.path === targetPath) {
    reason = "target_path_already_occupied";
  } else if (winner.state === "compliant") {
    reason = "slot_already_satisfied_by_another_file";
  } else {
    reason = "two_files_share_one_target_name";
  }

  return {
    path: duplicate.path,
    currentName: duplicate.name,
    targetName: winner.expectedName,
    client: duplicate.slot.client,
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
    if (duplicate.state !== "misnamed" || duplicate.library !== undefined) continue;
    collisions.push(excludedFromDuplicate(report, duplicate));
  }

  return { candidates, collisions };
}
