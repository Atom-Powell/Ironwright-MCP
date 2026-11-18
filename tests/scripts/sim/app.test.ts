import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSimApp, SIM_NOTICE } from "../../../scripts/sim/app.js";
import { createSimDeployment } from "../../../scripts/sim/deployment.js";
import { runWalkthrough } from "../../../scripts/sim/walkthrough.js";

describe("the simulated server", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    const app = createSimApp(createSimDeployment());
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("offers the assessment module's tools, lifecycle tools included, and nothing the simulated tenant cannot answer", async () => {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "describe_assessment_workflow", "get_assessment", "open_assessment", "read_assessment_artifact", "record_findings",
        "save_assessment_artifact", "transition_assessment", "verify_publication",
      ]);
    } finally {
      await client.close();
    }
  });

  it("runs a tool over MCP and shows what it wrote in the site state", async () => {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const opened = await client.callTool({ name: "open_assessment", arguments: { profileId: "vendor-assessments", vendor: "Acme Corp", scope: "Security" } });
      expect(opened.isError).toBeUndefined();
      const id = (opened.structuredContent as { assessmentId: string }).assessmentId;

      const state = (await (await fetch(`${base}/sim/state`)).json()) as {
        notice: string;
        lists: Record<string, { id: string; fields: Record<string, unknown> }[]>;
        library: { path: string }[];
        journal: Record<string, unknown[]>;
      };
      expect(state.notice).toBe(SIM_NOTICE);
      expect(state.lists.Assessments!.map((item) => item.fields.AssessmentId)).toEqual([id]);
      expect(state.library.map((entry) => entry.path)).toContain(`Assessments/Acme Corp/${id}/Research`);
      expect(Object.keys(state.journal).sort()).toEqual(["(unassigned)", "(vendor)", id].sort());
    } finally {
      await client.close();
    }
  });

  it("lets a person put and remove a file and edit a list item, as the routes under /sim describe", async () => {
    const put = await fetch(`${base}/sim/files/Published/Report%20one.docx`, { method: "PUT", body: new TextEncoder().encode("docx") });
    expect(await put.json()).toEqual({ put: "Published/Report one.docx", bytes: 4 });
    const library = async (): Promise<string[]> => ((await (await fetch(`${base}/sim/state`)).json()) as { library: { path: string }[] }).library.map((entry) => entry.path);
    expect(await library()).toEqual(["Published", "Published/Report one.docx"]);

    await fetch(`${base}/sim/files/Published`, { method: "DELETE" });
    expect(await library()).toEqual([]);

    const missing = await fetch(`${base}/sim/lists/Assessments/9`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ Status: "Completed" }) });
    expect(missing.status).toBe(404);
  });
});

describe("the walkthrough", () => {
  it("takes one assessment from open to completed over MCP and reports every step", async () => {
    const lines: string[] = [];
    await runWalkthrough((line) => lines.push(line));
    const output = lines.join("\n");

    expect(lines[0]).toBe(SIM_NOTICE);
    expect(output).toContain("The server offers 8 tools");
    expect(output).toContain('Workflow "vendor-assessments" on');
    expect(output).toContain("transition_assessment (refused)");
    expect(output).toContain('Moved ASM-');
    expect(output).toMatch(/The walkthrough finished: \d+ tool calls, every one answered as expected\./);
  });
});
