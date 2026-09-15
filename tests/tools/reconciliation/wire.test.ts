import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../../../src/mcp/build-server.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import { RECONCILE_OUTPUT_SCHEMA } from "../../../src/tools/reconciliation/output.js";

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
