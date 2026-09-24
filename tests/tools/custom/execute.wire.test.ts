import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../../src/mcp/build-server.js";
import { createFakeToolContext } from "../fake-context.js";
import { executeCustomPlan } from "../../../src/tools/definitions/execute-custom-plan.js";
import { runExecuteCustomPlan } from "../../../src/tools/custom/execute.js";
import type { ToolContext } from "../../../src/tools/context.js";
import type { ToolDefinition } from "../../../src/tools/types.js";
import { movingLibraryGraphClient } from "../move/fixtures.js";
import { FOLDERS, JAN_2025, JAN_ITEM, PLAN_ID, customPlanWith } from "./fixtures.js";

describe("execute_custom_plan over the wire", () => {
  it("reports a failure as a tool error the model can read, not a transport fault", async () => {
    // A write tool is filtered out unless writes are enabled, so this server
    // must be built with allowWrites: true for the tool to be reachable at all.
    const server = buildServer({
      allowWrites: true,
      context: createFakeToolContext({ graph: movingLibraryGraphClient({ [JAN_2025]: "etag-0" }, FOLDERS) }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "execute_custom_plan",
        arguments: { profileId: "example", planId: "cus-2026-09-24-nosuch01" },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a populated structuredContent that passes the SDK's own output validation on a dry run", async () => {
    const context = createFakeToolContext({ graph: movingLibraryGraphClient({ [JAN_2025]: "etag-0" }, FOLDERS) });
    await context.store.savePlan("example", customPlanWith([JAN_ITEM]));

    const server = buildServer({ allowWrites: true, context });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "execute_custom_plan",
        arguments: { profileId: "example", planId: PLAN_ID },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.dryRun).toBe(true);
      expect(structured.planId).toBe(PLAN_ID);
      expect(Array.isArray(structured.results) && structured.results.length).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a populated structuredContent that passes the SDK's own output validation on a confirmed run", async () => {
    // Without a wire test, an output-schema mismatch on this tool would first
    // surface at a live tenant. `buildServer`'s `tools` option binds the real
    // handler's test-only makeReversalPlanId seam to a fixture value instead
    // of a random id, over a real transport with the SDK's own outputSchema
    // validator in the loop.
    const context = createFakeToolContext({ graph: movingLibraryGraphClient({ [JAN_2025]: "etag-0" }, FOLDERS) });
    await context.store.savePlan("example", customPlanWith([JAN_ITEM]));

    const fixtureTool: ToolDefinition = {
      ...executeCustomPlan,
      handler: (input: unknown, toolContext: ToolContext) =>
        runExecuteCustomPlan(input, toolContext, () => "rev-2026-09-24-ffffffff"),
    };

    const server = buildServer({ allowWrites: true, context, tools: [fixtureTool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "execute_custom_plan",
        arguments: { profileId: "example", planId: PLAN_ID, confirm: true },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.dryRun).toBe(false);
      expect(structured.reversalPlanId).toBe("rev-2026-09-24-ffffffff");
      expect(structured.counts).toMatchObject({ applied: 1 });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
