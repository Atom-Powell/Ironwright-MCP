import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { RECORD_INPUT_CONSTRAINTS, RECORD_INPUT_SCHEMA, RECORD_OUTPUT_SCHEMA, runRecordFindings } from "../assessment/record-findings.js";

export const recordFindings: ToolDefinition = {
  name: "record_findings",
  kind: "lifecycle",
  title: "Record assessment findings",
  description: [
    "Record an in progress assessment's findings in the Findings list and its summary on the assessment item, once its dossier is present at its canonical path. Each finding is matched on its key within the assessment: a new key creates a list item, a key whose values differ updates that item, and a key already holding the values sent is left unchanged. The summary and stage FINDINGS are then written to the assessment item unless it already holds them.",
    RECORD_INPUT_CONSTRAINTS,
    "A retry with the same keys updates or leaves findings unchanged rather than duplicating them. Two existing items sharing a key are refused rather than chosen between.",
    SAFETY_SENTENCES.lifecycle,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(RECORD_INPUT_SCHEMA),
  inputConstraints: RECORD_INPUT_CONSTRAINTS,
  outputSchema: RECORD_OUTPUT_SCHEMA,
  handler: runRecordFindings,
};
