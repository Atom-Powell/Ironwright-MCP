import type { ArtifactFinding, DuplicateFinding, ReconciliationReport, Slot } from "../reconcile/index.js";

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

export interface PlanCollision {
  path: string;
  currentName: string;
  targetName: string;
  client: string;
  reason: CollisionReason;
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

export function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * A library-root artifact renders an empty expectedPath (an empty taxonomy),
 * so the join must not always insert a slash: that would produce a
 * leading-slash path this library's paths never carry.
 */
export function joinPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
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
 *
 * Written for a rename plan, and still describes one: a move plan reads this
 * same set for the same reason, since a canonical path is a canonical path
 * whether the file reaching it moves in place or moves folders.
 */
export function occupiedPaths(report: ReconciliationReport): Set<string> {
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
export function duplicateCollision(report: ReconciliationReport, duplicate: DuplicateFinding): PlanCollision {
  const winner = winnerFor(report, duplicate);
  const targetPath = joinPath(winner.expectedPath, winner.expectedName);

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
