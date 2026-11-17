import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../../src/mcp/build-server.js";
import { assessmentModule } from "../../../src/modules/assessment/index.js";
import { REFUSAL_META_KEY } from "../../../src/tools/assessment/refusal.js";
import { createSimDeployment } from "../../../scripts/sim/deployment.js";

const PROFILE = "vendor-assessments";

/**
 * A refusal as a real client receives it. The SDK client keeps each tool's
 * output schema once it has listed the tools, as every agent host does, and
 * validates structured content against it even on an error result (SDK
 * 1.30.0, client/index.js). The server side skips that check for an error,
 * which is what tests/mcp/build-server.errors.test.ts pins, so a refusal that
 * carried its evidence as structured content passed every server side test
 * and reached such a client as a schema fault with the evidence thrown away.
 */
describe("a lifecycle refusal over MCP, to a client that has listed the tools", () => {
  it("arrives as a tool error carrying its evidence, not as a schema fault", async () => {
    const deployment = createSimDeployment();
    const server = buildServer({ allowWrites: true, context: deployment.context, tools: assessmentModule.tools });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      await client.listTools();
      const opened = await client.callTool({ name: "open_assessment", arguments: { profileId: PROFILE, vendor: "Acme Corp", scope: "Security" } });
      const assessmentId = (opened.structuredContent as { assessmentId: string }).assessmentId;

      // No dossier has been saved, so completing must be refused.
      const refused = await client.callTool({
        name: "transition_assessment",
        arguments: { profileId: PROFILE, assessmentId, target: "completed", disposition: "Approved", risk: "Low" },
      });

      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("transition_assessment refused the LIFECYCLE stage");
      expect(refused.structuredContent).toBeUndefined();
      expect((refused._meta as Record<string, unknown>)[REFUSAL_META_KEY]).toMatchObject({
        refused: true,
        tool: "transition_assessment",
        assessmentId,
        observed: "not present",
        evidence: [{ source: "drive", found: "not found" }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
