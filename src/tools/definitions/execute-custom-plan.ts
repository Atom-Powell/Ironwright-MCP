import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { EXECUTE_CUSTOM_PLAN_INPUT_SCHEMA, runExecuteCustomPlan } from "../custom/execute.js";
import { EXECUTE_CUSTOM_PLAN_OUTPUT_SCHEMA } from "../custom/output.js";

export const executeCustomPlan: ToolDefinition = {
  name: "execute_custom_plan",
  kind: "write",
  title: "Execute a plan from steps you described",
  description: [
    "Apply a previously generated plan from generate_custom_plan by its plan id, writing a reversal log before any change so the batch can be rolled back through this same tool.",
    "Each write carries the ETag recorded at plan time, so a file changed since planning is refused on that precondition and reported, and the rest of the plan still applies. A move never replaces a file already at its target.",
    "Renames and moves stay inside the profile's own document library. Works with a library-only profile or a compliance profile, the same as generate_custom_plan.",
    "Runs as a dry run unless confirm is true. A dry run contacts Graph not at all, so it cannot report which files have changed since the plan was generated.",
    SAFETY_SENTENCES.destructiveWrite,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(EXECUTE_CUSTOM_PLAN_INPUT_SCHEMA),
  outputSchema: EXECUTE_CUSTOM_PLAN_OUTPUT_SCHEMA,
  handler: runExecuteCustomPlan,
};
