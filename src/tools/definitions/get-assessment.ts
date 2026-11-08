import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { GET_INPUT_CONSTRAINTS, GET_INPUT_SCHEMA, GET_OUTPUT_SCHEMA, runGetAssessment } from "../assessment/get.js";

export const getAssessment: ToolDefinition = {
  name: "get_assessment",
  kind: "read",
  title: "Get an assessment",
  description: [
    "Read one assessment by its id, with its list fields, whether each artifact is present at its canonical path, and a summary of its journal; or list every assessment for a vendor from the Assessments list alone, without reading the drive.",
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
