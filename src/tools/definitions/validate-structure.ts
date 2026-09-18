import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { VALIDATE_STRUCTURE_OUTPUT_SCHEMA } from "../validate/output.js";
import { VALIDATE_STRUCTURE_INPUT_SCHEMA, runValidateStructure } from "../validate/run.js";

export const validateStructure: ToolDefinition = {
  name: "validate_structure",
  kind: "read",
  title: "Validate client folder structure",
  description: [
    "Check one or more clients against the profile's folder taxonomy and filename standard, returning compliant, non-compliant, or missing along with the specific folders and files responsible for the verdict.",
    "Use this to confirm a client is a safe template source before replicating its structure elsewhere.",
    "It reports whether what exists is shaped correctly, not whether everything that should exist is present; use reconcile_workbook_vs_repository for that, because only the workbook says what is owed.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(VALIDATE_STRUCTURE_INPUT_SCHEMA),
  outputSchema: VALIDATE_STRUCTURE_OUTPUT_SCHEMA,
  handler: runValidateStructure,
};
