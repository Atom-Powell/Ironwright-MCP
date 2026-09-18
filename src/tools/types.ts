import type { z } from "zod";
import type { ToolKind } from "./kinds.js";
import type { ToolHandler } from "./context.js";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  kind: ToolKind;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  /**
   * A full schema rather than a raw shape, because a raw shape is a bag of
   * per-field schemas and structurally cannot express a constraint spanning
   * two fields. `generate_move_plan` needs one: nothing otherwise enforces
   * that `scopeValue` is present when `scope` is `client` or `deliverable`.
   * The SDK accepts either form, so this passes straight through.
   */
  inputSchema: z.ZodTypeAny;
  /**
   * The cross-field constraint, in the words the description uses. Required
   * when `inputSchema` carries a refinement and meaningless otherwise, because
   * a refinement is invisible in the JSON Schema the caller receives.
   */
  inputConstraints?: string;
  outputSchema: z.ZodRawShape;
  /**
   * Absent means this tool is still a stub. Keeping it optional is what lets
   * the nine unwired tools stay exactly as they are while the tenth becomes
   * real, rather than requiring nine placeholder handlers that each assert
   * something they cannot do.
   */
  handler?: ToolHandler;
}
