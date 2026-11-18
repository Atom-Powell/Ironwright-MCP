import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { SAVE_INPUT_SCHEMA, SAVE_OUTPUT_SCHEMA, runSaveAssessmentArtifact } from "../assessment/save-artifact.js";

export const saveAssessmentArtifact: ToolDefinition = {
  name: "save_assessment_artifact",
  kind: "lifecycle",
  title: "Save an assessment artifact",
  description: [
    "Persist an artifact's full text for an assessment in progress whose workspace root exists. Creates the file at the path the profile computes for the kind, or, when a file is already there, reads it and overwrites it under the ETag it just read; then reads the file back and compares its hash with what was sent before recording the stage on the assessment. When the file already holds exactly this content, nothing is written, the State column included, and the result reports unchanged. A folder between the workspace root and the file that is missing is created first, journaled, and named in the result.",
    "The stage recorded is the kind upper cased, and CORRECTION when a kind the profile lists as corrected is overwritten, by default the dossier. A kind the profile lists as external is refused, by default the publication: it is produced outside this server and verify_publication checks it. Content is capped at 4 MiB encoded.",
    SAFETY_SENTENCES.lifecycle,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(SAVE_INPUT_SCHEMA),
  outputSchema: SAVE_OUTPUT_SCHEMA,
  handler: runSaveAssessmentArtifact,
};
