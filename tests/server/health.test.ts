import { describe, expect, it } from "vitest";
import request from "supertest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApp } from "../../src/server/app.js";

describe("GET /health", () => {
  it("returns 200 with a status body", async () => {
    const response = await request(
      createApp({ auth: { mode: "none", header: "x-api-key" }, serverFactory: () => new McpServer({ name: "test", version: "0.0.0" }) }),
    ).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("does not accept POST", async () => {
    const response = await request(
      createApp({ auth: { mode: "none", header: "x-api-key" }, serverFactory: () => new McpServer({ name: "test", version: "0.0.0" }) }),
    ).post("/health");

    expect(response.status).toBe(404);
  });

  it("answers healthy without building a tool server or reaching any dependency", async () => {
    let serverFactoryCalls = 0;
    const app = createApp({
      auth: { mode: "none", header: "x-api-key" },
      serverFactory: () => {
        serverFactoryCalls += 1;
        return new McpServer({ name: "test", version: "0.0.0" });
      },
    });

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    // A health check that depends on a third party turns that party's outage
    // into a restart loop, which is strictly worse than serving one caller an
    // error. This pins one seam, serverFactory, the only dependency-reaching
    // path createApp has today: it catches a Graph or state store check routed
    // through the factory, but not one added via a new AppOptions field or an
    // inline import in the handler, which is what the route comment says.
    expect(serverFactoryCalls).toBe(0);
  });
});
