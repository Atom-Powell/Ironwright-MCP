import { LibraryProfileSchema } from "../../domain/profile/library.js";
import type { DomainModule } from "../types.js";
import { inventoryTree } from "../../tools/definitions/inventory-tree.js";
import { queryRepository } from "../../tools/definitions/query-repository.js";
import { generateCustomPlan } from "../../tools/definitions/generate-custom-plan.js";
import { executeCustomPlan } from "../../tools/definitions/execute-custom-plan.js";

/**
 * A site and a library with no compliance definition. Owns the tools that
 * work over any site profile; compliance profiles use them too.
 */
export const libraryModule: DomainModule = {
  kind: "library",
  profileSchema: LibraryProfileSchema,
  tools: [inventoryTree, queryRepository, generateCustomPlan, executeCustomPlan],
};
