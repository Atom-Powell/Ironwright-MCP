import { z } from "zod";
import type { MoveExclusionReason } from "../../store/types.js";
import { PLAN_EXCLUSION_REASONS } from "../rename/output.js";

export { MAX_PLAN_ITEMS, MAX_PLAN_ITEMS_LISTED } from "../plans/limits.js";

export const MOVE_EXCLUSION_REASONS = [
  ...PLAN_EXCLUSION_REASONS,
  "in_another_library",
  "target_folder_absent",
] as const satisfies readonly MoveExclusionReason[];

// Exhaustive, for the reason rename/output.ts gives for its own list.
type AssertNever<T extends never> = T;
type _MoveExclusionReasonsExhaustive = AssertNever<Exclude<MoveExclusionReason, (typeof MOVE_EXCLUSION_REASONS)[number]>>;

export interface MoveExcludedItem {
  path: string;
  currentName: string;
  targetName: string;
  client: string;
  reason: MoveExclusionReason;
  library?: string;
}

export interface GenerateMovePlanOutput {
  planId: string;
  profileId: string;
  library: string;
  driveId: string;
  createdAt: string;
  scannedAt: string;
  items: Array<{ path: string; currentName: string; targetName: string; targetPath: string; client: string }>;
  itemCount: number;
  itemsOmitted: number;
  excluded: MoveExcludedItem[];
  excludedCount: number;
  excludedOmitted: number;
  workbookReadGraphRequestsByThisCall: number;
  etagLookupsIssued: number;
  scanGraphRequestsByThisCall: number;
  scanSharedWithConcurrentCall: boolean;
}

const EXCLUDED_ITEM = z.object({
  path: z.string(),
  currentName: z.string(),
  targetName: z.string(),
  client: z.string(),
  reason: z.enum(MOVE_EXCLUSION_REASONS),
  library: z.string().optional(),
});

export const GENERATE_MOVE_PLAN_OUTPUT_SCHEMA = {
  planId: z.string().describe("The id execute_move_plan consumes to apply this plan."),
  profileId: z.string().describe("The profile this plan was generated against."),
  library: z.string().describe("The document library named by the profile's identity."),
  driveId: z.string().describe("The drive every item in this plan is addressed within."),
  createdAt: z.string().describe("When this plan was generated."),
  scannedAt: z
    .string()
    .describe("When the underlying repository scan was taken. The plan's pairs reflect the library as of that scan."),
  items: z
    .array(
      z.object({
        path: z.string(),
        currentName: z.string(),
        targetName: z.string(),
        targetPath: z.string(),
        client: z.string(),
      }),
    )
    .describe(
      "What will be moved, sorted by path. targetPath is the full path the file occupies afterward; when " +
        "targetName differs from currentName the same write also renames it. May be a prefix of the stored plan; " +
        "see itemCount and itemsOmitted.",
    ),
  itemCount: z.number().int().describe("Items in the stored plan. Computed before the listing above is cut."),
  itemsOmitted: z.number().int().describe("Items the listing above left out. Zero when the listing is complete."),
  excluded: z
    .array(EXCLUDED_ITEM)
    .describe(
      "Misplaced files this plan will NOT attempt, each with why. in_another_library names the library the file " +
        "was found in, which this server does not yet move files out of. target_folder_absent means the folder " +
        "the file belongs in does not exist, and this server creates no folders. The three collision reasons mean " +
        "the canonical path is already spoken for. no_etag_available and file_not_found_at_plan_time mean the " +
        "file had no usable precondition when the plan was generated.",
    ),
  excludedCount: z.number().int().describe("Excluded items in the stored plan. Computed before the listing above is cut."),
  excludedOmitted: z.number().int().describe("Excluded items the listing above left out."),
  workbookReadGraphRequestsByThisCall: z
    .number()
    .int()
    .describe("What reading the workbook cost this call. A download costs two requests, not one."),
  etagLookupsIssued: z
    .number()
    .int()
    .describe(
      "Lookups issued, one per candidate whose etag this call fetched, counted rather than measured against the " +
        "shared Graph request counter, which a concurrent call also moves and which a retried lookup can move more " +
        "than once. Not a Graph request count: a throttled lookup retries and spends more than one request while " +
        "still counting as one lookup here.",
    ),
  scanGraphRequestsByThisCall: z
    .number()
    .int()
    .describe("What the repository scan cost this call. Zero when this call joined a scan another call had started."),
  scanSharedWithConcurrentCall: z
    .boolean()
    .describe("True when this call awaited a scan another call had already started, which is the only reason the scan cost can be zero."),
} satisfies z.ZodRawShape;

// Exported for Task 7's execute_move_plan output schema to reuse.
export const MOVE_EXCLUDED_ITEM_SCHEMA = EXCLUDED_ITEM;

export const MOVE_ITEM_OUTCOMES = ["moved", "would_move", "precondition_refused", "not_found", "failed"] as const;
export type MoveItemOutcome = (typeof MOVE_ITEM_OUTCOMES)[number];

export interface MoveItemResult {
  path: string;
  currentName: string;
  targetName: string;
  targetPath: string;
  client: string;
  outcome: MoveItemOutcome;
}

export interface ExecuteMovePlanOutput {
  planId: string;
  profileId: string;
  /**
   * The drive this run addressed, taken from the plan. The profile's library
   * name is deliberately NOT reported here, unlike on a generated plan: this
   * call writes to the plan's own drive, so a profile whose `identity.library`
   * changed after the plan was generated would make that name describe a
   * different library from the one written to, and under `Sites.Selected` both
   * are writable.
   */
  driveId: string;
  /** The plan id this run undoes. Absent unless the plan executed is itself a reversal. */
  reverses?: string;
  dryRun: boolean;
  results: MoveItemResult[];
  resultCount: number;
  resultsOmitted: number;
  counts: { moved: number; wouldMove: number; preconditionRefused: number; notFound: number; failed: number };
  excluded: MoveExcludedItem[];
  excludedCount: number;
  excludedOmitted: number;
  /** Absent on a dry run, which changes nothing and therefore writes no reversal log. */
  reversalPlanId?: string;
  reversalEntriesNotRefreshed: number;
  graphOperationsIssued: number;
}

export const EXECUTE_MOVE_PLAN_OUTPUT_SCHEMA = {
  planId: z.string().describe("The plan this call applied or previewed."),
  profileId: z.string().describe("The profile the plan belongs to."),
  driveId: z
    .string()
    .describe(
      "The drive every move in this run was addressed within, taken from the plan itself rather than from the " +
        "profile. The profile's library name is not reported here on purpose: an older plan executed after the " +
        "profile's library changed still writes to the drive the plan names, and reporting the new library's name " +
        "beside those writes would name a library this call did not touch.",
    ),
  reverses: z
    .string()
    .optional()
    .describe(
      "The plan id this run undoes, present only when the plan executed is itself a reversal log. A rollback is a " +
        "plan like any other, so without this field its report is shape-identical to a forward run's.",
    ),
  dryRun: z
    .boolean()
    .describe(
      "True when nothing was changed. A dry run contacts Graph not at all, so it cannot tell whether the item at " +
        "a path is still the one the plan recorded: outcomes of precondition_refused and not_found can only " +
        "appear in a confirmed run.",
    ),
  results: z
    .array(
      z.object({
        path: z.string(),
        currentName: z.string(),
        targetName: z.string(),
        targetPath: z.string(),
        client: z.string(),
        outcome: z.enum(MOVE_ITEM_OUTCOMES),
      }),
    )
    .describe(
      "One entry per item in the plan, sorted by path. moved means the file was moved; would_move means a " +
        "dry run reached it and stopped; precondition_refused means Graph refused the write because the item at " +
        "that path is not the one the plan recorded. Graph checks If-Match before existence, so this single " +
        "outcome covers both a file that changed and a file that is no longer there, and this server deliberately " +
        "does not pay the cost of a GET per refusal to tell the two apart. not_found is expected to stay zero: " +
        "this executor always sends If-Match, and a stale precondition against an absent path answers 412 before " +
        "Graph ever reports the path missing, so a 404 cannot reach this outcome today. It is kept as a label " +
        "rather than removed, since a branch on a write path is not removed on the strength of a negative nobody " +
        "can prove. failed means Graph answered with something other than those, and the server log carries it. " +
        "A target folder deleted after the plan was generated is reported as failed, because Graph answers it " +
        "with a generic 400 that names no cause. May be a prefix; see resultCount.",
    ),
  resultCount: z.number().int().describe("Items in the plan. Computed before the listing above is cut."),
  resultsOmitted: z.number().int().describe("Items the listing above left out."),
  counts: z
    .object({
      moved: z.number().int(),
      wouldMove: z.number().int(),
      preconditionRefused: z
        .number()
        .int()
        .describe(
          "Items Graph refused because the item at that path was not the one the plan recorded. Covers both a " +
            "changed file and an absent one: Graph checks If-Match before existence, and telling the two apart " +
            "would cost a GET per refusal this project deliberately does not pay.",
        ),
      notFound: z
        .number()
        .int()
        .describe(
          "Expected to be zero. This executor always sends If-Match, and Graph evaluates that precondition before " +
            "existence, so a 404 cannot reach this executor today. The outcome is kept rather than removed, since " +
            "a branch on a write path is not removed on the strength of a negative nobody can prove.",
        ),
      failed: z.number().int(),
    })
    .describe("Computed over every item in the plan, before the listing above is cut. Never abridged."),
  excluded: z
    .array(MOVE_EXCLUDED_ITEM_SCHEMA)
    .describe(
      "Items the plan recorded at generation time as ones it would not attempt, carried here so an operator " +
        "reading this report does not have to hold the plan open beside it to learn why a file they expected to " +
        "be moved was not.",
    ),
  excludedCount: z.number().int().describe("Excluded items in the plan. Computed before the listing above is cut."),
  excludedOmitted: z.number().int().describe("Excluded items the listing above left out."),
  reversalPlanId: z
    .string()
    .optional()
    .describe(
      "The plan id that undoes this run, written before the first move. Absent on a dry run, which changes " +
        "nothing to reverse. Apply it with this same tool to roll back.",
    ),
  reversalEntriesNotRefreshed: z
    .number()
    .int()
    .describe(
      "Moves that succeeded but whose reversal entry could not be given the file's new ETag. Replaying the " +
        "reversal will refuse those items on their own precondition rather than undo them, so they need a fresh " +
        "plan. Zero is the normal result.",
    ),
  graphOperationsIssued: z
    .number()
    .int()
    .describe(
      "Graph operations this call issued: one per move attempt, plus one for each follow-up ETag read a missing " +
        "PATCH response forced. Counted directly rather than measured against the shared Graph request counter, " +
        "which a concurrent call also moves and which a retried operation can move more than once. Not a request " +
        "count: a throttled PATCH retries and spends more than one request while counting as one operation here. " +
        "Zero on a dry run, which contacts Graph not at all.",
    ),
} satisfies z.ZodRawShape;
