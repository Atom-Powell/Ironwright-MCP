import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { EXECUTE_MOVE_PLAN_INPUT_SCHEMA, runExecuteMovePlan } from "../move/execute.js";
import { EXECUTE_MOVE_PLAN_OUTPUT_SCHEMA } from "../move/output.js";

export const executeMovePlan: ToolDefinition = {
  name: "execute_move_plan",
  kind: "write",
  title: "Execute a move plan",
  description: [
    "Apply a previously generated move plan by its plan id, writing a reversal log before any change so the batch can be rolled back through this same tool.",
    "Each move carries the ETag recorded at plan time, so a file edited since planning is reported as skipped rather than overwritten, and every untouched file still applies. A move never replaces a file already at its target.",
    "Moves stay within the profile's own document library. Runs as a dry run unless confirm is true. A dry run contacts Graph not at all, so it cannot report which files have changed since the plan was generated.",
    SAFETY_SENTENCES.destructiveWrite,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(EXECUTE_MOVE_PLAN_INPUT_SCHEMA),
  outputSchema: EXECUTE_MOVE_PLAN_OUTPUT_SCHEMA,
  handler: runExecuteMovePlan,
};
