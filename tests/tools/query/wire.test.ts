import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../../../src/mcp/build-server.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import { QUERY_OUTPUT_SCHEMA } from "../../../src/tools/query/output.js";
import { shapeQuery } from "../../../src/tools/query/shape.js";
import type { InventoryChange } from "../../../src/store/types.js";

const CHANGES: InventoryChange[] = [
  {
    kind: "upsert",
    record: { itemId: "1", path: "2026", name: "2026", isFolder: true, size: 0, modified: "2026-09-01T00:00:00.000Z", etag: "a" },
  },
  {
    kind: "upsert",
    record: { itemId: "2", path: "2026/CLIENTA", name: "CLIENTA", isFolder: true, size: 0, modified: "2026-09-01T00:00:00.000Z", etag: "b" },
  },
];

describe("query_repository over the wire", () => {
  it("reports a never-scanned profile as a tool error the model can read, not a transport fault", async () => {
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "query_repository",
        arguments: { profileId: "example", question: "empty_folders" },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("declares an output schema the shaped query validates against", () => {
    const output = shapeQuery(
      "example",
      "Compliance Reports",
      "empty_folders",
      "drive-1",
      "2026-09-17T00:00:00.000Z",
      [{ path: "2026/CLIENTA", name: "CLIENTA", detail: "No file or deeper folder sits under this folder." }],
      {},
    );

    expect(() => z.object(QUERY_OUTPUT_SCHEMA).parse(output)).not.toThrow();
  });

  it("returns a populated structuredContent that passes the SDK's own output validation on success", async () => {
    // Seeded through the real memory store rather than a fake, so this
    // exercises getScannedDrives and listInventory as the tool actually calls
    // them, over a real transport, with the SDK's own outputSchema validator
    // in the loop.
    const context = createFakeToolContext();
    await context.store.setDeltaLink("example", "drive-1", "delta-link-1", "2026-09-17T00:00:00.000Z");
    await context.store.applyInventoryChanges("example", "drive-1", CHANGES);

    const server = buildServer({ allowWrites: false, context });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "query_repository",
        arguments: { profileId: "example", question: "empty_folders" },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.profileId).toBe("example");
      expect(structured.library).toBe("Compliance Reports");
      expect(structured.driveId).toBe("drive-1");
      expect(structured.graphRequests).toBe(0);
      const findings = structured.findings;
      expect(Array.isArray(findings) && findings.length).toBe(1);
      expect((findings as Array<Record<string, unknown>>)[0]?.path).toBe("2026/CLIENTA");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("no longer advertises the stub output schema", async () => {
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const listed = (await client.listTools()).tools.find((tool) => tool.name === "query_repository");

      expect(Object.keys(listed?.outputSchema?.properties ?? {})).toContain("findings");
      expect(Object.keys(listed?.outputSchema?.properties ?? {})).not.toContain("stub");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("no longer advertises the five-question enum removed from the input schema", async () => {
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const listed = (await client.listTools()).tools.find((tool) => tool.name === "query_repository");
      const question = (listed?.inputSchema?.properties as Record<string, { enum?: string[] } | undefined> | undefined)?.question;

      expect(question?.enum).toEqual(["empty_folders", "naming_violations", "recent_reports"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
