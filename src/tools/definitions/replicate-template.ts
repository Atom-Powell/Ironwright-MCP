import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const replicateTemplate: ToolDefinition = {
  name: "replicate_template",
  kind: "write",
  title: "Replicate a client folder structure",
  description: [
    "Copy a validated client's folder structure onto other clients, creating only the folders that are missing and leaving existing folders and all file content untouched.",
    "Validates the source client internally first and refuses to run when the source is itself non-compliant, so a bad structure cannot be propagated. Runs as a dry run unless confirm is true.",
    SAFETY_SENTENCES.additiveWrite,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to operate on, for example \"example\"."),
    sourceClient: z
      .string()
      .min(1)
      .describe("Client whose structure is the template, for example \"CLIENTB\". Must pass validate_structure."),
    targetClients: z
      .array(z.string().min(1))
      .min(1)
      .describe("Clients to apply the structure to, for example [\"CLIENTA\"]."),
    confirm: z
      .boolean()
      .default(false)
      .describe("Set true to create folders for real, for example true. Leave false or omit for a dry run."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
