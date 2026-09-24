import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../../src/server/app.js";
import { buildServer } from "../../src/mcp/build-server.js";
import { createFakeToolContext } from "../tools/fake-context.js";

let httpServer: Server | undefined;

async function startServer(allowWrites: boolean): Promise<URL> {
  const app = createApp({ serverFactory: () => buildServer({ allowWrites, context: createFakeToolContext() }) });
  httpServer = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function listToolNames(baseUrl: URL): Promise<string[]> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(baseUrl));
  const listed = await client.listTools();
  await client.close();
  return listed.tools.map((tool) => tool.name);
}

afterEach(async () => {
  if (httpServer !== undefined) {
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    httpServer = undefined;
  }
});

describe("write gate over the wire", () => {
  it("does not advertise write tools when writes are disabled", async () => {
    const names = await listToolNames(await startServer(false));

    // The count, not only the names: a write tool that slipped through under a
    // name nobody thought to assert on would pass every check below.
    expect(names).toHaveLength(8);
    expect(names).toContain("reconcile_workbook_vs_repository");
    expect(names).toContain("generate_rename_plan");
    expect(names).not.toContain("execute_rename_plan");
    expect(names).not.toContain("execute_move_plan");
    expect(names).not.toContain("replicate_template");
  });

  it("rejects calling a write tool that was never registered", async () => {
    const baseUrl = await startServer(false);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(baseUrl));

    // SDK 1.30.0's McpServer catches an unknown tool name as an McpError
    // internally and reports it as a CallToolResult with isError: true rather
    // than letting the JSON-RPC error reject the client's promise (only
    // UrlElicitationRequired bypasses that wrapping). So the wire-level proof
    // that the tool is genuinely unregistered, not merely refused, is an
    // error result naming the tool as not found -- a call that instead
    // succeeded with the stub response (no isError) would mean the filter
    // predicate let the tool through.
    try {
      const result = await client.callTool({
        name: "execute_rename_plan",
        arguments: { planId: "rnm-1", confirm: true },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject([
        { type: "text", text: expect.stringContaining("execute_rename_plan") },
      ]);
      expect(result.content).toMatchObject([{ text: expect.stringContaining("not found") }]);
    } finally {
      // In a `finally` so a failed assertion above still closes the client's
      // keep-alive connection; otherwise afterEach's httpServer.close(cb)
      // hangs waiting on a connection nothing will ever release.
      await client.close();
    }
  });

  it("advertises write tools when writes are enabled", async () => {
    const names = await listToolNames(await startServer(true));

    expect(names).toHaveLength(11);
    expect(names).toContain("execute_rename_plan");
    expect(names).toContain("execute_move_plan");
    expect(names).toContain("replicate_template");
  });
});
