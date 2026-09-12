import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const executeRenamePlan: ToolDefinition = {
  name: "execute_rename_plan",
  kind: "write",
  title: "Execute a rename plan",
  description: [
    "Apply a previously generated rename plan by its plan id, writing a reversal log before any change so the batch can be rolled back through this same tool.",
    "Each rename carries the ETag recorded at plan time, so a file edited since planning is reported as skipped rather than overwritten.",
    "Runs as a dry run unless confirm is true.",
    SAFETY_SENTENCES.destructiveWrite,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    planId: z.string().min(1).describe("Plan id returned by generate_rename_plan, for example \"rnm-2026-09-11-a3f2\"."),
    confirm: z
      .boolean()
      .default(false)
      .describe("Set true to apply the plan for real, for example true. Leave false or omit for a dry run."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
