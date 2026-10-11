import request from "supertest";
import { describe, expect, it } from "vitest";
import { argumentShape, createProbeApp, type ProbeAuthMode, type TraceRecord } from "../../scripts/copilot-probe/app.js";

const KEY = "test-key-0123456789abcdef";
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function makeApp(authMode: ProbeAuthMode = "apikey") {
  const records: TraceRecord[] = [];
  const app = createProbeApp({
    authMode,
    apiKey: KEY,
    apiKeyHeader: "x-api-key",
    trace: (r) => records.push(r),
  });
  return { app, records };
}

const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const callFruit = (fruit: string) => ({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "get_fruit_stock", arguments: { fruit } },
});

// supertest resolves before the finish listener's record is guaranteed
// written in some cases, so wait a tick before asserting on the trace.
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("probe server authentication", () => {
  it("rejects a request with no credential and says so in the trace without naming one", async () => {
    const { app, records } = makeApp();
    const res = await request(app).post("/mcp").set(MCP_HEADERS).send(listTools);
    await settle();
    expect(res.status).toBe(401);
    const http = records.find((r) => r.event === "http");
    expect(http).toMatchObject({ status: 401, credentialPresent: false });
  });

  it("rejects a wrong key, including one of a different length", async () => {
    const { app } = makeApp();
    for (const wrong of ["x", `${KEY}x`, KEY.replace("t", "T")]) {
      const res = await request(app).post("/mcp").set(MCP_HEADERS).set("x-api-key", wrong).send(listTools);
      expect(res.status).toBe(401);
    }
  });

  it("accepts the key in the configured header", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/mcp").set(MCP_HEADERS).set("x-api-key", KEY).send(listTools);
    expect(res.status).toBe(200);
  });

  it("accepts a bearer token in bearer mode and challenges when absent", async () => {
    const { app } = makeApp("bearer");
    const ok = await request(app).post("/mcp").set(MCP_HEADERS).set("authorization", `Bearer ${KEY}`).send(listTools);
    expect(ok.status).toBe(200);
    const no = await request(app).post("/mcp").set(MCP_HEADERS).send(listTools);
    expect(no.status).toBe(401);
    expect(no.headers["www-authenticate"]).toBe("Bearer");
  });

  it("serves health without a credential", async () => {
    const { app } = makeApp();
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("refuses to build without a usable key unless auth is none", () => {
    expect(() => createProbeApp({ authMode: "apikey", apiKeyHeader: "x-api-key", trace: () => {} })).toThrow();
    expect(() =>
      createProbeApp({ authMode: "apikey", apiKey: "short", apiKeyHeader: "x-api-key", trace: () => {} }),
    ).toThrow();
    expect(() => createProbeApp({ authMode: "none", apiKeyHeader: "x-api-key", trace: () => {} })).not.toThrow();
  });
});

describe("probe server tools", () => {
  it("lists exactly the two dummy tools with full descriptions and explicit annotations", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/mcp").set(MCP_HEADERS).set("x-api-key", KEY).send(listTools);
    const text = res.text.includes("data:") ? res.text.split("data:")[1] ?? "" : res.text;
    const tools = (JSON.parse(text) as { result: { tools: { name: string; description: string; annotations: object }[] } })
      .result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["celsius_to_fahrenheit", "get_fruit_stock"]);
    const fruit = tools.find((t) => t.name === "get_fruit_stock");
    expect(fruit?.description).toContain("arrived untruncated");
    expect(fruit?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("answers from the fixed inventory", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/mcp").set(MCP_HEADERS).set("x-api-key", KEY).send(callFruit("banana"));
    expect(res.text).toContain('\\"units\\":7');
  });

  it("records the tool call by argument shape and never by value or credential", async () => {
    const { app, records } = makeApp();
    await request(app).post("/mcp").set(MCP_HEADERS).set("x-api-key", KEY).send(callFruit("banana"));
    await settle();
    const call = records.find((r) => r.event === "tool_call");
    expect(call).toMatchObject({ tool: "get_fruit_stock", rpcId: 2, outcome: "ok" });
    // The SDK fills in the default before the handler runs, so the validated
    // shape has warehouse; only the http record shows what the caller sent.
    expect(call?.argShapeValidated).toEqual({ fruit: "string", warehouse: "string" });
    expect(records.find((r) => r.event === "http")?.argShapeSent).toEqual({ fruit: "string" });
    const everything = JSON.stringify(records);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("banana");
  });

  it("records the JSON-RPC method on the http record", async () => {
    const { app, records } = makeApp();
    await request(app).post("/mcp").set(MCP_HEADERS).set("x-api-key", KEY).send(listTools);
    await settle();
    expect(records.find((r) => r.event === "http" && r.status === 200)).toMatchObject({
      rpcMethod: "tools/list",
      rpcId: 1,
    });
  });

  it("answers invalid JSON with a JSON-RPC parse error rather than an HTML page", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/mcp").set(MCP_HEADERS).set("x-api-key", KEY).send("{not json");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: -32700 } });
  });
});

describe("argumentShape", () => {
  it("reports key and type only", () => {
    expect(argumentShape({ a: "x", b: 1, c: null, d: [1], e: { f: 1 } })).toEqual({
      a: "string",
      b: "number",
      c: "null",
      d: "array",
      e: "object",
    });
    expect(argumentShape(undefined)).toEqual({});
  });
});
