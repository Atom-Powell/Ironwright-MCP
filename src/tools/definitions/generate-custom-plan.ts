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
    "Long paths can make the stored-plan size limit refuse a plan of fewer than 100 files; that refusal comes from an estimate made before any ETag lookup.",
    CUSTOM_PLAN_INPUT_CONSTRAINTS,
    "A date-only bound means midnight UTC on that date, and both modifiedAfter and modifiedBefore are exclusive.",
    'Worked examples. Move every PDF in one folder to another: [{"selector": {"folder": "/Client A/2025", "extensions": [".pdf"]}, "moveTo": "/Archive/2025"}].',
    'Add a prefix to everything in a folder modified in 2025: [{"selector": {"folder": "/Client A", "modifiedAfter": "2024-12-31T23:59:59.999Z", "modifiedBefore": "2026-01-01"}, "rename": {"addPrefix": "2025 "}}].',
    'Rename one named file: [{"selector": {"folder": "/Client A", "nameEquals": "draft.docx"}, "rename": {"setName": "Engagement letter.docx"}}].',
    "Returns a plan id that execute_custom_plan consumes. Review the plan before executing it.",
    SAFETY_SENTENCES.plan,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(GENERATE_CUSTOM_PLAN_INPUT_SCHEMA),
  inputConstraints: CUSTOM_PLAN_INPUT_CONSTRAINTS,
  outputSchema: GENERATE_CUSTOM_PLAN_OUTPUT_SCHEMA,
  handler: runGenerateCustomPlan,
};
