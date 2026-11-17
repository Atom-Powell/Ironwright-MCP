import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { GET_INPUT_CONSTRAINTS, GET_INPUT_SCHEMA, GET_OUTPUT_SCHEMA, runGetAssessment } from "../assessment/get.js";

export const getAssessment: ToolDefinition = {
  name: "get_assessment",
  kind: "read",
  title: "Get an assessment",
  description: [
    "Read one assessment by its id: its list fields, whether each artifact is present at its canonical path, what each lifecycle tool's precondition finds on that state, and a summary of its journal, with the recorded findings and every journal entry when include asks for them. Or list every assessment for a vendor, or every assessment holding a status across all vendors, from the Assessments list alone, without reading the drive.",
    GET_INPUT_CONSTRAINTS,
    "An id no item carries is reported as not found, not as an error.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(GET_INPUT_SCHEMA),
  inputConstraints: GET_INPUT_CONSTRAINTS,
  outputSchema: GET_OUTPUT_SCHEMA,
  handler: runGetAssessment,
};
