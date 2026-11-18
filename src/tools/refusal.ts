/**
 * Where a refusal's structured form rides on a tool result, under `_meta`.
 * Defined beside the tool kinds and not inside a module, because the server
 * builder reads it to tell a refusal from a failure and every module's
 * lifecycle tools write it. src/tools/assessment/refusal.ts says why a refusal
 * is carried there and not as structured content.
 */
export const REFUSAL_META_KEY = "ironwright-mcp/refusal";
