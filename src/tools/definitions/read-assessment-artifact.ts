import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { READ_INPUT_SCHEMA, READ_OUTPUT_SCHEMA, runReadAssessmentArtifact } from "../assessment/read-artifact.js";

export const readAssessmentArtifact: ToolDefinition = {
  name: "read_assessment_artifact",
  kind: "read",
  title: "Read an assessment artifact",
  description: [
    "Read one artifact of an assessment from the path the profile computes for its kind, returning its text with its size, sha256 and ETag.",
    "Content that does not decode as UTF-8, such as a .docx publication, is reported as an error giving its size and sha256 instead of its text. An id no item carries and a file absent from its path are reported as errors.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(READ_INPUT_SCHEMA),
  outputSchema: READ_OUTPUT_SCHEMA,
  handler: runReadAssessmentArtifact,
};
