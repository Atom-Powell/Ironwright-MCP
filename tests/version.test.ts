import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readPackageVersion, SERVER_VERSION } from "../src/version.js";
import { buildServer } from "../src/mcp/build-server.js";
import { createApp } from "../src/server/app.js";
import { createFakeToolContext } from "./tools/fake-context.js";

const PACKAGE_VERSION = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

describe("the version this server reports", () => {
  it("is read from package.json, not written down a second time", () => {
    expect(readPackageVersion()).toBe(PACKAGE_VERSION);
    expect(SERVER_VERSION).toBe(PACKAGE_VERSION);
  });

  it("is unknown when the file cannot be read, never a number nobody checked", () => {
    expect(readPackageVersion(new URL("file:///no/such/place/package.json"))).toBe("unknown");
  });

  it("is what an MCP client is told on connecting", async () => {
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "ironwright-mcp", version: PACKAGE_VERSION });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("is in the health answer when the app is given one, and absent when it is not", async () => {
    const serverFactory = (): McpServer => new McpServer({ name: "test", version: "0.0.0" });
    const auth = { mode: "none" as const, header: "x-api-key" };

    const withVersion = await request(createApp({ auth, serverFactory, version: "1.2.3" })).get("/health");
    expect(withVersion.body).toEqual({ status: "ok", version: "1.2.3" });

    const without = await request(createApp({ auth, serverFactory })).get("/health");
    expect(without.body).toEqual({ status: "ok" });
  });
});
