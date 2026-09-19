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
    "A file this server cannot rename safely is recorded as excluded, with the reason, rather than attempted: either its canonical name is already spoken for, by a file sitting there or by another file that would also claim it or has already satisfied the slot, or the file had no usable ETag precondition when the plan was generated, because Graph returned none for it or it was no longer at its path.",
    "Returns a plan id that execute_rename_plan consumes. Review the plan before executing it.",
    SAFETY_SENTENCES.plan,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(GENERATE_RENAME_PLAN_INPUT_SCHEMA),
  outputSchema: GENERATE_RENAME_PLAN_OUTPUT_SCHEMA,
  handler: runGenerateRenamePlan,
};
