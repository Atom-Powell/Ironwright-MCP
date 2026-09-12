import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const generateMovePlan: ToolDefinition = {
  name: "generate_move_plan",
  kind: "plan",
  title: "Generate a move plan",
  description: [
    "Produce a reviewable plan that relocates misplaced files into the folder the profile taxonomy requires, one entry per file, each recording the current path, the target path, and the file's current ETag.",
    "Returns a plan id that execute_move_plan consumes. Review the plan before executing it.",
    SAFETY_SENTENCES.plan,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to plan against, for example \"example\"."),
    scope: z
      .enum(["all", "client", "deliverable"])
      .default("all")
      .describe("How to narrow the plan, for example \"client\"."),
    scopeValue: z
      .string()
      .min(1)
      .optional()
      .describe("Value for the chosen scope, for example \"CLIENTA\" when scope is \"client\". Omit when scope is \"all\"."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
