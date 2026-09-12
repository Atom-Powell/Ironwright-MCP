import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../../src/server/app.js";
import { buildServer } from "../../src/mcp/build-server.js";
import { requiredSentence } from "../../src/tools/kinds.js";
import { ALL_TOOLS } from "../../src/tools/registry.js";

/**
 * The registry-level contract test asserts over the definition objects, which
 * proves nothing about what a client receives: dropping annotations,
 * outputSchema, or description from the registerTool call leaves it green. This
 * suite asserts the same contract against a real tools/list response, and it
 * derives what to expect from the registry so a tool added later is covered
 * without anyone remembering to add it here.
 */
interface ListedTool {
  description?: string;
  annotations?: Record<string, unknown>;
  outputSchema?: { properties?: Record<string, unknown> };
}

let httpServer: Server;
const listed = new Map<string, ListedTool>();

beforeAll(async () => {
  // Writes enabled, because the write tools carry the annotations that matter
  // most and are absent from a default deployment.
  const app = createApp({ serverFactory: () => buildServer({ allowWrites: true }) });
  httpServer = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  try {
    for (const tool of (await client.listTools()).tools) {
      listed.set(tool.name, tool as ListedTool);
    }
  } finally {
    await client.close();
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("tool contract over the wire", () => {
  it("advertises exactly the registered tools", () => {
    expect([...listed.keys()].sort()).toEqual(ALL_TOOLS.map((tool) => tool.name).sort());
  });

  it.each(ALL_TOOLS)("$name reaches a client with all four annotations", (tool) => {
    const annotations = listed.get(tool.name)?.annotations;

    expect(annotations, `${tool.name} arrived without annotations`).toBeDefined();
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      expect(typeof annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
      expect(annotations?.[hint], `${tool.name}.${hint}`).toBe(tool.annotations[hint]);
    }
  });

  it.each(ALL_TOOLS)("$name reaches a client with an output schema", (tool) => {
    const outputSchema = listed.get(tool.name)?.outputSchema;

    expect(outputSchema, `${tool.name} arrived without an output schema`).toBeDefined();
    expect(Object.keys(outputSchema?.properties ?? {}).length).toBeGreaterThan(0);
  });

  it.each(ALL_TOOLS)("$name reaches a client with its safety sentence intact", (tool) => {
    const description = listed.get(tool.name)?.description;

    expect(description, `${tool.name} arrived without a description`).toBeDefined();
    expect(description).toContain(requiredSentence(tool.kind, tool.annotations.destructiveHint));
  });
});
