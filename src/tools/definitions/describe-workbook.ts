import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { DESCRIBE_OUTPUT_SCHEMA } from "../describe/output.js";
import { DESCRIBE_WORKBOOK_INPUT_SCHEMA, runDescribeWorkbook } from "../describe/run.js";

export const describeWorkbook: ToolDefinition = {
  name: "describe_workbook",
  kind: "read",
  title: "Describe a tracking workbook",
  description: [
    "Inspect a tracking workbook and report what it contains, so a profile's workbookMapping can be written " +
      "from evidence. With no source argument it lists every worksheet and table with its bounds; with one it " +
      "describes that range's header row and columns, including inferred types and a few sample values.",
    "It proposes a source and a header row only when those are unambiguous, and it never guesses which column " +
      "is the client, because those field names are yours and this tool has not seen your deliverables.",
    "Use this before a profile exists, or after a workbook's layout has changed. This tool does not change the " +
      "profile or the workbook.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(DESCRIBE_WORKBOOK_INPUT_SCHEMA),
  outputSchema: DESCRIBE_OUTPUT_SCHEMA,
  handler: runDescribeWorkbook,
};
