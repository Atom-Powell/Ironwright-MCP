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

  // Kept separate from the MCP route because container probes issue GET and the
  // MCP endpoint only answers POST.
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/mcp", express.json({ limit: "4mb" }), async (req, res) => {
    const server = opts.serverFactory();
    // Stateless: no session id generator, so the transport never retains
    // per-client state between requests and the service scales behind a plain
    // load balancer with no session affinity.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    let closed = false;
    res.on("close", () => {
      closed = true;
      // McpServer.close() already awaits the transport's own close internally,
      // so closing the transport separately here would close it twice. The
      // catch is required, not decorative: Node 22 terminates the process on
      // an unhandled rejection, and this fires outside the try/catch below.
      server.close().catch((error: unknown) => {
        console.error("error closing MCP server after client disconnect", error);
      });
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      // Also guard on `closed`: a mid-request client abort fires the close
      // handler while handleRequest is still pending, and when that rejection
      // lands here headersSent is still false even though the socket is gone.
      if (!res.headersSent && !closed) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: error instanceof Error ? error.message : "internal error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no SSE stream to open (GET) or session to end (DELETE).
  // Responding 405 to both matches the MCP client SDK's own expectation: a
  // plain 405 on GET is read as "no SSE here" and handled cleanly, while any
  // other status is routed to onerror as a transport failure. Without this,
  // real clients (Copilot Studio included) log spurious errors against a
  // server that is behaving correctly.
  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}
