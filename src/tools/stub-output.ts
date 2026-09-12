import { z } from "zod";

/**
 * Shared placeholder output. Every tool declares a real outputSchema from the
 * start so callers always receive structuredContent, and later phases replace
 * this one tool at a time rather than adding output contracts retroactively.
 */
export const STUB_OUTPUT_SCHEMA = {
  stub: z.literal(true).describe("Always true until this tool is implemented, for example true."),
  message: z
    .string()
    .describe("Note explaining that the tool is registered but not implemented, for example \"this tool is not implemented yet\"."),
} satisfies z.ZodRawShape;
