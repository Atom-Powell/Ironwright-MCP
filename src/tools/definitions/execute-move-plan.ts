import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const executeMovePlan: ToolDefinition = {
  name: "execute_move_plan",
  kind: "write",
  title: "Execute a move plan",
  description: [
    "Apply a previously generated move plan by its plan id, writing a reversal log before any change so the batch can be rolled back through this same tool.",
    "Each move carries the ETag recorded at plan time, so a file edited since planning is reported as skipped rather than overwritten. Moves that cross document libraries complete asynchronously and are polled to a final state, so per-item status is reported rather than assumed.",
    "Runs as a dry run unless confirm is true.",
    SAFETY_SENTENCES.destructiveWrite,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object({
    planId: z.string().min(1).describe("Plan id returned by generate_move_plan, for example \"mov-2026-09-11-71bc\"."),
    confirm: z
      .boolean()
      .default(false)
      .describe("Set true to apply the plan for real, for example true. Leave false or omit for a dry run."),
  }),
  outputSchema: STUB_OUTPUT_SCHEMA,
};
