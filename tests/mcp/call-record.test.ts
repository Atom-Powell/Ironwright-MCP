import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer, formatToolCallRecord, type ToolCallRecord } from "../../src/mcp/build-server.js";
import { REFUSAL_META_KEY } from "../../src/tools/assessment/refusal.js";
import { createFakeToolContext } from "../tools/fake-context.js";
import type { ToolDefinition } from "../../src/tools/types.js";
import type { ToolHandler } from "../../src/tools/context.js";

function tool(handler: ToolHandler): ToolDefinition {
  return {
    name: "recorded_tool",
    kind: "lifecycle",
    title: "Recorded",
    description: "A tool whose calls are recorded.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      profileId: z.string().describe('For example "vendor-assessments".'),
      assessmentId: z.string().optional().describe('For example "ASM-2026-00002".'),
      content: z.string().optional().describe('For example "text".'),
    }),
    outputSchema: {
      assessmentId: z.string().optional().describe('For example "ASM-2026-00002".'),
      correlationId: z.string().optional().describe('For example "6f1c".'),
      graphRequests: z.number().int().optional().describe("For example 4."),
    },
    handler,
  };
}

async function call(handler: ToolHandler, args: Record<string, unknown>, onToolCall: (record: ToolCallRecord) => void) {
  // The fake context's registry holds one profile, "example".
  const server = buildServer({ allowWrites: true, context: createFakeToolContext(), tools: [tool(handler)], onToolCall });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name: "recorded_tool", arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

const KNOWN_PROFILE = "example";
const ok: ToolHandler = async () => ({ structuredContent: { assessmentId: "ASM-2026-00002", correlationId: "c-1", graphRequests: 4 }, content: [{ type: "text" as const, text: "done" }] });

describe("the record of a tool call", () => {
  it("names the tool, its kind, the profile, the assessment, the outcome and what the call cost", async () => {
    const records: ToolCallRecord[] = [];
    await call(ok, { profileId: KNOWN_PROFILE, assessmentId: "asm-2026-00002" }, (record) => records.push(record));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool: "recorded_tool",
      kind: "lifecycle",
      outcome: "ok",
      profileId: KNOWN_PROFILE,
      // The id the tool answered with, not the caller's spelling of it.
      assessmentId: "ASM-2026-00002",
      correlationId: "c-1",
      graphRequests: 4,
    });
    expect(records[0]!.ms).toBeGreaterThanOrEqual(0);
    expect(records[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("carries nothing else the caller sent or the tool answered", async () => {
    const records: ToolCallRecord[] = [];
    await call(ok, { profileId: KNOWN_PROFILE, content: "the dossier text, which is the customer's" }, (record) => records.push(record));

    expect(JSON.stringify(records)).not.toContain("dossier text");
    expect(JSON.stringify(records)).not.toContain("done");
    expect(Object.keys(records[0]!).sort()).toEqual(["assessmentId", "at", "correlationId", "graphRequests", "kind", "ms", "outcome", "profileId", "tool"]);
  });

  it("does not repeat a profile id or an assessment id the server does not know, since either field can hold any text", async () => {
    const records: ToolCallRecord[] = [];
    const notFound: ToolHandler = async () => ({ isError: true, content: [{ type: "text" as const, text: "no such assessment" }] });

    await call(notFound, { profileId: "Acme Corp, the vendor", assessmentId: "Acme Corp security review" }, (record) => records.push(record));

    expect(JSON.stringify(records)).not.toContain("Acme");
    expect(records[0]).not.toHaveProperty("profileId");
    expect(records[0]).not.toHaveProperty("assessmentId");
  });

  it("tells a refusal from a failure, and both from a handler that threw", async () => {
    const records: ToolCallRecord[] = [];
    const sink = (record: ToolCallRecord): void => void records.push(record);
    const refused: ToolHandler = async () => ({ isError: true, _meta: { [REFUSAL_META_KEY]: { refused: true } }, content: [{ type: "text" as const, text: "refused" }] });
    const failed: ToolHandler = async () => ({ isError: true, content: [{ type: "text" as const, text: "failed" }] });
    const threw: ToolHandler = async () => {
      throw new Error("a bug");
    };

    await call(refused, { profileId: "p" }, sink);
    await call(failed, { profileId: "p" }, sink);
    const thrown = await call(threw, { profileId: "p" }, sink);

    expect(records.map((record) => record.outcome)).toEqual(["refused", "error", "threw"]);
    // The SDK turns a throw into an error result; the record does not change what the caller receives.
    expect(thrown.isError).toBe(true);
  });

  it("does not let a sink that throws change the tool's answer", async () => {
    const result = await call(ok, { profileId: "p" }, () => {
      throw new Error("the log pipe is closed");
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ assessmentId: "ASM-2026-00002", correlationId: "c-1", graphRequests: 4 });
  });

  it("formats as one line of JSON an operator can filter on", () => {
    const line = formatToolCallRecord({ at: "2026-11-17T09:00:00.000Z", tool: "open_assessment", kind: "lifecycle", outcome: "ok", ms: 412, profileId: "vendor-assessments", graphRequests: 14 });
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      event: "tool_call", at: "2026-11-17T09:00:00.000Z", tool: "open_assessment", kind: "lifecycle", outcome: "ok", ms: 412, profileId: "vendor-assessments", graphRequests: 14,
    });
  });
});
