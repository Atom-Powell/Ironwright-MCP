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
    .array(
      z.object({
        path: z.string(),
        currentName: z.string(),
        targetName: z.string(),
        reason: z.enum(CUSTOM_EXCLUSION_REASONS),
        steps: z.array(z.number().int()),
      }),
    )
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
