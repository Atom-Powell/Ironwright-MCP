import type { ToolDefinition } from "./types.js";
import { inventoryTree } from "./definitions/inventory-tree.js";
import { describeWorkbook } from "./definitions/describe-workbook.js";
import { reconcileWorkbookVsRepository } from "./definitions/reconcile.js";
import { queryRepository } from "./definitions/query-repository.js";
import { validateStructure } from "./definitions/validate-structure.js";
import { generateRenamePlan } from "./definitions/generate-rename-plan.js";
import { executeRenamePlan } from "./definitions/execute-rename-plan.js";
import { generateMovePlan } from "./definitions/generate-move-plan.js";
import { executeMovePlan } from "./definitions/execute-move-plan.js";
import { generateCustomPlan } from "./definitions/generate-custom-plan.js";
import { replicateTemplate } from "./definitions/replicate-template.js";

export type { ToolAnnotations, ToolDefinition } from "./types.js";

export const ALL_TOOLS: ToolDefinition[] = [
  inventoryTree,
  describeWorkbook,
  reconcileWorkbookVsRepository,
  queryRepository,
  validateStructure,
  generateRenamePlan,
  executeRenamePlan,
  generateMovePlan,
  executeMovePlan,
  generateCustomPlan,
  replicateTemplate,
];

/**
 * Write tools are omitted rather than registered and refused. A refusal leaves a
 * model that still believes the capability exists and retries differently; an
 * absent tool is simply not in its options.
 *
 * `source` exists so this is the only place the write predicate is written
 * down. `buildServer` accepts a caller-supplied tool list and must gate that
 * list too, and expressing the gate a second time there would give a security
 * boundary two definitions that can drift apart, each looking correct beside
 * its own tests. A caller passing its own list is choosing which tools exist,
 * never whether the gate applies.
 */
export function selectTools(allowWrites: boolean, source: readonly ToolDefinition[] = ALL_TOOLS): ToolDefinition[] {
  return allowWrites ? [...source] : source.filter((tool) => tool.kind !== "write");
}
