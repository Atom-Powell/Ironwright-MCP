import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createApp } from "../../src/server/app.js";

function probeServerFactory(): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool(
    "probe",
    {
      title: "Probe",
      description: "Test-only probe tool.",
      inputSchema: { value: z.string() },
      outputSchema: { echoed: z.string() },
    },
    ({ value }) => ({
      structuredContent: { echoed: value },
      content: [{ type: "text" as const, text: value }],
    }),
  );
  return server;
}

describe("POST /mcp", () => {
  let httpServer: Server;
  let baseUrl: URL;

  beforeEach(async () => {
    const app = createApp({ serverFactory: probeServerFactory });
    httpServer = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const address = httpServer.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("lists tools and calls one over Streamable HTTP", async () => {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(baseUrl));

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("probe");

    const called = await client.callTool({ name: "probe", arguments: { value: "hello" } });
    expect(called.structuredContent).toEqual({ echoed: "hello" });

    await client.close();
  });
});
