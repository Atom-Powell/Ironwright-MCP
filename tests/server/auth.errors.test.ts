import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { buildServer } from "../../src/mcp/build-server.js";
import { createFakeToolContext } from "../tools/fake-context.js";
import { loadInboundAuth } from "../../src/config.js";

const KEY = "test-key-0123456789abcdef";
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };

function app(auth = loadInboundAuth({ IW_INBOUND_KEY: KEY })) {
  const context = createFakeToolContext();
  return createApp({ auth, serverFactory: () => buildServer({ allowWrites: false, context }) });
}

describe("inbound authentication, refused", () => {
  it("answers 401 as a JSON-RPC error with no credential, and never builds a server", async () => {
    let built = 0;
    const context = createFakeToolContext();
    const a = createApp({
      auth: loadInboundAuth({ IW_INBOUND_KEY: KEY }),
      serverFactory: () => {
        built += 1;
        return buildServer({ allowWrites: false, context });
      },
    });
    const res = await request(a).post("/mcp").set(MCP_HEADERS).send(listTools);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized." }, id: null });
    expect(built).toBe(0);
  });

  it("rejects a wrong key of any length, and the body never echoes what was sent", async () => {
    for (const wrong of ["x", `${KEY}x`, KEY.toUpperCase()]) {
      const res = await request(app()).post("/mcp").set(MCP_HEADERS).set("x-api-key", wrong).send(listTools);
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain(wrong);
    }
  });

  it("in bearer mode, a key in the api-key header is not accepted and WWW-Authenticate is set", async () => {
    const auth = loadInboundAuth({ IW_INBOUND_AUTH: "bearer", IW_INBOUND_KEY: KEY });
    const res = await request(app(auth)).post("/mcp").set(MCP_HEADERS).set("x-api-key", KEY).send(listTools);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });

  it("guards the 404 fallthrough and the 405 routes too, so an unauthenticated scan learns nothing", async () => {
    expect((await request(app()).get("/mcp")).status).toBe(401);
    expect((await request(app()).get("/anything")).status).toBe(401);
  });
});

describe("loadInboundAuth", () => {
  it("refuses to start with no key in apikey mode, naming the variable and the length floor", () => {
    expect(() => loadInboundAuth({})).toThrow(/IW_INBOUND_KEY.*16/);
  });

  it("refuses a short key", () => {
    expect(() => loadInboundAuth({ IW_INBOUND_KEY: "short" })).toThrow(/16/);
  });

  it("refuses mode none without IW_ALLOW_ANONYMOUS=1", () => {
    expect(() => loadInboundAuth({ IW_INBOUND_AUTH: "none" })).toThrow(/IW_ALLOW_ANONYMOUS/);
  });

  it("refuses an unknown mode, naming the three", () => {
    expect(() => loadInboundAuth({ IW_INBOUND_AUTH: "oauth", IW_INBOUND_KEY: "test-key-0123456789abcdef" })).toThrow(/apikey.*bearer.*none/);
  });

  it("never echoes the key in any message", () => {
    const key = "short";
    let message = "";
    try {
      loadInboundAuth({ IW_INBOUND_KEY: key });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(key);
  });
});
