import { describe, expect, it } from "vitest";
import request from "supertest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApp } from "../../src/server/app.js";

describe("GET /health", () => {
  it("returns 200 with a status body", async () => {
    const response = await request(
      createApp({ serverFactory: () => new McpServer({ name: "test", version: "0.0.0" }) }),
    ).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("does not accept POST", async () => {
    const response = await request(
      createApp({ serverFactory: () => new McpServer({ name: "test", version: "0.0.0" }) }),
    ).post("/health");

    expect(response.status).toBe(404);
  });
});
