// tests/server/disconnect.test.ts
import { createServer, request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../../src/server/app.js";
import { buildServer } from "../../src/mcp/build-server.js";
import { createFakeToolContext } from "../tools/fake-context.js";
import type { ToolDefinition } from "../../src/tools/types.js";

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
      await entered;
      req.destroy();
      // The gate is still closed, so this holds without waiting.
      expect(completed).toBe(false);

      release();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          finished,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("handler did not finish after the client left")), 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      expect(completed).toBe(true);
    } finally {
      release();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
