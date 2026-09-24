import { z } from "zod";
import type { CustomExclusionReason } from "../../domain/custom/resolve.js";
import type { EtagExclusionReason } from "../plans/etags.js";

export { MAX_PLAN_ITEMS_LISTED } from "../plans/limits.js";

export type CustomPlanExclusionReason = CustomExclusionReason | EtagExclusionReason;

export const CUSTOM_EXCLUSION_REASONS = [
  "matched_by_multiple_steps",
  "no_change",
  "extension_would_change",
  "invalid_target_name",
  "target_path_already_occupied",
  "two_items_share_one_target",
  "no_etag_available",
  "file_not_found_at_plan_time",
] as const satisfies readonly CustomPlanExclusionReason[];

// Exhaustive, for the reason rename/output.ts gives for its own list: a reason
// the resolver or the etag fetch can produce but this list omits would fail the
// output schema at the wire instead of here.
type AssertNever<T extends never> = T;
type _CustomExclusionReasonsExhaustive = AssertNever<
  Exclude<CustomPlanExclusionReason, (typeof CUSTOM_EXCLUSION_REASONS)[number]>
>;

export interface CustomPlanItemOutput {
  path: string;
  currentName: string;
  targetName: string;
  targetPath: string;
  step: number;
}

export interface CustomExcludedItem {
  path: string;
  currentName: string;
  targetName: string;
  reason: CustomPlanExclusionReason;
  steps: number[];
}

const CUSTOM_EXCLUDED_ITEM = z.object({
  path: z.string(),
  currentName: z.string(),
  targetName: z.string(),
  reason: z.enum(CUSTOM_EXCLUSION_REASONS),
  steps: z.array(z.number().int()),
});

// Exported so both GENERATE_CUSTOM_PLAN_OUTPUT_SCHEMA and
// EXECUTE_CUSTOM_PLAN_OUTPUT_SCHEMA declare this shape from this one
// constant, rather than each carrying its own copy that could drift apart.
export const CUSTOM_EXCLUDED_ITEM_SCHEMA = CUSTOM_EXCLUDED_ITEM;

export interface GenerateCustomPlanOutput {
  planId: string;
  profileId: string;
  library: string;
  driveId: string;
  createdAt: string;
  scannedAt: string;
  perStep: number[];
  items: CustomPlanItemOutput[];
  itemCount: number;
  itemsOmitted: number;
  excluded: CustomExcludedItem[];
  excludedCount: number;
  excludedOmitted: number;
  etagLookupsIssued: number;
  scanGraphRequestsByThisCall: number;
  scanSharedWithConcurrentCall: boolean;
}

export const GENERATE_CUSTOM_PLAN_OUTPUT_SCHEMA = {
  planId: z.string().describe("The id execute_custom_plan consumes to apply this plan."),
  profileId: z.string().describe("The profile this plan was generated against."),
  library: z.string().describe("The document library named by the profile's identity."),
  driveId: z.string().describe("The drive every item in this plan is addressed within."),
  createdAt: z.string().describe("When this plan was generated."),
  scannedAt: z
    .string()
    .describe("When the underlying repository scan was taken. The steps were resolved against the library as of that scan."),
  perStep: z
    .array(z.number().int())
    .describe(
      "How many files each step's selector matched, in step order, before any file was excluded. A file two steps " +
        "both matched is counted under each of them.",
    ),
  items: z
    .array(
      z.object({
        path: z.string(),
        currentName: z.string(),
        targetName: z.string(),
        targetPath: z.string(),
        step: z.number().int(),
      }),
    )
    .describe(
      "What will be renamed or moved, sorted by path, each with the step that produced it, counted from 1. " +
        "targetPath is the full path the file occupies afterward. May be a prefix of the stored plan; see itemCount " +
        "and itemsOmitted.",
    ),
  itemCount: z.number().int().describe("Items in the stored plan. Computed before the listing above is cut."),
  itemsOmitted: z.number().int().describe("Items the listing above left out. Zero when the listing is complete."),
  excluded: z
    .array(CUSTOM_EXCLUDED_ITEM_SCHEMA)
    .describe(
      "Selected files this plan will NOT change, each with why and the steps involved. matched_by_multiple_steps " +
        "means more than one step selected the file, so no single answer applies. no_change means the step would " +
        "leave the file's path exactly as it is. extension_would_change means the new name would change the " +
        "file's extension, which this tool never does. invalid_target_name means the new name breaks a SharePoint " +
        "naming rule this server checks, such as a forbidden character. target_path_already_occupied means a file already sits at the target path. " +
        "two_items_share_one_target means more than one file would land on the same target path, so every one of " +
        "them is left alone. no_etag_available and file_not_found_at_plan_time mean the file had no usable " +
        "precondition when the plan was generated.",
    ),
  excludedCount: z.number().int().describe("Excluded items in the stored plan. Computed before the listing above is cut."),
  excludedOmitted: z.number().int().describe("Excluded items the listing above left out."),
  etagLookupsIssued: z
    .number()
    .int()
    .describe(
      "Lookups issued, one per resolved item whose etag this call fetched, counted rather than measured against " +
        "the shared Graph request counter, which a concurrent call also moves and which a retried lookup can move " +
        "more than once. A file the resolver excluded costs none. Not a Graph request count: a throttled lookup " +
        "retries and spends more than one request while still counting as one lookup here.",
    ),
  scanGraphRequestsByThisCall: z
    .number()
    .int()
    .describe("What the repository scan cost this call. Zero when this call joined a scan another call had started."),
  scanSharedWithConcurrentCall: z
    .boolean()
    .describe("True when this call awaited a scan another call had already started, which is the only reason the scan cost can be zero."),
} satisfies z.ZodRawShape;

export const CUSTOM_ITEM_OUTCOMES = [
  "applied",
  "would_apply",
  "precondition_refused",
  "target_name_taken",
  "not_found",
  "failed",
] as const;
export type CustomItemOutcome = (typeof CUSTOM_ITEM_OUTCOMES)[number];

export interface CustomItemResult {
  path: string;
  currentName: string;
  targetName: string;
  targetPath: string;
  /**
   * Which operator-written step produced this item. Absent on a reversal
   * plan's run: `reversalItemsFor` in `src/tools/plans/apply.ts` swaps path,
   * name and etag to build the inverse, but it does not carry `step` forward,
   * since a reversal item was not produced by any of the operator's own
   * steps.
   */
  step?: number;
  outcome: CustomItemOutcome;
}

export interface ExecuteCustomPlanOutput {
  planId: string;
  profileId: string;
  /**
   * The drive this run addressed, taken from the plan, for the reason
   * ExecuteMovePlanOutput's own field gives: this call writes to the plan's
   * own drive regardless of what the profile's identity.library says now.
   */
  driveId: string;
  /** The plan id this run undoes. Absent unless the plan executed is itself a reversal. */
  reverses?: string;
  dryRun: boolean;
  results: CustomItemResult[];
  resultCount: number;
  resultsOmitted: number;
  counts: {
    applied: number;
    wouldApply: number;
    preconditionRefused: number;
    targetNameTaken: number;
    notFound: number;
    failed: number;
  };
  excluded: CustomExcludedItem[];
  excludedCount: number;
  excludedOmitted: number;
  /** Absent on a dry run, which changes nothing and therefore writes no reversal log. */
  reversalPlanId?: string;
  reversalEntriesNotRefreshed: number;
  graphOperationsIssued: number;
}

export const EXECUTE_CUSTOM_PLAN_OUTPUT_SCHEMA = {
  planId: z.string().describe("The plan this call applied or previewed."),
  profileId: z.string().describe("The profile the plan belongs to."),
  driveId: z
    .string()
    .describe(
      "The drive every write in this run was addressed within, taken from the plan itself rather than from the " +
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
        "a path is still the one the plan recorded, or whether the target name is free: outcomes of " +
        "precondition_refused, target_name_taken, not_found and failed can only appear in a confirmed run.",
    ),
  results: z
    .array(
      z.object({
        path: z.string(),
        currentName: z.string(),
        targetName: z.string(),
        targetPath: z.string(),
        step: z
          .number()
          .int()
          .optional()
          .describe(
            "Which operator-written step produced this item. Absent on a reversal plan's run, since a reversal " +
              "item was not produced by any of the operator's own steps.",
          ),
        outcome: z.enum(CUSTOM_ITEM_OUTCOMES),
      }),
    )
    .describe(
      "One entry per item in the plan, sorted by path. applied means the file was changed as the plan recorded; " +
        "would_apply means a dry run reached it and stopped; precondition_refused means Graph refused the write " +
        "because the item at that path is not the one the plan recorded. Graph checks If-Match before existence, " +
        "so this single outcome covers both a file that changed and a file that is no longer there, and this " +
        "server deliberately does not pay the cost of a GET per refusal to tell the two apart. target_name_taken " +
        "means another file held the target name when the write was attempted, and Graph refused rather than " +
        "replace it. not_found is expected to stay zero: this executor always sends If-Match, and a stale " +
        "precondition against an absent path answers 412 before Graph ever reports the path missing, so a 404 " +
        "cannot reach this outcome today. It is kept as a label rather than removed, since a branch on a write " +
        "path is not removed on the strength of a negative nobody can prove. failed means Graph answered with " +
        "something other than those, or this server did not send the write at all, for example because its own " +
        "token was refused; the server log carries the reason. A target folder deleted after the plan was " +
        "generated is reported as failed, because Graph answers it with a generic 400 that names no cause. May " +
        "be a prefix; see resultCount.",
    ),
  resultCount: z.number().int().describe("Items in the plan. Computed before the listing above is cut."),
  resultsOmitted: z.number().int().describe("Items the listing above left out."),
  counts: z
    .object({
      applied: z.number().int(),
      wouldApply: z.number().int(),
      preconditionRefused: z
        .number()
        .int()
        .describe(
          "Items Graph refused because the item at that path was not the one the plan recorded. Covers both a " +
            "changed file and an absent one: Graph checks If-Match before existence, and telling the two apart " +
            "would cost a GET per refusal this project deliberately does not pay.",
        ),
      targetNameTaken: z
        .number()
        .int()
        .describe("Items Graph refused because another file already holds the target name. Nothing was replaced."),
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
    .array(CUSTOM_EXCLUDED_ITEM_SCHEMA)
    .describe(
      "Items the plan recorded at generation time as ones it would not attempt, carried here so an operator " +
        "reading this report does not have to hold the plan open beside it to learn why a file they expected to " +
        "be changed was not. The reasons mean what generate_custom_plan's excluded description says.",
    ),
  excludedCount: z.number().int().describe("Excluded items in the plan. Computed before the listing above is cut."),
  excludedOmitted: z.number().int().describe("Excluded items the listing above left out."),
  reversalPlanId: z
    .string()
    .optional()
    .describe(
      "The plan id that undoes this run, written before the first write. Absent on a dry run, which changes " +
        "nothing to reverse. Apply it with this same tool to roll back.",
    ),
  reversalEntriesNotRefreshed: z
    .number()
    .int()
    .describe(
      "Writes that succeeded but whose reversal entry could not be given the file's new ETag. Replaying the " +
        "reversal will refuse those items on their own precondition rather than undo them, so they need a fresh " +
        "plan. Zero is the normal result.",
    ),
  graphOperationsIssued: z
    .number()
    .int()
    .describe(
      "Graph operations this call issued: one per write attempt, plus one for each follow-up ETag read a missing " +
        "PATCH response forced. Counted directly rather than measured against the shared Graph request counter, " +
        "which a concurrent call also moves and which a retried operation can move more than once. Not a request " +
        "count: a throttled PATCH retries and spends more than one request while counting as one operation here. " +
        "Zero on a dry run, which contacts Graph not at all.",
    ),
} satisfies z.ZodRawShape;
