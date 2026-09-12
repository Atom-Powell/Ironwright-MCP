import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface AppOptions {
  /**
   * Injected rather than imported so request isolation can be tested with a
   * probe server, without shipping test-only branches in production code.
   */
  serverFactory: () => McpServer;
}

export function createApp(opts: AppOptions): express.Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/mcp", express.json({ limit: "4mb" }), async (req, res) => {
    const server = opts.serverFactory();
    // Stateless: no session id generator, so the transport never retains
    // per-client state between requests and the service scales behind a plain
    // load balancer with no session affinity.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: error instanceof Error ? error.message : "internal error" },
          id: null,
        });
      }
    }
  });

  return app;
}
