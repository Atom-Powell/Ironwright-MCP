import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { DESCRIBE_OUTPUT_SCHEMA } from "../describe/output.js";
import { DESCRIBE_WORKBOOK_INPUT_SCHEMA, runDescribeWorkbook } from "../describe/run.js";

/**
 * The description does not name the site, although the design spec's case for
 * requiring `IW_SITE_URL` had two halves and this was the second of them.
 *
 * Every tool definition in this registry is a module-level constant, built
 * before `main.ts` has read any configuration, so a description carrying the
 * granted site would have to become a factory taking that value, and the
 * registry with it. The cheaper half of the promise is kept instead: the site
 * is on the response, as `siteUrl`, and it is the first thing this tool's own
 * prose says. A model that calls the tool once learns the site from the
 * answer, which is one call later than the description would have told it and
 * costs a read-only call against a site the grant already covers.
 */
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
