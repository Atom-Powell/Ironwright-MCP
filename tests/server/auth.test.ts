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

describe("inbound authentication", () => {
  it("serves /health with no credential", async () => {
    const res = await request(app()).get("/health");
    expect(res.status).toBe(200);
  });

  it("serves /health with no credential in bearer mode", async () => {
    const auth = loadInboundAuth({ IW_INBOUND_AUTH: "bearer", IW_INBOUND_KEY: KEY });
    const res = await request(app(auth)).get("/health");
    expect(res.status).toBe(200);
  });

  it("accepts the key in the default header", async () => {
    const res = await request(app()).post("/mcp").set(MCP_HEADERS).set("x-api-key", KEY).send(listTools);
    expect(res.status).toBe(200);
  });

  it("accepts the key in a configured header", async () => {
    const auth = loadInboundAuth({ IW_INBOUND_KEY: KEY, IW_INBOUND_KEY_HEADER: "x-ironwright-key" });
    const res = await request(app(auth)).post("/mcp").set(MCP_HEADERS).set("x-ironwright-key", KEY).send(listTools);
    expect(res.status).toBe(200);
  });

  it("accepts a bearer token in bearer mode", async () => {
    const auth = loadInboundAuth({ IW_INBOUND_AUTH: "bearer", IW_INBOUND_KEY: KEY });
    const res = await request(app(auth)).post("/mcp").set(MCP_HEADERS).set("authorization", `Bearer ${KEY}`).send(listTools);
    expect(res.status).toBe(200);
  });

  it("lets everything through in mode none when anonymous is explicitly allowed", async () => {
    const auth = loadInboundAuth({ IW_INBOUND_AUTH: "none", IW_ALLOW_ANONYMOUS: "1" });
    const res = await request(app(auth)).post("/mcp").set(MCP_HEADERS).send(listTools);
    expect(res.status).toBe(200);
  });
});
