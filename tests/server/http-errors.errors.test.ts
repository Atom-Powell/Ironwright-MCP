import { describe, expect, it } from "vitest";
import request from "supertest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApp } from "../../src/server/app.js";

function app(): ReturnType<typeof createApp> {
  return createApp({ serverFactory: () => new McpServer({ name: "test", version: "0.0.0" }) });
}

// A stack frame in a response leaks the server's install path and its
// dependency tree. Express's default error page carries both, which is what
// this suite exists to keep out of every failure response.
function expectNoStackTrace(text: string): void {
  expect(text).not.toMatch(/\bat\s+\S+\s+\(.*:\d+:\d+\)/);
  expect(text).not.toContain("node_modules");
  expect(text).not.toMatch(/<html/i);
}

describe("malformed request bodies", () => {
  it("answers a JSON-RPC parse error rather than an HTML error page", async () => {
    const response = await request(app()).post("/mcp").type("json").send("{ this is not json");

    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: expect.any(String) as string },
      id: null,
    });
    expectNoStackTrace(response.text);
  });

  it("answers a JSON-RPC invalid request when the body exceeds the size limit", async () => {
    const oversized = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1, padding: "x".repeat(5_000_000) });

    const response = await request(app()).post("/mcp").type("json").send(oversized);

    expect(response.status).toBe(413);
    expect(response.body.error).toMatchObject({ code: -32600 });
    expect(response.body.id).toBeNull();
    expectNoStackTrace(response.text);
  });
});

describe("unrouted requests", () => {
  it("answers a JSON-RPC error for an unrouted method on the MCP endpoint", async () => {
    const response = await request(app()).put("/mcp").type("json").send({ jsonrpc: "2.0", method: "ping", id: 1 });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32600, message: expect.any(String) as string },
      id: null,
    });
    expectNoStackTrace(response.text);
  });

  it("answers a JSON-RPC error for an unknown path", async () => {
    const response = await request(app()).get("/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: -32600 });
    expectNoStackTrace(response.text);
  });
});

describe("methods the stateless transport does not implement", () => {
  it("answers 405 with a JSON-RPC error on GET, which clients read as no SSE stream", async () => {
    const response = await request(app()).get("/mcp");

    expect(response.status).toBe(405);
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: expect.any(String) as string },
      id: null,
    });
    expectNoStackTrace(response.text);
  });

  it("answers 405 with a JSON-RPC error on DELETE, since there is no session to end", async () => {
    const response = await request(app()).delete("/mcp");

    expect(response.status).toBe(405);
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: expect.any(String) as string },
      id: null,
    });
    expectNoStackTrace(response.text);
  });
});
