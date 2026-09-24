import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  MalformedPlanEntityError,
  type ExcludedPlanItem,
  type PlanExclusionReason,
  type RenamePlanItem,
  type StoredPlan,
} from "../../store/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { applyPlan, comparePaths, type AppliedOutcome } from "../plans/apply.js";
import { noPlanStored, wrongPlanKind } from "../plans/refusals.js";
import { newPlanId } from "./ids.js";
import {
  MAX_PLAN_ITEMS_LISTED,
  PLAN_EXCLUSION_REASONS,
  type ExecuteRenamePlanOutput,
  type RenameItemOutcome,
  type RenameItemResult,
} from "./output.js";
import { executePlanText } from "./text.js";

export const EXECUTE_RENAME_PLAN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Profile the plan was generated against, for example \"example\"."),
  planId: z
    .string()
    .min(1)
    .describe("Plan id returned by generate_rename_plan, for example \"rnm-2026-09-18-a1b2c3d4\"."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Set true to apply the plan for real, for example true. Leave false or omit for a dry run."),
} satisfies z.ZodRawShape;

const InputObject = z.object(EXECUTE_RENAME_PLAN_INPUT_SCHEMA);

const RENAME_OUTCOME: Record<AppliedOutcome, RenameItemOutcome> = {
  applied: "renamed",
  would_apply: "would_rename",
  precondition_refused: "precondition_refused",
  not_found: "not_found",
  failed: "failed",
};

function isRenameExclusionReason(reason: string): reason is PlanExclusionReason {
  return (PLAN_EXCLUSION_REASONS as readonly string[]).includes(reason);
}

/**
 * A rename plan's generator writes only rename reasons, so a foreign reason
 * here means the stored row contradicts its own kind. Refused rather than
 * passed through, because the output schema would reject it at the SDK and the
 * operator would see a validation error instead of the cause.
 */
function renameExclusionsOf(plan: StoredPlan): ExcludedPlanItem<PlanExclusionReason>[] {
  return plan.excluded.map((item) => {
    if (!isRenameExclusionReason(item.reason)) {
      throw new MalformedPlanEntityError(plan.planId, "excluded", `holds the reason "${item.reason}", which a rename plan cannot carry`);
    }
    return { ...item, reason: item.reason };
  });
}

/**
 * Applies a rename plan, or previews it, through the executor every plan kind
 * shares. It refuses a plan of any other kind before anything is attempted.
 */
export async function runExecuteRenamePlan(
  input: unknown,
  context: ToolContext,
  // Injected only by tests. Production always generates a fresh id.
  makeReversalPlanId: () => string = () => newPlanId("rev", context.now()),
): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "execute_rename_plan", profileId: args.profileId };

  try {
    const profile = context.profiles.get(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    const plan = await context.store.getPlan(args.profileId, args.planId);
    if (plan === undefined || plan.profileId !== args.profileId) {
      // The second half of that condition cannot fire through a partitioned
      // read today. It is checked anyway, because the alternative to a refusal
      // here is applying one profile's plan against another profile's library.
      return noPlanStored(args.planId, args.profileId, "generate_rename_plan");
    }
    if (plan.kind !== "rename") return wrongPlanKind(plan, "rename");
    // Validated before anything is applied. Checked after the loop instead, a
    // malformed row would be refused only once every rename had landed, and
    // the refusal would replace the per-item report of what was applied.
    const excluded = renameExclusionsOf(plan).sort(comparePaths);

    const applied = await applyPlan(plan, {
      confirm: args.confirm,
      context,
      profileId: args.profileId,
      toolName: "execute_rename_plan",
      makeReversalPlanId,
    });
    const results = applied.results.map((entry) => resultFor(entry.item, RENAME_OUTCOME[entry.outcome]));

    const output: ExecuteRenamePlanOutput = {
      planId: plan.planId,
      profileId: plan.profileId,
      // The plan's drive, not the profile's library name. Every write above
      // addressed plan.driveId, and a profile whose identity.library changed
      // after this plan was generated would make that name describe a library
      // this call did not touch.
      driveId: plan.driveId,
      ...(plan.reverses === undefined ? {} : { reverses: plan.reverses }),
      dryRun: !args.confirm,
      results: results.slice(0, MAX_PLAN_ITEMS_LISTED),
      resultCount: results.length,
      resultsOmitted: Math.max(0, results.length - MAX_PLAN_ITEMS_LISTED),
      counts: {
        renamed: countOf(results, "renamed"),
        wouldRename: countOf(results, "would_rename"),
        preconditionRefused: countOf(results, "precondition_refused"),
        notFound: countOf(results, "not_found"),
        failed: countOf(results, "failed"),
      },
      excluded: excluded.slice(0, MAX_PLAN_ITEMS_LISTED),
      excludedCount: excluded.length,
      excludedOmitted: Math.max(0, excluded.length - MAX_PLAN_ITEMS_LISTED),
      ...(applied.reversalPlanId === undefined ? {} : { reversalPlanId: applied.reversalPlanId }),
      reversalEntriesNotRefreshed: applied.reversalEntriesNotRefreshed,
      graphOperationsIssued: applied.graphOperationsIssued,
    };

    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [{ type: "text" as const, text: executePlanText(output).join("\n") }],
    };
  } catch (error) {
    console.error(`execute_rename_plan failed for profile "${args.profileId}" and plan "${args.planId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}

function resultFor(item: RenamePlanItem, outcome: RenameItemOutcome): RenameItemResult {
  return {
    path: item.path,
    currentName: item.currentName,
    targetName: item.targetName,
    targetPath: item.targetPath,
    client: item.client,
    outcome,
  };
}

function countOf(results: readonly RenameItemResult[], outcome: RenameItemOutcome): number {
  return results.filter((result) => result.outcome === outcome).length;
}
