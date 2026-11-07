import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Precondition } from "../../domain/assessment/state.js";

/**
 * A structured refusal, isError with the evidence as prose and as structured
 * content. The SDK skips output validation on an error result (pinned by
 * tests/mcp/build-server.errors.test.ts), so the refusal shape rides along
 * without widening every tool's output schema.
 */
export function refusalResult(tool: string, stage: string, assessmentId: string, check: Precondition & { ok: false }): CallToolResult {
  const evidence = check.evidence.map((item) => `${item.source} ${item.target}: ${item.found}`).join("; ");
  return {
    isError: true,
    structuredContent: { refused: true, tool, stage, assessmentId, expected: check.expected, observed: check.observed, evidence: check.evidence },
    content: [
      {
        type: "text" as const,
        text: `${tool} refused the ${stage} stage for ${assessmentId}: expected ${check.expected}, observed ${check.observed}. Read to decide: ${evidence}. Nothing was written.`,
      },
    ],
  };
}
