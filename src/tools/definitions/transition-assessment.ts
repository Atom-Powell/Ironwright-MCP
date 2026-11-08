import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { TRANSITION_INPUT_CONSTRAINTS, TRANSITION_INPUT_SCHEMA, TRANSITION_OUTPUT_SCHEMA, runTransitionAssessment } from "../assessment/transition.js";

export const transitionAssessment: ToolDefinition = {
  name: "transition_assessment",
  kind: "lifecycle",
  title: "Transition an assessment",
  description: [
    "Move an in progress assessment to the profile's completed or provisional status with a disposition and an overall risk, writing stage LIFECYCLE, then read the item back and compare status, disposition and risk with what was written. Completed needs the dossier and the publication present at their canonical paths; provisional needs only the dossier.",
    TRANSITION_INPUT_CONSTRAINTS,
    "When the item already holds the target status, disposition and risk, the transition is reported as already made and nothing is written.",
    SAFETY_SENTENCES.lifecycle,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(TRANSITION_INPUT_SCHEMA),
  inputConstraints: TRANSITION_INPUT_CONSTRAINTS,
  outputSchema: TRANSITION_OUTPUT_SCHEMA,
  handler: runTransitionAssessment,
};
