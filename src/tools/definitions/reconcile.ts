import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { RECONCILE_OUTPUT_SCHEMA } from "../reconciliation/output.js";
import { RECONCILE_INPUT_SCHEMA, runReconcile } from "../reconciliation/run.js";

export const reconcileWorkbookVsRepository: ToolDefinition = {
  name: "reconcile_workbook_vs_repository",
  kind: "read",
  title: "Reconcile workbook against repository",
  description: [
    "Compare what the tracking workbook says should exist against what the repository actually contains, and return a per-client gap report classifying every expected deliverable as compliant, misnamed, misplaced, both, or missing, plus any orphaned files and empty folders.",
    "This is the primary tool for compliance questions. Use it instead of inventory_tree whenever the question is whether required reports exist, because a folder can exist while its report is stored somewhere else entirely.",
    "Compliant deliverables are summarized in the per-client counts rather than listed one by one. The counts are complete and are the authoritative answer to whether a client is compliant.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: RECONCILE_INPUT_SCHEMA,
  outputSchema: RECONCILE_OUTPUT_SCHEMA,
  handler: runReconcile,
};
