import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../../../src/mcp/build-server.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import { RECONCILE_OUTPUT_SCHEMA } from "../../../src/tools/reconciliation/output.js";
import { reconcileWorkbookVsRepository } from "../../../src/tools/definitions/reconcile.js";
import { runReconcile } from "../../../src/tools/reconciliation/run.js";
import { createProfileRegistry } from "../../../src/profiles/registry.js";
import type { ToolContext } from "../../../src/tools/context.js";
import type { ToolDefinition } from "../../../src/tools/types.js";
import type { ScanCoordinator } from "../../../src/scan/coordinator.js";

describe("reconcile_workbook_vs_repository over the wire", () => {
  it("reports a failure as a tool error the model can read, not a transport fault", async () => {
    // The fake context's scan coordinator rejects, so this exercises the whole
    // dispatch path including the error mapping.
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "reconcile_workbook_vs_repository",
        arguments: { profileId: "example" },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("declares an output schema the shaped report validates against", async () => {
    const { loadExpectedReport } = await import("../../domain/reconcile/fixtures/load.js");
    const { shapeReport } = await import("../../../src/tools/reconciliation/shape.js");

    const output = shapeReport(
      loadExpectedReport(),
      { scanMode: "full", resynced: false, graphRequestsByThisCall: 2, scanSharedWithConcurrentCall: false },
      {},
    );

    expect(() => z.object(RECONCILE_OUTPUT_SCHEMA).parse(output)).not.toThrow();
  });

  it("returns a populated structuredContent that passes the SDK's own output validation on success", async () => {
    // The two tests above cover the error path (structuredContent absent, the
    // SDK never validates) and the shape in isolation (a local schema parse
    // with the SDK nowhere in the loop). Neither exercises the SDK's own
    // outputSchema validator against a real successful result, which is what
    // the design spec's wire test requires. This one does, by routing a
    // resolving scan and a fixture workbook through the real transport.
    const { loadProfile, loadRepository, loadWorkbook, GOLDEN_AS_OF } = await import(
      "../../domain/reconcile/fixtures/load.js"
    );

    const profile = loadProfile();
    const repository = loadRepository();
    const workbook = loadWorkbook();

    // `scans.run` resolves instead of the fake context's default rejection, so
    // the tool's composition root has a snapshot to reconcile against.
    const scans: ScanCoordinator = {
      run: () =>
        Promise.resolve({
          result: {
            snapshot: repository,
            driveId: "fixture-drive",
            mode: "full",
            resynced: false,
            pages: 1,
            changesApplied: 0,
            graphRequests: 2,
            storeBatches: 0,
            unfilteredFileCount: repository.files.length,
            unfilteredFolderCount: repository.folderPaths.length,
          },
          joined: false,
        }),
    };

    const context = createFakeToolContext({
      profiles: createProfileRegistry([{ source: "fixture-profile.json", contents: profile }]),
      scans,
      // Matches GOLDEN_AS_OF so the resolved window lines up with the fixture
      // workbook and repository, which were built for that reference month.
      now: () => new Date(Date.UTC(GOLDEN_AS_OF.year, GOLDEN_AS_OF.month - 1, 15)),
    });

    // `buildServer`'s `tools` option exists for exactly this: a definition the
    // production registry never sees, whose handler binds `runReconcile`'s
    // test-only `readWorkbook` seam to the fixture instead of the real Graph
    // read. No production code changes to make this possible.
    const fixtureTool: ToolDefinition = {
      ...reconcileWorkbookVsRepository,
      handler: (input: unknown, toolContext: ToolContext) => runReconcile(input, toolContext, () => Promise.resolve(workbook)),
    };

    const server = buildServer({ allowWrites: false, context, tools: [fixtureTool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "reconcile_workbook_vs_repository",
        arguments: { profileId: profile.profileId },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.profileId).toBe(profile.profileId);
      expect(Array.isArray(structured.clients) && structured.clients.length).toBeGreaterThan(0);
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
      const listed = (await client.listTools()).tools.find(
        (tool) => tool.name === "reconcile_workbook_vs_repository",
      );

      expect(Object.keys(listed?.outputSchema?.properties ?? {})).toContain("clients");
      expect(Object.keys(listed?.outputSchema?.properties ?? {})).not.toContain("stub");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
