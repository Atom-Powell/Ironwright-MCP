import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  resolveCustomPlan,
  stepShapeRefusal,
  type CustomStep,
  type ResolvedExclusion,
  type ResolvedItem,
} from "../../domain/custom/resolve.js";
import { MAX_PLAN_JSON_CHARS, storedPlanJsonChars, type ExcludedPlanItem, type StoredPlan } from "../../store/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { comparePaths } from "../plans/apply.js";
import { fetchPlanEtags } from "../plans/etags.js";
import { newPlanId } from "../rename/ids.js";
import {
  MAX_PLAN_ITEMS_LISTED,
  type CustomExcludedItem,
  type GenerateCustomPlanOutput,
} from "./output.js";
import { generateCustomPlanText, refusalText } from "./text.js";

const SelectorSchema = z.object({
  folder: z
    .string()
    .describe('Library-relative folder to select files from, for example "/Client A/2025". "/" is the library root.'),
  recursive: z.boolean().optional().describe("Also select files in subfolders, for example true. Defaults to false."),
  nameEquals: z.string().min(1).optional().describe('Exact file name, ignoring case, for example "notes.docx".'),
  nameContains: z.string().min(1).optional().describe('Text the file name contains, ignoring case, for example "draft".'),
  extensions: z
    .array(z.string().min(1))
    .optional()
    .describe('File extensions to select, for example [".pdf", ".docx"].'),
  modifiedAfter: z
    .string()
    .optional()
    .describe(
      'Only files modified after this ISO 8601 date, or date-time with an offset or Z, for example "2025-01-01".',
    ),
  modifiedBefore: z
    .string()
    .optional()
    .describe(
      'Only files modified before this ISO 8601 date, or date-time with an offset or Z, for example "2026-01-01".',
    ),
});

const RenameSchema = z.object({
  setName: z
    .string()
    .min(1)
    .optional()
    .describe('New full name, for a selector matching exactly one file, for example "2026-05 Client A.pdf".'),
  replace: z
    .object({
      find: z.string().min(1).describe('Literal text to find in the name, for example "DRAFT".'),
      with: z.string().describe('Literal replacement, for example "FINAL". May be empty.'),
    })
    .optional()
    .describe('Replace literal text in the name, keeping the extension, for example {"find": "DRAFT", "with": "FINAL"}.'),
  addPrefix: z.string().min(1).optional().describe('Text to put before the name, for example "2025 ".'),
  addSuffix: z.string().min(1).optional().describe('Text to put before the extension, for example " v2".'),
});

export const GENERATE_CUSTOM_PLAN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('Configured profile to plan against, for example "shared-docs".'),
  steps: z
    .array(
      z.object({
        selector: SelectorSchema.describe(
          'Which files this step selects; every field given must match, for example {"folder": "/Client A/2025"}.',
        ),
        moveTo: z
          .string()
          .optional()
          .describe('Existing library-relative folder to move the files into, for example "/Archive/2025".'),
        rename: RenameSchema.optional().describe(
          'How to rename the files; give exactly one form, for example {"addPrefix": "2025 "}.',
        ),
      }),
    )
    .min(1)
    .max(20)
    .describe(
      'One to 20 steps, each a selector and an action, for example [{"selector": {"folder": "/Client A/2025", "extensions": [".pdf"]}, "moveTo": "/Archive/2025"}].',
    ),
} satisfies z.ZodRawShape;

export const CUSTOM_PLAN_INPUT_CONSTRAINTS =
  "Each step needs moveTo, rename, or both. rename takes exactly one of setName, replace, addPrefix or addSuffix. " +
  "setName is allowed only when the step's selector matches exactly one file. " +
  "modifiedAfter and modifiedBefore take a date (YYYY-MM-DD) or a date-time with an explicit offset or Z.";

const InputObject = z.object(GENERATE_CUSTOM_PLAN_INPUT_SCHEMA);
type Input = z.infer<typeof InputObject>;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Refuses a date bound the resolver would read wrongly. The resolver compares
 * through `Date.parse`, which reads a date-time with no offset in this
 * machine's local zone, so the same request would select different files on
 * servers in different zones, and turns anything it cannot parse into NaN,
 * against which every comparison is false, so the step silently selects
 * nothing. A date alone is defined as UTC and an explicit offset or Z pins the
 * instant, so those two forms are the only ones accepted.
 */
function dateBoundProblem(steps: Input["steps"]): string | undefined {
  for (const [index, step] of steps.entries()) {
    for (const field of ["modifiedAfter", "modifiedBefore"] as const) {
      const value = step.selector[field];
      if (value === undefined) continue;
      const shaped = DATE_ONLY.test(value) || DATE_TIME_WITH_OFFSET.test(value);
      if (!shaped || Number.isNaN(Date.parse(value))) {
        return (
          `Step ${String(index + 1)}'s selector.${field} is "${value}", which is not a date (YYYY-MM-DD) or a ` +
          'date-time with an explicit offset or Z, for example "2025-01-01" or "2025-01-01T00:00:00Z". ' +
          "No plan was saved."
        );
      }
    }
  }
  return undefined;
}

/**
 * Stands in for each item's ETag in the size estimate, since the real ones are
 * fetched only after the estimate passes. A driveItem eTag has the shape
 * `"{GUID},N"`: 42 characters with a one-digit version, and 44 once
 * JSON.stringify escapes its two quotation marks. 48 leaves room for a version
 * of up to five digits, so the estimate leans toward over-counting rather than
 * admitting a plan the store then refuses after every lookup was spent.
 */
const ESTIMATED_ETAG = "e".repeat(48);

/**
 * Estimates what `savePlan` will measure, through the store's own
 * measurement, before any ETag is fetched. It counts every resolved item as a
 * planned item with a placeholder ETag. An item the lookup later excludes is
 * stored in a slightly different shape and a real ETag's length varies, which
 * is why this is an estimate and the store's own check still runs at save time.
 */
function estimatedStoredChars(
  items: readonly ResolvedItem[],
  exclusions: readonly ResolvedExclusion[],
  steps: readonly CustomStep[],
): number {
  return storedPlanJsonChars({
    items: items.map((item) => ({
      path: item.path,
      currentName: item.currentName,
      targetName: item.targetName,
      targetPath: item.targetPath,
      client: "",
      etag: ESTIMATED_ETAG,
      step: item.step,
    })),
    excluded: exclusions.map((e) => ({
      path: e.path,
      currentName: e.currentName,
      targetName: e.targetName,
      reason: e.reason,
      steps: e.steps,
      client: "",
    })),
    steps: [...steps],
  });
}

function tooLargeToStoreText(estimate: number, perStep: readonly number[]): string {
  const counts = perStep.map((count, index) => `step ${String(index + 1)}: ${String(count)}`).join(", ");
  return (
    `This plan would be too large to store: its stored size is estimated at about ${String(estimate)} ` +
    `characters, more than the ${String(MAX_PLAN_JSON_CHARS)} a single stored plan holds. The estimate grows ` +
    "with each file's path and name length, so long paths reach that limit with fewer files. " +
    `Files matched per step: ${counts}. Narrow the steps or split the work into smaller plans. ` +
    "No ETag was fetched. No plan was saved."
  );
}

/**
 * Generates a reviewable plan from operator-written steps and persists it.
 * The resolver does all the selecting and every refusal and exclusion; this
 * handler adds only what needs I/O: the scan it resolves against, the
 * plan-time etag fetch, and the store.
 */
export async function runGenerateCustomPlan(
  input: unknown,
  context: ToolContext,
  // Injected only by tests. Production uses real ids.
  makePlanId: () => string = () => newPlanId("cus", context.now()),
): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "generate_custom_plan", profileId: args.profileId };

  // The parsed rename is one object with four optional keys rather than
  // CustomRename's union of one-key objects. The shape check below and the
  // resolver count a form as present only when its value is not undefined and
  // refuse any count but one, so this cast hands them nothing they do not
  // already check.
  const steps = args.steps as CustomStep[];

  // Both checked before the profile or the scan, since they depend on the
  // request alone and a request that cannot be resolved correctly should cost
  // nothing. The shape check is the resolver's own, so its refusal reads
  // exactly as the resolver's would.
  const dateProblem = dateBoundProblem(args.steps);
  if (dateProblem !== undefined) {
    return { isError: true, content: [{ type: "text" as const, text: dateProblem }] };
  }
  const shapeRefusal = stepShapeRefusal(steps);
  if (shapeRefusal !== undefined) {
    return { isError: true, content: [{ type: "text" as const, text: refusalText(shapeRefusal) }] };
  }

  try {
    const profile = context.profiles.getAny(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    const scan = await context.scans.run(profile);

    const resolution = resolveCustomPlan(steps, scan.result.snapshot);
    if (!resolution.ok) {
      return { isError: true, content: [{ type: "text" as const, text: refusalText(resolution.refusal) }] };
    }

    // Estimated before any lookup rather than left to savePlan, which would
    // refuse only after every lookup had been spent. The 100-file cap does
    // not bound the stored size on its own, since long paths fill the store's
    // limit with fewer files.
    const estimate = estimatedStoredChars(resolution.items, resolution.exclusions, steps);
    if (estimate > MAX_PLAN_JSON_CHARS) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: tooLargeToStoreText(estimate, resolution.perStep) }],
      };
    }

    // Carried by path because fetchPlanEtags returns its own item shape and
    // drops any field it does not know, the step among them.
    const stepByPath = new Map(resolution.items.map((item) => [item.path, item.step]));
    const stepOf = (path: string): number => stepByPath.get(path) ?? 0;

    // Only resolved items are looked up: a file the resolver excluded is never
    // written, so its precondition would be a request spent on nothing.
    const candidates = resolution.items.map((item) => ({
      path: item.path,
      currentName: item.currentName,
      targetName: item.targetName,
      targetPath: item.targetPath,
      client: "",
    }));
    const fetched = await fetchPlanEtags(context.graph, scan.result.driveId, candidates);

    const excluded: CustomExcludedItem[] = [
      ...resolution.exclusions.map((e) => ({
        path: e.path,
        currentName: e.currentName,
        targetName: e.targetName,
        reason: e.reason,
        steps: e.steps,
      })),
      ...fetched.excluded.map((e) => ({
        path: e.path,
        currentName: e.currentName,
        targetName: e.targetName,
        reason: e.reason,
        steps: [stepOf(e.path)],
      })),
    ].sort(comparePaths);

    const storedExcluded: ExcludedPlanItem[] = excluded.map((e) => ({ ...e, client: "" }));
    const plan: StoredPlan = {
      planId: makePlanId(),
      profileId: args.profileId,
      kind: "custom",
      driveId: scan.result.driveId,
      createdAt: context.now().toISOString(),
      items: fetched.items.map((item) => ({ ...item, client: "", step: stepOf(item.path) })).sort(comparePaths),
      excluded: storedExcluded,
      steps,
    };
    await context.store.savePlan(args.profileId, plan);

    const output: GenerateCustomPlanOutput = {
      planId: plan.planId,
      profileId: plan.profileId,
      library: profile.identity.library,
      driveId: plan.driveId,
      createdAt: plan.createdAt,
      scannedAt: scan.result.snapshot.scannedAt,
      perStep: resolution.perStep,
      items: plan.items.slice(0, MAX_PLAN_ITEMS_LISTED).map((item) => ({
        path: item.path,
        currentName: item.currentName,
        targetName: item.targetName,
        targetPath: item.targetPath,
        step: item.step ?? 0,
      })),
      itemCount: plan.items.length,
      itemsOmitted: Math.max(0, plan.items.length - MAX_PLAN_ITEMS_LISTED),
      excluded: excluded.slice(0, MAX_PLAN_ITEMS_LISTED),
      excludedCount: excluded.length,
      excludedOmitted: Math.max(0, excluded.length - MAX_PLAN_ITEMS_LISTED),
      // Counted, not bracketed, for the reason generate_move_plan gives: one
      // lookup per candidate, so the count is exact by construction.
      etagLookupsIssued: candidates.length,
      scanGraphRequestsByThisCall: scan.joined ? 0 : scan.result.graphRequests,
      scanSharedWithConcurrentCall: scan.joined,
    };

    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [{ type: "text" as const, text: generateCustomPlanText(output).join("\n") }],
    };
  } catch (error) {
    // Logged before it is described, because `describeToolFailure` tells the
    // operator the full Graph response is in the server log, and a message must
    // not promise what this function did not do.
    console.error(`generate_custom_plan failed for profile "${args.profileId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}
