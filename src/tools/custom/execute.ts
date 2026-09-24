import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MalformedPlanEntityError, type RenamePlanItem, type StoredPlan } from "../../store/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { applyPlan, comparePaths, type AppliedOutcome } from "../plans/apply.js";
import { noPlanStored, wrongPlanKind } from "../plans/refusals.js";
import { newPlanId } from "../rename/ids.js";
import {
  CUSTOM_EXCLUSION_REASONS,
  MAX_PLAN_ITEMS_LISTED,
  type CustomExcludedItem,
  type CustomItemOutcome,
  type CustomItemResult,
  type CustomPlanExclusionReason,
  type ExecuteCustomPlanOutput,
} from "./output.js";
import { executeCustomPlanText } from "./text.js";

export const EXECUTE_CUSTOM_PLAN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('Profile the plan was generated against, for example "shared-docs".'),
  planId: z
    .string()
    .min(1)
    .describe('Plan id returned by generate_custom_plan, for example "cus-2026-09-24-a1b2c3d4".'),
  confirm: z
    .boolean()
    .default(false)
    .describe("Set true to apply the plan for real, for example true. Leave false or omit for a dry run."),
} satisfies z.ZodRawShape;

const InputObject = z.object(EXECUTE_CUSTOM_PLAN_INPUT_SCHEMA);

const CUSTOM_OUTCOME: Record<AppliedOutcome, CustomItemOutcome> = {
  applied: "applied",
  would_apply: "would_apply",
  precondition_refused: "precondition_refused",
  target_name_taken: "target_name_taken",
  not_found: "not_found",
  failed: "failed",
};

function isCustomExclusionReason(reason: string): reason is CustomPlanExclusionReason {
  return (CUSTOM_EXCLUSION_REASONS as readonly string[]).includes(reason);
}

/**
 * Mirrors moveExclusionsOf's reasoning in src/tools/move/execute.ts: the store
 * checks only that a stored plan's excluded field is an array, so a reason
 * outside the custom set is typed out of existence here but not ruled out at
 * runtime, and is refused before anything is applied rather than passed
 * through to the output schema, where it would fail at the wire instead of
 * naming the cause.
 */
function customExclusionsOf(plan: StoredPlan): CustomExcludedItem[] {
  return plan.excluded.map((item): CustomExcludedItem => {
    const reason: string = item.reason;
    if (!isCustomExclusionReason(reason)) {
      throw new MalformedPlanEntityError(
        plan.planId,
        "excluded",
        `holds the reason "${reason}", which a custom plan cannot carry`,
      );
    }
    return {
      path: item.path,
      currentName: item.currentName,
      targetName: item.targetName,
      reason,
      steps: item.steps ?? [],
    };
  });
}

/**
 * Applies a custom plan, or previews it, through the executor every plan kind
 * shares. It refuses a plan of any other kind before anything is attempted.
 * `getAny` rather than `get`, since a library-only profile carries no
 * compliance definition this tool needs: it applies the operator's own steps,
 * not a workbook-driven verdict.
 */
export async function runExecuteCustomPlan(
  input: unknown,
  context: ToolContext,
  // Injected only by tests. Production always generates a fresh id.
  makeReversalPlanId: () => string = () => newPlanId("rev", context.now()),
): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "execute_custom_plan", profileId: args.profileId };

  try {
    const profile = context.profiles.getAny(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    const plan = await context.store.getPlan(args.profileId, args.planId);
    if (plan === undefined || plan.profileId !== args.profileId) {
      // The second half of that condition cannot fire through a partitioned
      // read today. It is checked anyway, for the reason execute_move_plan's
      // own comment gives: the alternative to a refusal here is applying one
      // profile's plan against another profile's library.
      return noPlanStored(args.planId, args.profileId, "generate_custom_plan");
    }
    if (plan.kind !== "custom") return wrongPlanKind(plan, "custom");
    // Validated before anything is applied, for the reason customExclusionsOf
    // gives.
    const excluded = customExclusionsOf(plan).sort(comparePaths);

    const applied = await applyPlan(plan, {
      confirm: args.confirm,
      context,
      profileId: args.profileId,
      toolName: "execute_custom_plan",
      makeReversalPlanId,
    });
    const results = applied.results.map((entry) => resultFor(entry.item, CUSTOM_OUTCOME[entry.outcome]));

    const output: ExecuteCustomPlanOutput = {
      planId: plan.planId,
      profileId: plan.profileId,
      // The plan's drive, not the profile's library name, for the reason
      // execute_move_plan's own output gives.
      driveId: plan.driveId,
      ...(plan.reverses === undefined ? {} : { reverses: plan.reverses }),
      dryRun: !args.confirm,
      results: results.slice(0, MAX_PLAN_ITEMS_LISTED),
      resultCount: results.length,
      resultsOmitted: Math.max(0, results.length - MAX_PLAN_ITEMS_LISTED),
      counts: {
        applied: countOf(results, "applied"),
        wouldApply: countOf(results, "would_apply"),
        preconditionRefused: countOf(results, "precondition_refused"),
        targetNameTaken: countOf(results, "target_name_taken"),
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
      content: [{ type: "text" as const, text: executeCustomPlanText(output).join("\n") }],
    };
  } catch (error) {
    console.error(`execute_custom_plan failed for profile "${args.profileId}" and plan "${args.planId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}

function resultFor(item: RenamePlanItem, outcome: CustomItemOutcome): CustomItemResult {
  return {
    path: item.path,
    currentName: item.currentName,
    targetName: item.targetName,
    targetPath: item.targetPath,
    ...(item.step === undefined ? {} : { step: item.step }),
    outcome,
  };
}

function countOf(results: readonly CustomItemResult[], outcome: CustomItemOutcome): number {
  return results.filter((result) => result.outcome === outcome).length;
}
