import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../../../src/mcp/build-server.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import { INVENTORY_OUTPUT_SCHEMA } from "../../../src/tools/inventory/output.js";
import { shapeInventory } from "../../../src/tools/inventory/shape.js";
import type { ScanCoordinator } from "../../../src/scan/coordinator.js";
import type { RepositorySnapshot } from "../../../src/domain/reconcile/index.js";

const SNAPSHOT: RepositorySnapshot = {
  files: [
    { path: "2026/CLIENTA/report.docx", name: "report.docx", size: 12, modified: "2026-09-01T00:00:00.000Z", etag: "a" },
  ],
  folderPaths: ["2026", "2026/CLIENTA"],
  scannedAt: "2026-09-17T00:00:00.000Z",
  searchCrossCheckIncluded: false,
};

describe("inventory_tree over the wire", () => {
  it("reports a failure as a tool error the model can read, not a transport fault", async () => {
    // The fake context's scan coordinator rejects, so this exercises the whole
    // dispatch path including the error mapping.
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "inventory_tree",
        arguments: { profileId: "example" },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("declares an output schema the shaped inventory validates against", () => {
    const output = shapeInventory("example", "Compliance Reports", SNAPSHOT, undefined, 3, {});

    expect(() => z.object(INVENTORY_OUTPUT_SCHEMA).parse(output)).not.toThrow();
  });

  it("returns a populated structuredContent that passes the SDK's own output validation on success", async () => {
    // The two tests above cover the error path (structuredContent absent, the
    // SDK never validates) and the shape in isolation (a local schema parse
    // with the SDK nowhere in the loop). Neither exercises the SDK's own
    // outputSchema validator against a real successful result over a real
    // transport. This one does, with a snapshot carrying both a file and a
    // folder so the listing's per-kind optional fields (size, modified) are
    // both exercised rather than validated against an empty array.
    const scans: ScanCoordinator = {
      run: () =>
        Promise.resolve({
          result: {
            snapshot: SNAPSHOT,
            driveId: "drive-1",
            mode: "full",
            resynced: false,
            pages: 1,
            changesApplied: 0,
            graphRequests: 3,
            storeBatches: 0,
            unfilteredFileCount: SNAPSHOT.files.length,
            unfilteredFolderCount: SNAPSHOT.folderPaths.length,
          },
          joined: false,
        }),
    };

    const context = createFakeToolContext({ scans });

    const server = buildServer({ allowWrites: false, context });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "inventory_tree",
        arguments: { profileId: "example" },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.profileId).toBe("example");
      expect(structured.library).toBe("Compliance Reports");
      const items = structured.items;
      expect(Array.isArray(items) && items.length).toBeGreaterThan(0);
      expect((items as Array<Record<string, unknown>>).some((item) => item.kind === "file")).toBe(true);
      expect((items as Array<Record<string, unknown>>).some((item) => item.kind === "folder")).toBe(true);
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
      const listed = (await client.listTools()).tools.find((tool) => tool.name === "inventory_tree");

      expect(Object.keys(listed?.outputSchema?.properties ?? {})).toContain("items");
      expect(Object.keys(listed?.outputSchema?.properties ?? {})).not.toContain("stub");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
