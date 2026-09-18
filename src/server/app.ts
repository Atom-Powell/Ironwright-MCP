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
  //
  // This endpoint answers exactly one question: can this process serve at all.
  // It does not mean the tenant, Graph, or the state store is reachable, and it
  // must never be extended to check any of them. Configuration and profile
  // problems already exit the process before the port binds, so a process that
  // is answering here has already passed everything worth checking. A health
  // check that depends on a third party turns that party's outage into a
  // restart loop: the platform kills the instance, the replacement fails the
  // same check, and one degraded dependency becomes a total outage of a server
  // that could have kept answering most callers. Serving one caller an error is
  // strictly better.
  //
  // The test on this route only proves the handler never invokes serverFactory,
  // the one dependency-reaching path createApp has today. It would not catch a
  // dependency check added through a new AppOptions field or a client imported
  // and called inline in this handler, so the rule above binds whoever touches
  // this route next by convention, not by anything the suite enforces past that
  // one seam.
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

  // Without these last two handlers Express answers with its own error page,
  // which is HTML carrying library frames and the server's install path, and is
  // not a JSON-RPC error at all, so an MCP client reads it as a transport
  // failure rather than as a protocol error it can report.
  app.use((_req, res) => {
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Not found. This server answers MCP requests on POST /mcp." },
      id: null,
    });
  });

  app.use(((error, _req, res, next) => {
    // A failure after the response started belongs to Express's own handler,
    // which is the only thing that can destroy the socket cleanly.
    if (res.headersSent) {
      next(error);
      return;
    }

    const detail = error as { type?: unknown; status?: unknown; statusCode?: unknown };
    if (detail.type === "entity.parse.failed") {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: the request body is not valid JSON." },
        id: null,
      });
      return;
    }

    // Body-parser rejections other than a parse failure, an oversized body most
    // of all, arrive with their own 4xx status. Anything without one is a bug in
    // this server rather than a bad request, so it is logged and reported as an
    // internal error with nothing of the stack in the response.
    const status = typeof detail.status === "number" ? detail.status : detail.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid request." },
        id: null,
      });
      return;
    }

    console.error("unhandled error on an MCP request", error);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error." },
      id: null,
    });
  }) satisfies express.ErrorRequestHandler);

  return app;
}
