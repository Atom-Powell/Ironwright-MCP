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
