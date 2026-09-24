import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  MalformedPlanEntityError,
  type ExcludedPlanItem,
  type MoveExclusionReason,
  type RenamePlanItem,
  type StoredPlan,
} from "../../store/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { applyPlan, comparePaths, type AppliedOutcome } from "../plans/apply.js";
import { noPlanStored, wrongPlanKind } from "../plans/refusals.js";
import { newPlanId } from "../rename/ids.js";
import {
  MAX_PLAN_ITEMS_LISTED,
  MOVE_EXCLUSION_REASONS,
  type ExecuteMovePlanOutput,
  type MoveItemOutcome,
  type MoveItemResult,
} from "./output.js";
import { executeMovePlanText } from "./text.js";

export const EXECUTE_MOVE_PLAN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Profile the plan was generated against, for example \"example\"."),
  planId: z
    .string()
    .min(1)
    .describe("Plan id returned by generate_move_plan, for example \"mov-2026-09-24-a1b2c3d4\"."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Set true to apply the plan for real, for example true. Leave false or omit for a dry run."),
} satisfies z.ZodRawShape;

const InputObject = z.object(EXECUTE_MOVE_PLAN_INPUT_SCHEMA);

const MOVE_OUTCOME: Record<AppliedOutcome, MoveItemOutcome> = {
  applied: "moved",
  would_apply: "would_move",
  precondition_refused: "precondition_refused",
  target_name_taken: "target_name_taken",
  not_found: "not_found",
  failed: "failed",
};

function isMoveExclusionReason(reason: string): reason is MoveExclusionReason {
  return (MOVE_EXCLUSION_REASONS as readonly string[]).includes(reason);
}

/**
 * The store checks only that a stored plan's excluded field is an array, so a
 * reason outside the move set is typed out of existence here but not ruled out
 * at runtime: a hand-edited row, or one written by a later version of this
 * server, can carry one. Refused rather than passed through, because the
 * output schema would reject it at the SDK and the operator would see a
 * validation error instead of the cause, and refused before anything is
 * applied, so that refusal never replaces a report of writes already made.
 */
function moveExclusionsOf(plan: StoredPlan): ExcludedPlanItem<MoveExclusionReason>[] {
  return plan.excluded.map((item) => {
    const reason: string = item.reason;
    if (!isMoveExclusionReason(reason)) {
      throw new MalformedPlanEntityError(plan.planId, "excluded", `holds the reason "${reason}", which a move plan cannot carry`);
    }
    return { ...item, reason };
  });
}

/**
 * Applies a move plan, or previews it, through the executor every plan kind
 * shares. It refuses a plan of any other kind before anything is attempted.
 */
export async function runExecuteMovePlan(
  input: unknown,
  context: ToolContext,
  // Injected only by tests. Production always generates a fresh id.
  makeReversalPlanId: () => string = () => newPlanId("rev", context.now()),
): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "execute_move_plan", profileId: args.profileId };

  try {
    const profile = context.profiles.get(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    const plan = await context.store.getPlan(args.profileId, args.planId);
    if (plan === undefined || plan.profileId !== args.profileId) {
      // The second half of that condition cannot fire through a partitioned
      // read today. It is checked anyway, because the alternative to a refusal
      // here is applying one profile's plan against another profile's library.
      return noPlanStored(args.planId, args.profileId, "generate_move_plan");
    }
    if (plan.kind !== "move") return wrongPlanKind(plan, "move");
    // Validated before anything is applied, for the reason moveExclusionsOf
    // gives. The store's union and the move set are the same today, so this
    // guards the runtime value rather than the type.
    const excluded = moveExclusionsOf(plan).sort(comparePaths);

    const applied = await applyPlan(plan, {
      confirm: args.confirm,
      context,
      profileId: args.profileId,
      toolName: "execute_move_plan",
      makeReversalPlanId,
    });
    const results = applied.results.map((entry) => resultFor(entry.item, MOVE_OUTCOME[entry.outcome]));

    const output: ExecuteMovePlanOutput = {
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
        moved: countOf(results, "moved"),
        wouldMove: countOf(results, "would_move"),
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
      content: [{ type: "text" as const, text: executeMovePlanText(output).join("\n") }],
    };
  } catch (error) {
    console.error(`execute_move_plan failed for profile "${args.profileId}" and plan "${args.planId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}

function resultFor(item: RenamePlanItem, outcome: MoveItemOutcome): MoveItemResult {
  return {
    path: item.path,
    currentName: item.currentName,
    targetName: item.targetName,
    targetPath: item.targetPath,
    client: item.client,
    outcome,
  };
}

function countOf(results: readonly MoveItemResult[], outcome: MoveItemOutcome): number {
  return results.filter((result) => result.outcome === outcome).length;
}
