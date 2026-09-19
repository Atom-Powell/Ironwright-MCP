import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { EXECUTE_RENAME_PLAN_INPUT_SCHEMA, runExecuteRenamePlan } from "../rename/execute.js";
import { EXECUTE_RENAME_PLAN_OUTPUT_SCHEMA } from "../rename/output.js";

export const executeRenamePlan: ToolDefinition = {
  name: "execute_rename_plan",
  kind: "write",
  title: "Execute a rename plan",
  description: [
    "Apply a previously generated rename plan by its plan id, writing a reversal log before any change so the batch can be rolled back through this same tool.",
    "Each rename carries the ETag recorded at plan time, so a file edited since planning is reported as skipped rather than overwritten, and every untouched file still applies.",
    "Runs as a dry run unless confirm is true. A dry run contacts Graph not at all, so it cannot report which files have changed since the plan was generated.",
    SAFETY_SENTENCES.destructiveWrite,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(EXECUTE_RENAME_PLAN_INPUT_SCHEMA),
  outputSchema: EXECUTE_RENAME_PLAN_OUTPUT_SCHEMA,
  handler: runExecuteRenamePlan,
};
