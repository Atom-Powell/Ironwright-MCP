import { ProfileSchema } from "../../domain/profile/schema.js";
import type { DomainModule } from "../types.js";
import { describeWorkbook } from "../../tools/definitions/describe-workbook.js";
import { reconcileWorkbookVsRepository } from "../../tools/definitions/reconcile.js";
import { validateStructure } from "../../tools/definitions/validate-structure.js";
import { generateRenamePlan } from "../../tools/definitions/generate-rename-plan.js";
import { executeRenamePlan } from "../../tools/definitions/execute-rename-plan.js";
import { generateMovePlan } from "../../tools/definitions/generate-move-plan.js";
import { executeMovePlan } from "../../tools/definitions/execute-move-plan.js";
import { replicateTemplate } from "../../tools/definitions/replicate-template.js";

/**
 * Recurring-deliverable compliance: the original domain and still the
 * centerpiece. Its definitions stay where phases 4 and 6 put them; this
 * object is the boundary, and a rename-only move can follow.
 */
export const complianceModule: DomainModule = {
  kind: "compliance",
  profileSchema: ProfileSchema,
  tools: [
    describeWorkbook,
    reconcileWorkbookVsRepository,
    validateStructure,
    generateRenamePlan,
    executeRenamePlan,
    generateMovePlan,
    executeMovePlan,
    replicateTemplate,
  ],
};
