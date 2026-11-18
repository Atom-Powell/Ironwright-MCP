import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { TRANSITION_INPUT_CONSTRAINTS, TRANSITION_INPUT_SCHEMA, TRANSITION_OUTPUT_SCHEMA, runTransitionAssessment } from "../assessment/transition.js";

export const transitionAssessment: ToolDefinition = {
  name: "transition_assessment",
  kind: "lifecycle",
  title: "Transition an assessment",
  description: [
    "Move an assessment to the profile's completed or provisional status with a disposition and an overall risk, writing stage LIFECYCLE, then read the item back and compare status, disposition and risk with what was written. Completed is reached from in progress or from provisional and needs every artifact the profile's completed gate names present at its canonical path, by default the dossier and the publication; provisional is reached from in progress and needs those its provisional gate names, by default the dossier. An item that changed after the tool read it is refused with that as the evidence, and nothing is written.",
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
