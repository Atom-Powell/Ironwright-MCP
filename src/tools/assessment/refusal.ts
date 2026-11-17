import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Precondition } from "../../domain/assessment/state.js";

/** Where a refusal's structured form rides on the result. */
export const REFUSAL_META_KEY = "ironwright-mcp/refusal";

/**
 * A structured refusal: isError, with the evidence as prose and, for a caller
 * that wants to read it as data, under `_meta`.
 *
 * It is not carried as structured content. A tool's structured content is
 * what its output schema describes, and a refusal is not that shape. The SDK
 * server skips output validation on an error result (pinned by
 * tests/mcp/build-server.errors.test.ts), which is why the refusal once rode
 * there; the SDK client does not skip it. A client that has listed the tools
 * validates any structured content against the tool's output schema, error or
 * not, and threw away a refusal as a schema fault. Found 2026-11-17 by the
 * first run of this server against a client that lists tools first, which
 * every agent host does. tests/tools/assessment/refusal-wire.errors.test.ts
 * pins what such a client receives.
 */
export function refusalResult(tool: string, stage: string, assessmentId: string, check: Precondition & { ok: false }): CallToolResult {
  const evidence = check.evidence.map((item) => `${item.source} ${item.target}: ${item.found}`).join("; ");
  return {
    isError: true,
    _meta: { [REFUSAL_META_KEY]: { refused: true, tool, stage, assessmentId, expected: check.expected, observed: check.observed, evidence: check.evidence } },
    content: [
      {
        type: "text" as const,
        text: `${tool} refused the ${stage} stage for ${assessmentId}: expected ${check.expected}, observed ${check.observed}. Read to decide: ${evidence}. Nothing was written.`,
      },
    ],
  };
}
