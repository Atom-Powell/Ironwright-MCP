import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { OPEN_INPUT_SCHEMA, OPEN_OUTPUT_SCHEMA, runOpenAssessment } from "../assessment/open.js";

export const openAssessment: ToolDefinition = {
  name: "open_assessment",
  kind: "lifecycle",
  title: "Open an assessment",
  description: [
    "Start an assessment for a vendor and scope, or return the one already in progress for that pair. Creates the vendor record if absent, creates the assessment item, renders the assessment id from the item id and writes it back, then creates the workspace root and its subfolders at the paths the profile computes, reading everything back.",
    "Call this once at the ID stage. Calling it again for the same vendor and scope returns the open assessment and creates nothing.",
    SAFETY_SENTENCES.lifecycle,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(OPEN_INPUT_SCHEMA),
  outputSchema: OPEN_OUTPUT_SCHEMA,
  handler: runOpenAssessment,
};
