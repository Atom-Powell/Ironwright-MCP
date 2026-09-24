import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { GENERATE_MOVE_PLAN_INPUT_SCHEMA, runGenerateMovePlan } from "../move/generate.js";
import { GENERATE_MOVE_PLAN_OUTPUT_SCHEMA } from "../move/output.js";

export const generateMovePlan: ToolDefinition = {
  name: "generate_move_plan",
  kind: "plan",
  title: "Generate a move plan",
  description: [
    "Produce a reviewable plan that moves files filed in the wrong folder of the profile's own library into the folder the taxonomy requires, one entry per file, each recording the current path, the target path, and the file's ETag fetched at plan time. A file that is also misnamed is renamed by the same write.",
    "A file this server cannot move safely is recorded as excluded, with the reason, rather than attempted: it was found in a different document library, its target folder does not exist, its canonical path is already spoken for, or it had no usable ETag precondition when the plan was generated.",
    "Returns a plan id that execute_move_plan consumes. Review the plan before executing it.",
    SAFETY_SENTENCES.plan,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(GENERATE_MOVE_PLAN_INPUT_SCHEMA),
  outputSchema: GENERATE_MOVE_PLAN_OUTPUT_SCHEMA,
  handler: runGenerateMovePlan,
};
