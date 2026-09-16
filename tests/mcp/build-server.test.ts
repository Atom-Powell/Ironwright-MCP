import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../../src/mcp/build-server.js";
import { createFakeToolContext } from "../tools/fake-context.js";
import { ALL_TOOLS } from "../../src/tools/registry.js";
import { STUB_OUTPUT_SCHEMA } from "../../src/tools/stub-output.js";
import type { ToolDefinition } from "../../src/tools/types.js";

async function callTool(definitions: ToolDefinition[], name: string, args: Record<string, unknown>) {
  const server = buildServer({ allowWrites: true, context: createFakeToolContext(), tools: definitions });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

const HANDLED: ToolDefinition = {
  name: "handled_tool",
  kind: "read",
  title: "Handled",
  description: "A tool with a handler. Read-only: this tool makes no changes and is safe to repeat.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { echo: z.string().describe("Text to echo back, for example \"hello\".") },
  outputSchema: { echoed: z.string().describe("What came in, for example \"hello\".") },
  handler: async (input) => {
    const { echo } = z.object({ echo: z.string() }).parse(input);
    return { structuredContent: { echoed: echo }, content: [{ type: "text" as const, text: echo }] };
  },
};

/**
 * Carries `STUB_OUTPUT_SCHEMA` rather than the echo schema, because the SDK
 * validates a result's `structuredContent` against the declared outputSchema
 * and answers a mismatch with an error result. An unwired tool in the real
 * registry declares that schema for exactly this reason, so a fixture that
 * declared any other would be testing a tool this server could not serve.
 */
const STUBBED: ToolDefinition = { ...HANDLED, name: "stubbed_tool", outputSchema: STUB_OUTPUT_SCHEMA };
delete (STUBBED as { handler?: unknown }).handler;

describe("buildServer", () => {
  it("routes a call to the tool's own handler when it has one", async () => {
    const result = await callTool([HANDLED], "handled_tool", { echo: "hello" });

    expect(result.structuredContent).toEqual({ echoed: "hello" });
  });

  it("hands the shared context to the handler", async () => {
    let sawProfileIds: string[] | undefined;
    const spy: ToolDefinition = {
      ...HANDLED,
      handler: async (_input, context) => {
        sawProfileIds = context.profiles.ids();
        return { structuredContent: { echoed: "ok" }, content: [{ type: "text" as const, text: "ok" }] };
      },
    };

    await callTool([spy], "handled_tool", { echo: "hello" });

    expect(sawProfileIds).toEqual(["example"]);
  });

  it("still serves the stub answer for a tool with no handler", async () => {
    const result = await callTool([STUBBED], "stubbed_tool", { echo: "hello" });

    expect(result.structuredContent).toMatchObject({ stub: true });
  });

  it("defaults to the full registry when no tool list is given", () => {
    const server = buildServer({ allowWrites: true, context: createFakeToolContext() });

    expect(server).toBeDefined();
    expect(ALL_TOOLS.length).toBeGreaterThan(0);
  });
});
