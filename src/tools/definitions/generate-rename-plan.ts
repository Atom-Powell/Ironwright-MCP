import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const generateRenamePlan: ToolDefinition = {
  name: "generate_rename_plan",
  kind: "plan",
  title: "Generate a rename plan",
  description: [
    "Produce a reviewable plan that renames files violating the profile's filename standard, one entry per file, each recording the current name, the proposed name, and the file's current ETag.",
    "Returns a plan id that execute_rename_plan consumes. Review the plan before executing it.",
    SAFETY_SENTENCES.plan,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to plan against, for example \"example\"."),
    clients: z
      .array(z.string().min(1))
      .optional()
      .describe("Limit the plan to these clients, for example [\"CLIENTA\"]. Omit to cover every client in the workbook."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
