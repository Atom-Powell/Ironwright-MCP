import type { ToolDefinition } from "./types.js";
import { inventoryTree } from "./definitions/inventory-tree.js";
import { generateRenamePlan } from "./definitions/generate-rename-plan.js";
import { executeRenamePlan } from "./definitions/execute-rename-plan.js";

export type { ToolAnnotations, ToolDefinition } from "./types.js";

export const ALL_TOOLS: ToolDefinition[] = [inventoryTree, generateRenamePlan, executeRenamePlan];

/**
 * Write tools are omitted rather than registered and refused. A refusal leaves a
 * model that still believes the capability exists and retries differently; an
 * absent tool is simply not in its options.
 */
export function selectTools(allowWrites: boolean): ToolDefinition[] {
  return allowWrites ? ALL_TOOLS : ALL_TOOLS.filter((tool) => tool.kind !== "write");
}
