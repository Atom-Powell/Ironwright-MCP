import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { INVENTORY_OUTPUT_SCHEMA } from "../inventory/output.js";
import { INVENTORY_INPUT_SCHEMA, runInventoryTree } from "../inventory/run.js";

export const inventoryTree: ToolDefinition = {
  name: "inventory_tree",
  kind: "read",
  title: "Inventory repository tree",
  description: [
    "Return the complete folder and file tree of a configured document library in one call, including path, name, type, size, and modified date for every item.",
    "Uses delta query and batched requests internally instead of a recursive per-folder walk, so a full inventory costs a small bounded number of requests rather than hundreds.",
    "Use this when you need what the repository actually contains. Do not use it to decide whether a required report exists, because a folder can exist while the report is stored elsewhere; use reconcile_workbook_vs_repository for that.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(INVENTORY_INPUT_SCHEMA),
  outputSchema: INVENTORY_OUTPUT_SCHEMA,
  handler: runInventoryTree,
};
