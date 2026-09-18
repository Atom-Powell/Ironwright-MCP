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
   * A full schema rather than a raw shape, so this holds a real
   * `z.object({...})` instead of a bag of per-field schemas with no way to
   * express a shared identity between fields. Measured against MCP SDK
   * 1.30.0 rather than assumed: `registerTool` accepts a `ZodEffects` (the
   * shape `.refine()` or `.superRefine()` produce on top of an object) at
   * registration time without throwing, but that is not the whole story.
   * `listTools`'s conversion to JSON Schema recognizes an object schema only
   * by a bare `.shape` property, which a `ZodEffects` keeps on
   * `.innerType()` instead, so the SDK silently advertises such a tool as
   * `{type: "object", properties: {}}` and every field it declares
   * disappears from what a caller, model included, can see. That is why a
   * `ZodEffects` at this level is forbidden by a test in
   * `tests/tools/contract.test.ts` rather than merely discouraged: keep this
   * a plain `z.object({...})` per tool unless that SDK behavior changes.
   */
  inputSchema: z.ZodTypeAny;
  /**
   * A cross-field constraint the tool's own handler enforces during its own
   * parse, for a check a plain object schema cannot express and a top-level
   * refinement is no longer allowed to express either. No encoding of the
   * advertised schema can show this constraint, so the words belong in the
   * tool's description or a caller has no way to predict the rejection.
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
