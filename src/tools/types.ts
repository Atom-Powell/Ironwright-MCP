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
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
  /**
   * Absent means this tool is still a stub. Keeping it optional is what lets
   * the nine unwired tools stay exactly as they are while the tenth becomes
   * real, rather than requiring nine placeholder handlers that each assert
   * something they cannot do.
   */
  handler?: ToolHandler;
}
