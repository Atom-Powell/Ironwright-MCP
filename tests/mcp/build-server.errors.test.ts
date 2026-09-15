import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../../src/mcp/build-server.js";
import { createFakeToolContext } from "../tools/fake-context.js";
import type { ToolDefinition } from "../../src/tools/types.js";

const FAILING: ToolDefinition = {
  name: "failing_tool",
  kind: "read",
  title: "Failing",
  description: "Always fails. Read-only: this tool makes no changes and is safe to repeat.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { any: z.string().describe("Ignored, for example \"x\".") },
  outputSchema: { required: z.string().describe("Never produced on the error path, for example \"x\".") },
  handler: async () => ({
    isError: true,
    content: [{ type: "text" as const, text: "the thing failed for a reason the operator can act on" }],
  }),
};

describe("a handler that fails", () => {
  it("reaches the client as a tool error rather than a transport fault, despite declaring an output schema", async () => {
    const server = buildServer({ allowWrites: true, context: createFakeToolContext(), tools: [FAILING] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({ name: "failing_tool", arguments: { any: "x" } });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("the operator can act on");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

const WRITE_TOOL: ToolDefinition = {
  name: "writing_tool",
  kind: "write",
  title: "Writing",
  description: "Would change the repository. Not read-only: this tool saves a plan for review.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: { any: z.string().describe("Ignored, for example \"x\".") },
  outputSchema: { done: z.boolean().describe("Always true, for example true.") },
};

const READ_TOOL: ToolDefinition = {
  name: "reading_tool",
  kind: "read",
  title: "Reading",
  description: "Reads the repository. Read-only: this tool makes no changes and is safe to repeat.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { any: z.string().describe("Ignored, for example \"x\".") },
  outputSchema: { done: z.boolean().describe("Always true, for example true.") },
};

describe("the write gate over a caller-supplied tool list", () => {
  it("omits a write tool and keeps a read tool when writes are not allowed", async () => {
    const server = buildServer({
      allowWrites: false,
      context: createFakeToolContext(),
      tools: [WRITE_TOOL, READ_TOOL],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);

      expect(names).not.toContain("writing_tool");
      expect(names).toContain("reading_tool");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
