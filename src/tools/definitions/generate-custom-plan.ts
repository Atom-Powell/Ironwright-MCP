import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import {
  CUSTOM_PLAN_INPUT_CONSTRAINTS,
  GENERATE_CUSTOM_PLAN_INPUT_SCHEMA,
  runGenerateCustomPlan,
} from "../custom/generate.js";
import { GENERATE_CUSTOM_PLAN_OUTPUT_SCHEMA } from "../custom/output.js";

export const generateCustomPlan: ToolDefinition = {
  name: "generate_custom_plan",
  kind: "plan",
  title: "Generate a plan from steps you describe",
  description: [
    "Produce a reviewable plan that renames or moves files you describe with selectors, inside the profile's own document library, with no tracking workbook required. Works with a library-only profile or a compliance profile.",
    "Each step selects files by folder, name, extension or modified date, and moves them to an existing folder, renames them with a literal edit, or both. The server resolves every step against its index of the library, so the plan names exact files; file extensions never change.",
    "A request it cannot resolve is refused with evidence and no plan is saved: an unknown folder (with the nearest existing folder and its subfolders), an ambiguous setName, more than 100 files, or nothing matched. A file it cannot safely change is kept in the plan as excluded, with the reason.",
    CUSTOM_PLAN_INPUT_CONSTRAINTS,
    "Returns a plan id that execute_custom_plan consumes. Review the plan before executing it.",
    SAFETY_SENTENCES.plan,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(GENERATE_CUSTOM_PLAN_INPUT_SCHEMA),
  inputConstraints: CUSTOM_PLAN_INPUT_CONSTRAINTS,
  outputSchema: GENERATE_CUSTOM_PLAN_OUTPUT_SCHEMA,
  handler: runGenerateCustomPlan,
};
