import { complianceModule } from "./compliance/index.js";
import { assessmentModule } from "./assessment/index.js";
import { libraryModule } from "./library/index.js";
import type { DomainModule } from "./types.js";

export type { DomainModule, ProfileKind } from "./types.js";

/** Module order is tool order in the registry; the contract test pins the names, not the order. */
export const ALL_MODULES: DomainModule[] = [complianceModule, libraryModule, assessmentModule];

export function moduleForKind(kind: string, modules: readonly DomainModule[] = ALL_MODULES): DomainModule | undefined {
  return modules.find((m) => m.kind === kind);
}
