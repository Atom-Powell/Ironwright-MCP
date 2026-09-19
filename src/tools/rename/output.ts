import { z } from "zod";
import type { PlanExclusionReason } from "../../store/types.js";

/**
 * A coarse pre-check against an obviously oversized plan, refused before a
 * single Graph request is spent rather than after the etag fetch loop. It is
 * not the real ceiling: the store's actual bound is `MAX_PLAN_JSON_CHARS`
 * (32000 characters across `items` and `excluded` combined), and a realistic
 * item serializes to roughly 274 characters, so the true limit is closer to
 * 116 items with `excluded` unbounded. This number exists only so a plan far
 * past any reasonable size fails fast, with a remedy a caller can act on,
 * before the etag fetch loop runs at all; `savePlan` is what actually enforces
 * the character cap, in both StateStore implementations.
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
  "slot_already_satisfied_by_another_file",
  "two_files_share_one_target_name",
  "no_etag_available",
  "file_not_found_at_plan_time",
] as const satisfies readonly PlanExclusionReason[];

/**
 * Compile-time proof this list is exhaustive, not merely valid. The
 * `satisfies` clause above only checks each listed string is some
 * `PlanExclusionReason`; it says nothing about whether every
 * `PlanExclusionReason` is listed. `AssertNever`'s constraint fails to
 * compile the moment `PlanExclusionReason` gains a member this list omits,
 * which is what lets a new reason fail here, at a build, rather than only at
 * a live tenant when the SDK validates `structuredContent` against
 * `z.enum(PLAN_EXCLUSION_REASONS)` and finds a value the schema does not
 * declare.
 */
type AssertNever<T extends never> = T;
type _PlanExclusionReasonsExhaustive = AssertNever<Exclude<PlanExclusionReason, (typeof PLAN_EXCLUSION_REASONS)[number]>>;

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
  etagLookupsIssued: number;
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
      "Misnamed files this plan will NOT attempt, each with why. The first three reasons are name collisions this " +
        "server cannot resolve without a conflict behavior it deliberately does not implement; the last two mean " +
        "the file had no usable precondition when the plan was generated.",
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

export const RENAME_ITEM_OUTCOMES = [
  "renamed",
  "would_rename",
  "changed_since_plan",
  "not_found",
  "failed",
] as const;

export type RenameItemOutcome = (typeof RENAME_ITEM_OUTCOMES)[number];

export interface RenameItemResult {
  path: string;
  currentName: string;
  targetName: string;
  targetPath: string;
  client: string;
  outcome: RenameItemOutcome;
}

export interface ExecuteRenamePlanOutput {
  planId: string;
  profileId: string;
  library: string;
  dryRun: boolean;
  results: RenameItemResult[];
  resultCount: number;
  resultsOmitted: number;
  counts: { renamed: number; wouldRename: number; changedSincePlan: number; notFound: number; failed: number };
  excluded: Array<{ path: string; currentName: string; targetName: string; client: string; reason: PlanExclusionReason }>;
  excludedCount: number;
  excludedOmitted: number;
  /** Absent on a dry run, which changes nothing and therefore writes no reversal log. */
  reversalPlanId?: string;
  reversalEntriesNotRefreshed: number;
  graphRequests: number;
}

export const EXECUTE_RENAME_PLAN_OUTPUT_SCHEMA = {
  planId: z.string().describe("The plan this call applied or previewed."),
  profileId: z.string().describe("The profile the plan belongs to."),
  library: z.string().describe("The document library named by the profile's identity."),
  dryRun: z
    .boolean()
    .describe(
      "True when nothing was changed. A dry run contacts Graph not at all, so it cannot tell whether a file has " +
        "changed since the plan was generated: outcomes of changed_since_plan and not_found can only appear in a " +
        "confirmed run.",
    ),
  results: z
    .array(
      z.object({
        path: z.string(),
        currentName: z.string(),
        targetName: z.string(),
        targetPath: z.string(),
        client: z.string(),
        outcome: z.enum(RENAME_ITEM_OUTCOMES),
      }),
    )
    .describe(
      "One entry per item in the plan, sorted by path. renamed means the file was renamed; would_rename means a " +
        "dry run reached it and stopped; changed_since_plan means its ETag precondition was refused and the file " +
        "was left untouched; not_found means nothing is at that path any more; failed means Graph answered with " +
        "something other than those two, and the server log carries it. May be a prefix; see resultCount.",
    ),
  resultCount: z.number().int().describe("Items in the plan. Computed before the listing above is cut."),
  resultsOmitted: z.number().int().describe("Items the listing above left out."),
  counts: z
    .object({
      renamed: z.number().int(),
      wouldRename: z.number().int(),
      changedSincePlan: z.number().int(),
      notFound: z.number().int(),
      failed: z.number().int(),
    })
    .describe("Computed over every item in the plan, before the listing above is cut. Never abridged."),
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
      "Items the plan recorded at generation time as ones it would not attempt, carried here so an operator " +
        "reading this report does not have to hold the plan open beside it to learn why a file they expected to " +
        "be renamed was not.",
    ),
  excludedCount: z.number().int().describe("Excluded items in the plan. Computed before the listing above is cut."),
  excludedOmitted: z.number().int().describe("Excluded items the listing above left out."),
  reversalPlanId: z
    .string()
    .optional()
    .describe(
      "The plan id that undoes this run, written before the first rename. Absent on a dry run, which changes " +
        "nothing to reverse. Apply it with this same tool to roll back.",
    ),
  reversalEntriesNotRefreshed: z
    .number()
    .int()
    .describe(
      "Renames that succeeded but whose reversal entry could not be given the file's new ETag. Replaying the " +
        "reversal will refuse those items on their own precondition rather than undo them, so they need a fresh " +
        "plan. Zero is the normal result.",
    ),
  graphRequests: z
    .number()
    .int()
    .describe("What this call itself paid. Zero on a dry run, which contacts Graph not at all."),
} satisfies z.ZodRawShape;
