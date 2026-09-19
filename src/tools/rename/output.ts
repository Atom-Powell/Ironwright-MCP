import { z } from "zod";
import type { PlanExclusionReason } from "../../store/types.js";

/**
 * The most items one generated plan holds. A plan larger than this cannot be
 * stored, since Azure Table caps a String property, and the refusal is raised
 * at generation time with a remedy a caller can act on rather than at the save,
 * where the message can only name characters.
 */
export const MAX_PLAN_ITEMS = 200;

/**
 * The most items and exclusions one response lists. The stored plan holds every
 * one of them; `itemCount` and `excludedCount` are computed before this cut, so
 * a reader always learns the true size even when the listing is a prefix.
 */
export const MAX_PLAN_ITEMS_LISTED = 50;

export const PLAN_EXCLUSION_REASONS = [
  "target_path_already_occupied",
  "two_files_share_one_target_name",
  "no_etag_available",
  "file_not_found_at_plan_time",
] as const;

export interface GenerateRenamePlanOutput {
  planId: string;
  profileId: string;
  library: string;
  driveId: string;
  createdAt: string;
  scannedAt: string;
  items: Array<{ path: string; currentName: string; targetName: string; targetPath: string; client: string }>;
  itemCount: number;
  itemsOmitted: number;
  excluded: Array<{ path: string; currentName: string; targetName: string; client: string; reason: PlanExclusionReason }>;
  excludedCount: number;
  excludedOmitted: number;
  workbookReadGraphRequestsByThisCall: number;
  etagLookupGraphRequests: number;
  scanGraphRequestsByThisCall: number;
  scanSharedWithConcurrentCall: boolean;
}

export const GENERATE_RENAME_PLAN_OUTPUT_SCHEMA = {
  planId: z.string().describe("The id execute_rename_plan consumes to apply this plan."),
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
      "What will be renamed, sorted by path. May be a prefix of the stored plan; see itemCount and itemsOmitted. " +
        "The stored plan holds every item regardless of what this listing shows.",
    ),
  itemCount: z.number().int().describe("Items in the stored plan. Computed before the listing above is cut."),
  itemsOmitted: z.number().int().describe("Items the listing above left out. Zero when the listing is complete."),
  excluded: z
    .array(
      z.object({
        path: z.string(),
        currentName: z.string(),
        targetName: z.string(),
        client: z.string(),
        reason: z.enum(PLAN_EXCLUSION_REASONS),
      }),
    )
    .describe(
      "Misnamed files this plan will NOT attempt, each with why. The first two reasons are name collisions this " +
        "server cannot resolve without a conflict behavior it deliberately does not implement; the last two mean " +
        "the file had no usable precondition when the plan was generated.",
    ),
  excludedCount: z.number().int().describe("Excluded items in the stored plan. Computed before the listing above is cut."),
  excludedOmitted: z.number().int().describe("Excluded items the listing above left out."),
  workbookReadGraphRequestsByThisCall: z
    .number()
    .int()
    .describe("What reading the workbook cost this call. A download costs two requests, not one."),
  etagLookupGraphRequests: z
    .number()
    .int()
    .describe(
      "One per candidate whose etag this call fetched, counted rather than measured against the shared request " +
        "counter, which a concurrent call also moves.",
    ),
  scanGraphRequestsByThisCall: z
    .number()
    .int()
    .describe("What the repository scan cost this call. Zero when this call joined a scan another call had started."),
  scanSharedWithConcurrentCall: z
    .boolean()
    .describe("True when this call awaited a scan another call had already started, which is the only reason the scan cost can be zero."),
} satisfies z.ZodRawShape;
