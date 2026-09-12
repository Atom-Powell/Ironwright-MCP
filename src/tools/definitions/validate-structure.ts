import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const validateStructure: ToolDefinition = {
  name: "validate_structure",
  kind: "read",
  title: "Validate client folder structure",
  description: [
    "Check one or more clients against the profile's folder taxonomy and filename standard, returning compliant, non-compliant, or missing along with the specific folders and files responsible for the verdict.",
    "Use this to confirm a client is a safe template source before replicating its structure elsewhere.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to validate against, for example \"example\"."),
    clients: z
      .array(z.string().min(1))
      .optional()
      .describe("Clients to validate, for example [\"CLIENTA\"]. Omit to validate every client in the workbook."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
