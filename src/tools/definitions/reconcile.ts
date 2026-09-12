import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const reconcileWorkbookVsRepository: ToolDefinition = {
  name: "reconcile_workbook_vs_repository",
  kind: "read",
  title: "Reconcile workbook against repository",
  description: [
    "Compare what the tracking workbook says should exist against what the repository actually contains, and return a per-client gap report classifying every expected deliverable as compliant, misnamed, misplaced, both, or missing, plus any orphaned files and empty folders.",
    "This is the primary tool for compliance questions. Use it instead of inventory_tree whenever the question is whether required reports exist, because a folder can exist while its report is stored somewhere else entirely.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to reconcile, for example \"example\"."),
    clients: z
      .array(z.string().min(1))
      .optional()
      .describe("Limit the report to these clients, for example [\"CLIENTA\"]. Omit to cover every client in the workbook."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
