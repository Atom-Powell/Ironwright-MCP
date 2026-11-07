import { z } from "zod";
import type { CustomExclusionReason, CustomStep } from "../domain/custom/resolve.js";

export interface InventoryRecord {
  itemId: string;
  /** Library-relative, no leading slash. */
  path: string;
  name: string;
  isFolder: boolean;
  size: number;
  modified: string;
  /** Captured now because a later rename or move plan needs it as an If-Match precondition. */
  etag: string;
}

export type InventoryChange =
  | { kind: "upsert"; record: InventoryRecord }
  | { kind: "delete"; itemId: string };

export interface ApplyResult {
  changesApplied: number;
  /**
   * Write operations issued to the backing store: one per run of consecutive
   * upserts (chunked at the transaction size limit), and one per delete. Changes
   * are applied in arrival order, so a delete interrupts and closes out
   * whatever run of upserts is open, even short of the chunk limit; that is why
   * "chunk of upserts" means a run between deletes, not a chunking pass over
   * every upsert in the change list. Deletes are not batched with upserts
   * because the Table implementation cannot batch them: a transaction
   * containing a delete of a row that is not there fails as a whole, and this
   * store must tolerate that case, since the first incremental scan after a
   * resync sees deletes for items it never recorded. The in-memory
   * implementation counts the same way so the number the scan prints means one
   * thing regardless of which store produced it.
   */
  batches: number;
}

export interface ScannedDrive {
  driveId: string;
  lastScanAt: string;
}

export interface JournalEntry {
  /** The string `new Date().toISOString()` produces (UTC, three millisecond digits), because entries are ordered by string comparison. */
  at: string;
  correlationId: string;
  /** The module's stage name, e.g. "ID", "DOSSIER". */
  stage: string;
  operation: "list_item_created" | "list_item_updated" | "folder_created" | "file_created" | "file_overwritten";
  /** List name plus item id, or library-relative path, as the server computed it. */
  target: string;
  etagBefore?: string;
  etagAfter?: string;
  /** sha256 hex of what was written, for files. */
  contentHash?: string;
  /** The SharePoint version that held the prior content, on an overwrite. */
  versionId?: string;
}

/**
 * The shape `listJournal` insists on for every stored row. JSON that parses but
 * has the wrong shape is as unreadable as JSON that does not parse, and a cast
 * would hand it to callers as a valid entry.
 */
export const JournalEntrySchema = z.object({
  at: z.string(),
  correlationId: z.string(),
  stage: z.string(),
  operation: z.enum(["list_item_created", "list_item_updated", "folder_created", "file_created", "file_overwritten"]),
  target: z.string(),
  etagBefore: z.string().optional(),
  etagAfter: z.string().optional(),
  contentHash: z.string().optional(),
  versionId: z.string().optional(),
});

export interface StateStore {
  getDeltaLink(profileId: string, driveId: string): Promise<string | undefined>;
  setDeltaLink(profileId: string, driveId: string, deltaLink: string, lastScanAt: string): Promise<void>;
  /**
   * When this drive was last scanned to completion, or undefined if it never
   * has been. Separate from getDeltaLink because a caller resuming a scan needs
   * the link and an operator reading a report needs the timestamp, and widening
   * the link getter's return would change every call site for the sake of the
   * rarer one.
   */
  getLastScanAt(profileId: string, driveId: string): Promise<string | undefined>;
  clearInventory(profileId: string, driveId: string): Promise<void>;
  applyInventoryChanges(profileId: string, driveId: string, changes: InventoryChange[]): Promise<ApplyResult>;
  listInventory(profileId: string, driveId: string): Promise<InventoryRecord[]>;
  /**
   * Every drive this profile has scanned to completion, with the time of that
   * scan. Reads the partition `setDeltaLink` already writes, so nothing new is
   * persisted. It exists so a tool serving an answer from the stored inventory
   * can find the drive without calling `resolveDrive`, which would be a Graph
   * request and would cost `query_repository` the zero-request promise its own
   * description makes.
   */
  getScannedDrives(profileId: string): Promise<ScannedDrive[]>;

  /**
   * Writes a plan, replacing any plan already stored under that id. Replacing
   * rather than appending is what lets an executor correct a reversal entry's
   * etag as each rename lands: a rename changes the item's etag, so a reversal
   * log written before the first write and never touched again would have every
   * one of its items refused on its own stale precondition, and a rollback
   * would report a clean run having changed nothing.
   */
  savePlan(profileId: string, plan: StoredPlan): Promise<void>;
  getPlan(profileId: string, planId: string): Promise<StoredPlan | undefined>;

  /**
   * Appends one entry to an assessment's journal. Append, never replace: the
   * journal is the audit record of what a lifecycle tool did, and the
   * reversal record for what is reversible, so an entry once written is
   * never edited. Ordering is by `at` then `correlationId`, which is why
   * both are required.
   */
  appendJournalEntry(profileId: string, assessmentId: string, entry: JournalEntry): Promise<void>;
  /** Ascending by `at`, then `correlationId`, whatever order the entries were appended in. */
  listJournal(profileId: string, assessmentId: string): Promise<JournalEntry[]>;
}

/**
 * Why a misnamed file the engine found is recorded in the plan as something
 * that will not be attempted.
 *
 * The first three describe what a duplicate finding's slot resolution told
 * this code, not what it inferred: `target_path_already_occupied` means a
 * file already sits at the canonical path; `slot_already_satisfied_by_another_file`
 * means the slot's winner is compliant, satisfying it under an accepted
 * alias, but that winner is not physically at the canonical path, so nothing
 * occupies it and renaming here would only create a second file for a slot
 * already met; `two_files_share_one_target_name` means the winner is itself
 * not yet at the canonical path either (misnamed or misplaced) and would
 * also land there once corrected, so this file and the winner are two files
 * contending for one name. None of the three is resolvable without
 * `conflictBehavior`, which this phase deliberately does not build.
 * `slot_won_by_file_in_another_library` means this file lost its slot to a
 * file found in another library of the same site, and nothing occupies the
 * canonical path in this library. The last two come from the plan-time etag
 * fetch: a file with no etag has no usable
 * precondition, and silently sending no `If-Match` for it would turn the item
 * carrying the least information into the only unguarded write in the batch.
 */
export type PlanExclusionReason =
  | "target_path_already_occupied"
  | "slot_already_satisfied_by_another_file"
  | "two_files_share_one_target_name"
  | "slot_won_by_file_in_another_library"
  | "no_etag_available"
  | "file_not_found_at_plan_time";

/**
 * Reasons only a move plan records. `in_another_library` means the Microsoft
 * Search cross-check found the file in a different document library of the
 * same site, and this server does not yet move files between libraries.
 * `target_folder_absent` means the folder the file belongs in does not exist,
 * and this slice creates no folders, since a folder's reversal is a delete.
 */
export type MoveOnlyExclusionReason = "in_another_library" | "target_folder_absent";

export type MoveExclusionReason = PlanExclusionReason | MoveOnlyExclusionReason;

/**
 * The full union a stored plan's `excluded` field can carry, spanning what a
 * rename or move plan records and what a custom plan records. A stored plan
 * holds one entity type regardless of kind, so its excluded items are typed
 * over the union; each tool narrows to its own kind's subset when it reads one
 * back, the way `renameExclusionsOf` and `moveExclusionsOf` already do.
 */
export type AnyExclusionReason = MoveExclusionReason | CustomExclusionReason;

export type PlanKind = "rename" | "move" | "custom";

export interface RenamePlanItem {
  /** Library-relative, no leading slash. The file as it stands now. */
  path: string;
  currentName: string;
  targetName: string;
  /** Library-relative path this item occupies once applied. The same folder as `path` for a rename, another folder for a move. */
  targetPath: string;
  /**
   * The `If-Match` precondition, and where it came from depends on which kind
   * of plan holds it. Both kinds are this same entity, so a reader of a stored
   * plan needs both answers here.
   *
   * On a forward plan it was fetched from Graph when the plan was generated,
   * rather than read out of the inventory. The inventory is a delta snapshot
   * that may be hours old, so a precondition built on it would refuse any
   * change since the last scan rather than any change since the plan a human
   * actually read.
   *
   * On a reversal plan it starts as the forward item's PRE-rename etag, which
   * is stale for the inverse operation by construction, and the executor
   * replaces it with the etag the rename's own PATCH response carried as each
   * rename lands. An entry that never gets replaced keeps the stale value and
   * is refused on replay, which is the safe direction. `reversalItemsFor` in
   * `src/tools/plans/apply.ts` carries the full reasoning.
   */
  etag: string;
  /**
   * Required, not optional: a rename or move plan's item always names the
   * client the workbook mapped it to. A custom plan has no workbook mapping
   * and no client, so its items write the empty string here rather than
   * leaving the field out.
   */
  client: string;
  /** Which step of a custom plan produced this item. Absent on a rename or move plan. */
  step?: number;
}

/**
 * Generic over its reason so each tool's output can state the narrower set its
 * own plans carry, while a stored plan holds the full union.
 */
export interface ExcludedPlanItem<R extends string = AnyExclusionReason> {
  path: string;
  currentName: string;
  targetName: string;
  /** Required for the same reason RenamePlanItem's is: a custom plan writes "" here, having no client. */
  client: string;
  reason: R;
  /** The library the file was found in, present only for `in_another_library`. */
  library?: string;
  /** Which steps of a custom plan matched this file. Absent on a rename or move plan. */
  steps?: number[];
}

/**
 * A persisted plan. There is one entity type rather than two, because a
 * reversal log is a plan by the Decision Record's own words. Storing it as a
 * separate shape would let the reversal path drift from the forward path, and
 * rollback running through the same code is the whole point of the rule.
 */
export interface StoredPlan {
  planId: string;
  profileId: string;
  kind: PlanKind;
  driveId: string;
  createdAt: string;
  items: RenamePlanItem[];
  excluded: ExcludedPlanItem[];
  /** The plan id this one reverses. Absent on a forward plan. */
  reverses?: string;
  /** The operator-written steps a custom plan resolved from. Absent on a rename or move plan. */
  steps?: CustomStep[];
}

/**
 * Azure Table caps a single String property at 32768 characters, and the
 * check in `table.ts` compares this constant against the combined length of
 * the separate String properties a stored plan writes as JSON: `items`,
 * `excluded`, and, on a custom plan, `steps`. That sum is not the quantity the
 * service actually limits, but checking it this way can only over-refuse
 * relative to the real per-property cap, never under-refuse: whichever of
 * those strings is largest is bounded by the same total, so none of them can
 * pass this check while itself exceeding 32768. The margin below the true
 * limit covers the rest of the entity's other properties, and the refusal is
 * raised in this codebase rather than left to the service, whose own error
 * names neither the plan nor a remedy.
 */
export const MAX_PLAN_JSON_CHARS = 32000;

/**
 * The one measurement both store implementations compare against
 * `MAX_PLAN_JSON_CHARS`, and the one `generate_custom_plan` estimates with
 * before it spends any lookup, so the estimate cannot drift from the check it
 * predicts. `steps` is stringified only when present, so a rename or move
 * plan, which carries none, contributes nothing for it.
 */
export function storedPlanJsonChars(plan: Pick<StoredPlan, "items" | "excluded" | "steps">): number {
  const steps = plan.steps === undefined ? 0 : JSON.stringify(plan.steps).length;
  return JSON.stringify(plan.items).length + JSON.stringify(plan.excluded).length + steps;
}

export class PlanTooLargeError extends Error {
  readonly planId: string;
  readonly chars: number;

  constructor(planId: string, chars: number) {
    super(
      `Plan "${planId}" serializes to ${String(chars)} characters, more than the ` +
        `${String(MAX_PLAN_JSON_CHARS)} a single stored plan holds. Generate a narrower plan with fewer items: ` +
        "fewer clients for a rename or move plan, narrower steps for a custom plan. Refused rather than truncated, " +
        "because a plan missing items a reviewer saw is worse than no plan at all.",
    );
    this.name = "PlanTooLargeError";
    this.planId = planId;
    this.chars = chars;
  }
}

/**
 * Raised by `listJournal` when a stored journal row cannot be read. Names the
 * partition and row key, never the content, which may carry customer paths.
 * A journal is an audit record, so a row that cannot be read throws rather
 * than being skipped, which would present an incomplete record as complete.
 */
export class MalformedJournalEntityError extends Error {
  readonly partitionKey: string;
  readonly rowKey: string;

  constructor(partitionKey: string, rowKey: string, detail: string) {
    super(
      `The stored journal row "${partitionKey}" / "${rowKey}" cannot be read: its entry ${detail}. ` +
        "Refused rather than skipped, because a journal missing a row reads as a complete record.",
    );
    this.name = "MalformedJournalEntityError";
    this.partitionKey = partitionKey;
    this.rowKey = rowKey;
  }
}

/**
 * Raised by `getPlan` when a row exists but cannot be reconstructed
 * faithfully. Unlike `getScannedDrives`, which skips a row an older build
 * wrote without every current field, a plan is what a rename or a rollback
 * acts on: a listing that tolerates a partial row loses one answer, but a
 * plan that tolerates one loses files, which is why this throws instead of
 * substituting a default and returning what looks like a valid plan with
 * nothing to do.
 */
export class MalformedPlanEntityError extends Error {
  readonly planId: string;
  readonly field: string;

  constructor(planId: string, field: string, detail: string) {
    super(
      `The stored plan "${planId}" cannot be read: its ${field} ${detail}. Refused rather than ` +
        "reconstructed, because a plan is what a rename or a rollback acts on, and a plan rebuilt " +
        "around a missing field reads as a valid plan with nothing to do.",
    );
    this.name = "MalformedPlanEntityError";
    this.planId = planId;
    this.field = field;
  }
}
