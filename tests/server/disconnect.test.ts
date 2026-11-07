// tests/server/disconnect.test.ts
import { createServer, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../../src/server/app.js";
import { buildServer } from "../../src/mcp/build-server.js";
import { createFakeToolContext } from "../tools/fake-context.js";
import type { ToolDefinition } from "../../src/tools/types.js";

async function within(promise: Promise<void>, message: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("a tool handler survives its client going away", () => {
  it("completes the handler after the socket is destroyed mid-call", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed = false;
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let markFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });

    const slow: ToolDefinition = {
      name: "slow_fixture",
      kind: "read",
      title: "Slow",
      description: "Fixture. Read-only: this tool makes no changes and is safe to repeat.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      outputSchema: { ok: z.boolean() },
      handler: async () => {
        markEntered();
        await gate;
        completed = true;
        markFinished();
        return { structuredContent: { ok: true }, content: [{ type: "text", text: "ok" }] };
      },
    };

    const context = createFakeToolContext();
    const app = createApp({
      auth: { mode: "none", header: "x-api-key" },
      serverFactory: () => buildServer({ allowWrites: false, context, tools: [slow] }),
    });
    const server = createServer(app);
    let accepted: Socket | undefined;
    server.on("connection", (socket) => {
      accepted = socket;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow_fixture", arguments: {} } });
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(body) },
      });
      req.on("error", () => {});
      req.end(body);

      // The handler is observed running, not assumed: drop the connection the
      // way an edge timeout does only once it has been entered.
      await within(entered, "handler was never entered");
      const serverSide = accepted;
      if (serverSide === undefined) throw new Error("the server never accepted a connection");
      const serverSawClose = new Promise<void>((resolve) => serverSide.once("close", () => resolve()));
      req.destroy();
      // Release only after the server has itself noticed the dropped socket.
      // Releasing right after destroy() lets the handler finish in microtasks
      // before the close arrives, so a transport that aborted handlers on close
      // would still pass.
      await within(serverSawClose, "server never saw the socket close");
      expect(completed).toBe(false);

      release();
      await within(finished, "handler did not finish after the client left");
      expect(completed).toBe(true);
    } finally {
      release();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
