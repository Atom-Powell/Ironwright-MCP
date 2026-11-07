import type { z } from "zod";
import type { ProfileKind } from "../domain/profile/base.js";
import type { ToolDefinition } from "../tools/types.js";

export type { ProfileKind };

/**
 * One domain, as the core sees it: which profile kind it owns, how to
 * validate that kind, and which tools it registers. The core knows nothing
 * else about a domain. A tool may accept profiles of other kinds (inventory
 * works over a compliance profile too); ownership here is about which module
 * registers it, and acceptance is declared per tool and pinned by
 * tests/tools/profile-kinds.test.ts.
 */
export interface DomainModule {
  kind: ProfileKind;
  profileSchema: z.ZodTypeAny;
  tools: ToolDefinition[];
}
