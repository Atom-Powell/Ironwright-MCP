// scripts/pre-eon/campaign.ts
/**
 * The pre-EON test campaign for the assessment module, run against a live
 * server on the developer tenant. See docs/superpowers/plans/2026-11-09-pre-eon-test-campaign.md
 * for what each scenario is for and what a pass looks like.
 *
 *   npm run campaign                 runs every scenario
 *   npm run campaign -- --only=s1,s4 runs the named ones
 *
 * It drives the server over MCP (IW_SITTING_URL, default http://127.0.0.1:3000/mcp)
 * and does the out-of-band steps directly against Graph under the server
 * application's own token: deleting a folder, renaming a file, editing a list
 * item by hand. The server never does those, which is why a scenario that needs
 * one has to. Each scenario uses a vendor name of its own, so it never touches
 * another's data, and nothing is deleted except a folder or file the scenario
 * itself just created.
 *
 * Reads IW_TENANT_ID, IW_CLIENT_ID, IW_CLIENT_SECRET, IW_SITE_URL. The server
 * must be running with IW_ALLOW_WRITES=true and the grant at write.
 *
 * Prints one table and writes the full results under .superpowers/campaign/,
 * which is git-ignored. Printed text has ids, ETags and URLs redacted.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GRAPH_BASE } from "../../src/graph/client.js";
import { siteLookupPath } from "../../src/graph/drive.js";
import { clientCredentialsTokenProvider, requireExactRoles, SERVER_TOKEN_ROLES } from "../../src/graph/token.js";

const PROFILE = process.env.IW_CAMPAIGN_PROFILE?.trim() || "assessment-sitting";
const LIBRARY = process.env.IW_CAMPAIGN_LIBRARY?.trim() || "Documents";
const LIST_PREFIX = process.env.IW_CAMPAIGN_LIST_PREFIX?.trim() || "IW Probe";
const SERVER_URL = process.env.IW_SITTING_URL?.trim() || "http://127.0.0.1:3000/mcp";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

type Verdict = "PASS" | "FAIL" | "MEASURED";
interface Outcome {
  scenario: string;
  verdict: Verdict;
  summary: string;
  detail: Record<string, unknown>;
}

interface ToolResult {
  isError: boolean;
  text: string;
  sc: Record<string, unknown>;
}

interface GraphResult {
  status: number;
  body: unknown;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const tag = new Date().toISOString().replace(/[-:T]/g, "").slice(4, 12);

function redact(text: string): string {
  return text
    .replace(/\{[0-9A-Fa-f-]{36}\},\d+/g, "{ETAG}")
    .replace(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g, "GUID")
    .replace(/https:\/\/[^\s"]*/g, "URL");
}

// A path segment is encoded one at a time: encoding the whole path would turn
// the separators into %2F, which Graph's path addressing reads as part of a name.
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

async function main(): Promise<void> {
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",");

  const tokenProvider = requireExactRoles(
    clientCredentialsTokenProvider({ tenantId: env("IW_TENANT_ID"), clientId: env("IW_CLIENT_ID"), clientSecret: env("IW_CLIENT_SECRET") }),
    SERVER_TOKEN_ROLES,
  );
  const siteUrl = env("IW_SITE_URL");

  async function graph(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<GraphResult> {
    const token = await tokenProvider.getToken();
    const isBytes = typeof body === "string";
    const response = await fetch(path.startsWith("http") ? path : `${GRAPH_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": isBytes ? "application/octet-stream" : "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: isBytes ? (body as string) : JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  }

  const site = await graph("GET", `${siteLookupPath(siteUrl)}?$select=id`);
  const siteId = (site.body as { id?: string }).id;
  if (site.status !== 200 || typeof siteId !== "string") throw new Error(`could not resolve ${siteUrl}: ${site.status}`);
  const drives = await graph("GET", `/sites/${siteId}/drives?$select=id,name`);
  const driveId = ((drives.body as { value?: Array<{ id: string; name: string }> }).value ?? []).find((d) => d.name === LIBRARY)?.id;
  if (driveId === undefined) throw new Error(`library "${LIBRARY}" not found on the site`);

  const driveItem = (path: string): string => `/drives/${driveId}/root:/${encodePath(path)}`;
  const assessmentsList = `/sites/${siteId}/lists/${encodeURIComponent(`${LIST_PREFIX} Assessments`)}/items`;
  const exists = async (path: string): Promise<boolean> => (await graph("GET", `${driveItem(path)}?$select=id`)).status === 200;

  const mcp = new Client({ name: "iw-campaign", version: "0.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(SERVER_URL)));

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await mcp.callTool({ name, arguments: { profileId: PROFILE, ...args } });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    return { isError: result.isError === true, text, sc: ((result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}) };
  }

  const open = (vendor: string) => call("open_assessment", { vendor, scope: "Security" });
  const saveDossier = (id: string, content: string) => call("save_assessment_artifact", { assessmentId: id, kind: "dossier", content });
  const brief = (r: ToolResult) => ({ isError: r.isError, text: redact(r.text).slice(0, 300), sc: pick(r.sc) });
  const pick = (sc: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of ["assessmentId", "created", "resumed", "operation", "stage", "present", "transitioned", "refused", "observed", "expected", "found"]) if (k in sc) out[k] = sc[k];
    return out;
  };
  const vendorOf = (n: string) => `Campaign ${n} ${tag}`;
  const publicationName = (vendor: string, id: string) => `${vendor}_${id}_Risk_Assessment.docx`;

  async function itemFor(id: string): Promise<{ itemId: string; fields: Record<string, unknown> } | undefined> {
    const q = await graph("GET", `${assessmentsList}?$expand=fields&$filter=${encodeURIComponent(`fields/AssessmentId eq '${id}'`)}`, undefined, {
      Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
    });
    const first = ((q.body as { value?: Array<{ id: string; fields: Record<string, unknown> }> }).value ?? [])[0];
    return first === undefined ? undefined : { itemId: first.id, fields: first.fields };
  }

  const scenarios: Array<{ key: string; name: string; run: () => Promise<Omit<Outcome, "scenario">> }> = [
    {
      key: "s1",
      name: "implicit parent folder on a content PUT",
      run: async () => {
        const vendor = vendorOf("S1");
        const opened = await open(vendor);
        const id = String(opened.sc.assessmentId);
        const root = String(opened.sc.workspaceRoot);
        const del = await graph("DELETE", driveItem(`${root}/Published`));
        const saved = await call("save_assessment_artifact", { assessmentId: id, kind: "executive_summary", content: "# Summary\n\nWritten after Published was deleted.\n" });
        const recreated = await exists(`${root}/Published`);
        return {
          verdict: "MEASURED",
          summary: `Published deleted (${del.status}); save ${saved.isError ? "was refused" : `answered ${String(saved.sc.operation)}`}; Published ${recreated ? "EXISTS again" : "is still absent"}`,
          detail: { deleteStatus: del.status, save: brief(saved), publishedRecreated: recreated },
        };
      },
    },
    {
      key: "s2",
      name: "publication name case on lookup",
      run: async () => {
        const vendor = vendorOf("S2");
        const opened = await open(vendor);
        const id = String(opened.sc.assessmentId);
        const root = String(opened.sc.workspaceRoot);
        await saveDossier(id, "# Dossier\n\nFor the case test.\n");
        const exact = publicationName(vendor, id);
        const lower = exact.toLowerCase();
        const up = await graph("PUT", `${driveItem(`${root}/Published/${lower}`)}:/content`, "placeholder publication\n");
        const verifyLower = await call("verify_publication", { assessmentId: id });
        const getLower = await call("get_assessment", { assessmentId: id });
        const pubPresent = ((getLower.sc.artifacts as Array<{ kind: string; present: boolean }> | undefined) ?? []).find((a) => a.kind === "publication")?.present;
        const transition = await call("transition_assessment", { assessmentId: id, target: "completed", disposition: "Approved", risk: "Low" });
        const completedWithWrongName = !transition.isError && transition.sc.transitioned === true;
        // The rename runs either way, so the run also shows that the correctly named file is then accepted.
        const item = await graph("GET", `${driveItem(`${root}/Published/${lower}`)}?$select=id`);
        const itemId = (item.body as { id?: string }).id;
        if (itemId !== undefined) await graph("PATCH", `/drives/${driveId}/items/${itemId}`, { name: exact });
        const renamed = await call("verify_publication", { assessmentId: id });
        const verdict: Verdict = verifyLower.sc.present === false && pubPresent === false && !completedWithWrongName && renamed.sc.present === true ? "PASS" : "FAIL";
        return {
          verdict,
          summary: `uploaded ${up.status}; verify with wrong case present=${String(verifyLower.sc.present)}; get_assessment publication present=${String(pubPresent)}; transition with wrong case ${completedWithWrongName ? "COMPLETED (defect)" : "refused"}; after rename verify present=${String(renamed.sc.present)}`,
          detail: { upload: up.status, verifyLower: brief(verifyLower), getPublicationPresent: pubPresent, transition: brief(transition), afterRename: brief(renamed) },
        };
      },
    },
    {
      key: "s3",
      name: "executive summary create, read back, overwrite",
      run: async () => {
        const id = String((await open(vendorOf("S3"))).sc.assessmentId);
        const a = "# Executive summary\n\nFirst version.\n";
        const b = "# Executive summary\n\nSecond version, changed.\n";
        const created = await call("save_assessment_artifact", { assessmentId: id, kind: "executive_summary", content: a });
        const read = await call("read_assessment_artifact", { assessmentId: id, kind: "executive_summary" });
        const over = await call("save_assessment_artifact", { assessmentId: id, kind: "executive_summary", content: b });
        const ok =
          created.sc.operation === "created" &&
          created.sc.sha256 === sha256(a) &&
          !read.isError &&
          over.sc.operation === "overwritten" &&
          over.sc.sha256 === sha256(b);
        return {
          verdict: ok ? "PASS" : "FAIL",
          summary: `create ${String(created.sc.operation)} (hash ${created.sc.sha256 === sha256(a) ? "matches" : "DIFFERS"}), read ${read.isError ? "FAILED" : "ok"}, overwrite ${String(over.sc.operation)} (stage ${String(over.sc.stage)})`,
          detail: { created: brief(created), read: brief(read), overwrite: brief(over) },
        };
      },
    },
    {
      key: "s4",
      name: "four concurrent opens for one vendor",
      run: async () => {
        const vendor = vendorOf("S4");
        const results = await Promise.all([open(vendor), open(vendor), open(vendor), open(vendor)]);
        const ids = new Set(results.map((r) => String(r.sc.assessmentId)));
        const q = await graph("GET", `${assessmentsList}?$expand=fields&$filter=${encodeURIComponent(`fields/VendorFolder eq '${vendor}'`)}`, undefined, {
          Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
        });
        const items = ((q.body as { value?: unknown[] }).value ?? []).length;
        const errors = results.filter((r) => r.isError).length;
        const created = results.filter((r) => r.sc.created === true).length;
        const ok = items === 1 && ids.size === 1 && errors === 0;
        return {
          verdict: ok ? "PASS" : "FAIL",
          summary: `${items} assessment item(s) for the vendor, ${ids.size} distinct id(s) returned, ${created} call(s) reported created, ${errors} error(s)`,
          detail: { items, ids: [...ids], created, errors, results: results.map(brief) },
        };
      },
    },
    {
      key: "s5",
      name: "six concurrent overwrites of one dossier",
      run: async () => {
        const id = String((await open(vendorOf("S5"))).sc.assessmentId);
        await saveDossier(id, "# Dossier\n\nBase version.\n");
        const contents = [1, 2, 3, 4, 5, 6].map((n) => `# Dossier\n\nWriter ${n} says hello.\n`);
        const results = await Promise.all(contents.map((c) => saveDossier(id, c)));
        const read = await call("read_assessment_artifact", { assessmentId: id, kind: "dossier" });
        const finalHash = String(read.sc.sha256 ?? "");
        const written = new Set(contents.map(sha256));
        const overwritten = results.filter((r) => r.sc.operation === "overwritten").length;
        const refused = results.filter((r) => r.isError).length;
        const finalIsOneWriter = written.has(finalHash);
        return {
          verdict: finalIsOneWriter && overwritten >= 1 ? "PASS" : "FAIL",
          summary: `${overwritten} overwritten, ${refused} refused or errored, final content ${finalIsOneWriter ? "is exactly one writer's" : "matches NO writer"}`,
          detail: { overwritten, refused, finalIsOneWriter, refusals: results.filter((r) => r.isError).map((r) => redact(r.text).slice(0, 200)) },
        };
      },
    },
    {
      key: "s6",
      name: "State and Status edited by hand in the list",
      run: async () => {
        const id = String((await open(vendorOf("S6"))).sc.assessmentId);
        await saveDossier(id, "# Dossier\n\nBefore the hand edit.\n");
        const item = await itemFor(id);
        if (item === undefined) return { verdict: "FAIL", summary: "the assessment item could not be found by id", detail: {} };
        const patch = (fields: Record<string, unknown>) => graph("PATCH", `${assessmentsList}/${item.itemId}/fields`, fields);
        const p1 = await patch({ State: "HANDEDIT" });
        const afterState = await call("record_findings", { assessmentId: id, findings: [{ key: "F-1", observation: "x", risk: "Low", recommendation: "y" }], summary: "s" });
        const p2 = await patch({ Status: "Completed" });
        const afterStatus = await saveDossier(id, "# Dossier\n\nAfter someone marked it Completed by hand.\n");
        return {
          verdict: "MEASURED",
          summary: `State=HANDEDIT (${p1.status}): record_findings ${afterState.isError ? "refused" : "proceeded"}; Status=Completed (${p2.status}): a save ${afterStatus.isError ? "was refused" : "WENT THROUGH"}`,
          detail: { afterState: brief(afterState), afterStatus: brief(afterStatus) },
        };
      },
    },
    {
      key: "s7",
      name: "grant boundary: a site the server was never granted",
      run: async () => {
        const host = new URL(siteUrl).host;
        const root = await graph("GET", `/sites/${host}?$select=id`);
        const search = await graph("GET", "/sites?search=*&$select=id");
        const found = ((search.body as { value?: Array<{ id: string }> }).value ?? []).map((s) => s.id);
        const foreign = found.filter((s) => !s.includes(siteId as string));
        const ok = (root.status === 403 || root.status === 404) && foreign.length === 0;
        return {
          verdict: ok ? "PASS" : "FAIL",
          summary: `tenant root site answered ${root.status}; site search found ${found.length} site(s), ${foreign.length} outside the granted one`,
          detail: { rootStatus: root.status, searchStatus: search.status, foreign: foreign.length },
        };
      },
    },
    {
      key: "s8",
      name: "resume after a subfolder goes missing",
      run: async () => {
        const vendor = vendorOf("S8");
        const first = await open(vendor);
        const id = String(first.sc.assessmentId);
        const root = String(first.sc.workspaceRoot);
        const del = await graph("DELETE", driveItem(`${root}/Evidence`));
        const again = await open(vendor);
        const back = await exists(`${root}/Evidence`);
        const q = await graph("GET", `${assessmentsList}?$expand=fields&$filter=${encodeURIComponent(`fields/VendorFolder eq '${vendor}'`)}`, undefined, {
          Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
        });
        const items = ((q.body as { value?: unknown[] }).value ?? []).length;
        const ok = !again.isError && String(again.sc.assessmentId) === id && back && items === 1;
        return {
          verdict: ok ? "PASS" : "FAIL",
          summary: `Evidence deleted (${del.status}); second open ${again.isError ? "errored" : `answered created=${String(again.sc.created)} resumed=${String(again.sc.resumed)}`}; Evidence ${back ? "is back" : "is STILL MISSING"}; ${items} item(s) for the vendor`,
          detail: { del: del.status, again: brief(again), evidenceBack: back, items },
        };
      },
    },
  ];

  const selected = scenarios.filter((s) => only === undefined || only.includes(s.key));
  const outcomes: Outcome[] = [];
  for (const s of selected) {
    process.stderr.write(`running ${s.key} ${s.name}\n`);
    try {
      outcomes.push({ scenario: `${s.key} ${s.name}`, ...(await s.run()) });
    } catch (error) {
      outcomes.push({ scenario: `${s.key} ${s.name}`, verdict: "FAIL", summary: `threw: ${redact(error instanceof Error ? error.message : String(error))}`, detail: {} });
    }
  }
  await mcp.close();

  mkdirSync(".superpowers/campaign", { recursive: true });
  const outFile = `.superpowers/campaign/${tag}-${Date.now()}.json`;
  writeFileSync(outFile, JSON.stringify(outcomes, null, 2));
  console.log("\n| Scenario | Verdict | What happened |\n|---|---|---|");
  for (const o of outcomes) console.log(`| ${o.scenario} | ${o.verdict} | ${o.summary} |`);
  console.log(`\nfull results: ${outFile}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
