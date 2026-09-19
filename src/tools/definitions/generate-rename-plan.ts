import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { z } from "zod";
import { GENERATE_RENAME_PLAN_INPUT_SCHEMA, runGenerateRenamePlan } from "../rename/generate.js";
import { GENERATE_RENAME_PLAN_OUTPUT_SCHEMA } from "../rename/output.js";

export const generateRenamePlan: ToolDefinition = {
  name: "generate_rename_plan",
  kind: "plan",
  title: "Generate a rename plan",
  description: [
    "Produce a reviewable plan that renames files violating the profile's filename standard, one entry per file, each recording the current name, the proposed name, and the file's ETag fetched at plan time.",
    "Files whose canonical name is already taken, or that two files would both claim, are recorded as excluded rather than attempted.",
    "Returns a plan id that execute_rename_plan consumes. Review the plan before executing it.",
    SAFETY_SENTENCES.plan,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(GENERATE_RENAME_PLAN_INPUT_SCHEMA),
  outputSchema: GENERATE_RENAME_PLAN_OUTPUT_SCHEMA,
  handler: runGenerateRenamePlan,
};
