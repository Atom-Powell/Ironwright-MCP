import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PlanKind, StoredPlan } from "../../store/types.js";

export function noPlanStored(planId: string, profileId: string, generator: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `No plan "${planId}" is stored for profile "${profileId}". Generate one with ` +
          `${generator} and pass the id it returns. Nothing was changed.`,
      },
    ],
  };
}

/**
 * One reviewed tool name corresponds to one kind of write. Applying a move
 * plan through execute_rename_plan would work mechanically, since both run
 * the same executor, and that is exactly why it is refused: an operator who
 * approved "execute a rename plan" did not approve moving files.
 */
export function wrongPlanKind(plan: StoredPlan, expected: PlanKind): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `Plan "${plan.planId}" is a ${plan.kind} plan, and this tool applies only ${expected} plans. Apply it ` +
          `with execute_${plan.kind}_plan instead. Nothing was changed.`,
      },
    ],
  };
}
