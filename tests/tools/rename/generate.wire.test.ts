import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../../src/mcp/build-server.js";
import { createFakeToolContext } from "../fake-context.js";
import { generateRenamePlan } from "../../../src/tools/definitions/generate-rename-plan.js";
import { runGenerateRenamePlan } from "../../../src/tools/rename/generate.js";
import type { ToolContext } from "../../../src/tools/context.js";
import type { ToolDefinition } from "../../../src/tools/types.js";
import { MISNAMED_PATH, contextWith, etagGraphClient, snapshotWithMisnamedFile, workbookFixture } from "./fixtures.js";

describe("generate_rename_plan over the wire", () => {
  it("reports a failure as a tool error the model can read, not a transport fault", async () => {
    // The fake context's scan coordinator rejects, so this exercises the whole
    // dispatch path including the error mapping.
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({ name: "generate_rename_plan", arguments: { profileId: "example" } });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a populated structuredContent that passes the SDK's own output validation on success", async () => {
    // Without a wire test, an output-schema mismatch on this tool would first
    // surface at a live tenant. `buildServer`'s `tools` option binds the real
    // handler's test-only readWorkbook and makePlanId seams to fixtures instead
    // of a real Graph read, over a real transport with the SDK's own
    // outputSchema validator in the loop.
    const graph = etagGraphClient({ [MISNAMED_PATH]: '"{GUID},4"' });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const fixtureTool: ToolDefinition = {
      ...generateRenamePlan,
      handler: (input: unknown, toolContext: ToolContext) =>
        runGenerateRenamePlan(
          input,
          toolContext,
          () => Promise.resolve(workbookFixture()),
          () => "rnm-2026-09-18-deadbeef",
        ),
    };

    const server = buildServer({ allowWrites: false, context, tools: [fixtureTool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({ name: "generate_rename_plan", arguments: { profileId: "example" } });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.profileId).toBe("example");
      expect(structured.planId).toBe("rnm-2026-09-18-deadbeef");
      expect(Array.isArray(structured.items) && structured.items.length).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
