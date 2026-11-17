import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSimApp, SIM_NOTICE } from "./app.js";
import { createSimDeployment } from "./deployment.js";

interface ToolAnswer {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

/**
 * One assessment from open to completed, driven the way an agent drives it:
 * an MCP client over Streamable HTTP against the real server application,
 * with the simulated tenant behind it. Prints what each tool answered, so a
 * person can read the whole exchange without a tenant, a grant or a secret.
 * Throws if a step answers other than the walkthrough expects, so it doubles
 * as a smoke test of the transport, the registry and the seven tools together.
 */
export async function runWalkthrough(write: (line: string) => void): Promise<void> {
  const deployment = createSimDeployment();
  const profileId = deployment.profile.profileId;
  const app = createSimApp(deployment);
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  const base = `http://127.0.0.1:${address.port}`;

  const client = new Client({ name: "sim-walkthrough", version: "0.0.0" });
  let step = 0;
  const call = async (name: string, args: Record<string, unknown>, expectError = false): Promise<ToolAnswer> => {
    step += 1;
    const answer = (await client.callTool({ name, arguments: args })) as ToolAnswer;
    const text = (answer.content ?? []).map((entry) => entry.text ?? "").join(" ");
    write(`\n${step}. ${name} ${answer.isError === true ? "(refused)" : ""}`.trimEnd());
    write(`   ${text}`);
    if ((answer.isError === true) !== expectError) throw new Error(`step ${step}, ${name}, ${expectError ? "was expected to refuse and did not" : `failed: ${text}`}`);
    return answer;
  };

  try {
    write(SIM_NOTICE);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const listed = await client.listTools();
    write(`\nThe server offers ${listed.tools.length} tools: ${listed.tools.map((tool) => tool.name).join(", ")}.`);

    const opened = await call("open_assessment", { profileId, vendor: "Acme Corp", scope: "Security" });
    const assessmentId = opened.structuredContent?.assessmentId as string;
    const id = { profileId, assessmentId };

    await call("get_assessment", id);
    await call("save_assessment_artifact", { ...id, kind: "dossier", content: "# Acme Corp research dossier\n\nSOC 2 Type II, dated 2026-03, covers the hosting subsidiary only.\n" });
    await call("read_assessment_artifact", { ...id, kind: "dossier" });
    await call("record_findings", {
      ...id,
      summary: "Two findings, one high.",
      findings: [
        { key: "F-1", observation: "The SOC 2 report covers only the hosting subsidiary.", risk: "High", recommendation: "Request the parent company report." },
        { key: "F-2", observation: "No penetration test in the last year.", risk: "Medium", recommendation: "Request a current summary." },
      ],
    });
    await call("save_assessment_artifact", { ...id, kind: "executive_summary", content: "Acme Corp: approved with conditions.\n" });

    write("\n   Completing now must be refused: the publisher has not written the publication.");
    await call("transition_assessment", { ...id, target: "completed", disposition: "Approved with conditions", risk: "Medium" }, true);

    const verify = await call("verify_publication", id);
    const publicationPath = verify.structuredContent?.path as string;
    write(`\n   The publisher, which is not this server, now writes the publication at ${publicationPath}.`);
    const put = await fetch(`${base}/sim/files/${publicationPath.split("/").map(encodeURIComponent).join("/")}`, { method: "PUT", body: new TextEncoder().encode("docx bytes") });
    if (!put.ok) throw new Error(`the simulated publisher could not write the publication: ${put.status}`);

    await call("verify_publication", id);
    await call("transition_assessment", { ...id, target: "completed", disposition: "Approved with conditions", risk: "Medium" });

    write("\n   A retry of the same transition must write nothing.");
    await call("transition_assessment", { ...id, target: "completed", disposition: "Approved with conditions", risk: "Medium" });
    await call("get_assessment", id);

    const state = (await (await fetch(`${base}/sim/state`)).json()) as { library: { path: string; kind: string }[]; lists: Record<string, unknown[]>; journal: Record<string, unknown[]> };
    write("\nWhat the simulated site holds now:");
    for (const [name, items] of Object.entries(state.lists)) write(`   list ${name}: ${items.length} ${items.length === 1 ? "item" : "items"}`);
    for (const entry of state.library) write(`   ${entry.kind === "folder" ? "folder" : "file  "} ${entry.path}`);
    write(`   journal: ${Object.entries(state.journal).map(([key, entries]) => `${entries.length} under ${key}`).join(", ")}`);
    write(`\nThe walkthrough finished: ${step} tool calls, every one answered as expected.`);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
