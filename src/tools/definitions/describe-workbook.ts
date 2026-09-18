import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const describeWorkbook: ToolDefinition = {
  name: "describe_workbook",
  kind: "read",
  title: "Describe a tracking workbook",
  description: [
    "Inspect a tracking workbook and propose a candidate profile mapping, reporting the worksheets, tables, named ranges, detected header rows, and inferred column types it found.",
    "Use this when onboarding a new repository or when a workbook's layout has changed. The proposal is for a human to review and commit as profile configuration; this tool does not change the profile.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object({
    siteUrl: z
      .string()
      .url()
      .describe("Site holding the workbook, for example \"https://contoso.sharepoint.com/sites/Example\"."),
    workbookPath: z
      .string()
      .startsWith("/")
      .describe("Library-relative path to the workbook, for example \"/Trackers/Operational Tracking Workbook.xlsx\"."),
  }),
  outputSchema: STUB_OUTPUT_SCHEMA,
};
