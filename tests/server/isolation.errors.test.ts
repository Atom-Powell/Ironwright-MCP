import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createApp } from "../../src/server/app.js";

/**
 * Each factory call closes over its own counter. If the HTTP layer ever reuses
 * one server instance across requests, a second caller sees a count above one.
 * That contamination is silent in production, so it gets an explicit test.
 */
function countingServerFactory(): McpServer {
  let callCount = 0;
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool(
    "count",
    {
      title: "Count",
      description: "Test-only instance-scoped counter.",
      inputSchema: {},
      outputSchema: { callCount: z.number() },
    },
    () => {
      callCount += 1;
      return {
        structuredContent: { callCount },
        content: [{ type: "text" as const, text: String(callCount) }],
      };
    },
  );
  return server;
}

describe("request isolation", () => {
  let httpServer: Server;
  let baseUrl: URL;

  beforeEach(async () => {
    const app = createApp({ serverFactory: countingServerFactory });
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

  it("does not accumulate state across concurrent requests", async () => {
    const clients = await Promise.all(
      [0, 1].map(async () => {
        const client = new Client({ name: "test-client", version: "0.0.0" });
        await client.connect(new StreamableHTTPClientTransport(baseUrl));
        return client;
      }),
    );

    const results = await Promise.all(clients.map((client) => client.callTool({ name: "count", arguments: {} })));

    for (const result of results) {
      expect(result.structuredContent).toEqual({ callCount: 1 });
    }

    await Promise.all(clients.map((client) => client.close()));
  });
});
