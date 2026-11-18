// tests/scripts/pre-eon/department.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ensureLists, grantWrite, listDefinitionsFor, restoreRead, runProfileWorkflow, type ToolAnswer, type WorkflowProfile } from "../../../scripts/pre-eon/department.js";
import { createSimDeployment } from "../../../scripts/sim/deployment.js";
import { GraphRequestError } from "../../../src/graph/errors.js";
import { loadAnyProfile } from "../../../src/profiles/registry.js";
import { runGetAssessment } from "../../../src/tools/assessment/get.js";
import { runOpenAssessment } from "../../../src/tools/assessment/open.js";
import { runRecordFindings } from "../../../src/tools/assessment/record-findings.js";
import { runSaveAssessmentArtifact } from "../../../src/tools/assessment/save-artifact.js";
import { runTransitionAssessment } from "../../../src/tools/assessment/transition.js";
import { runVerifyPublication } from "../../../src/tools/assessment/verify-publication.js";
import type { ToolContext } from "../../../src/tools/context.js";

const EXAMPLES = ["assessment-example.json", "msp-client-onboarding.json", "msp-security-incident.json"];
const CLIENT = "11111111-2222-3333-4444-555555555555";
const SITE = "https://contoso.sharepoint.com/sites/Example";

function loaded(file: string): WorkflowProfile {
  // Through the server's own loader, so the defaults a profile leaves unset are the ones the tools see.
  return loadAnyProfile(JSON.parse(readFileSync(`examples/profiles/${file}`, "utf8"))) as unknown as WorkflowProfile;
}

type Rule = { method: string; includes: string; answers: unknown[] };

/** A columns listing for each list that answers exactly the columns its definition asks for. */
function columnRules(definitions: Array<{ displayName: string; body: unknown }>): Rule[] {
  return definitions.map((definition) => ({
    method: "GET",
    includes: `/lists/${definition.displayName}/columns`,
    answers: [{ value: [{ name: "Title" }, ...(definition.body as { columns: Array<{ name: string }> }).columns.map((column) => ({ name: column.name }))] }],
  }));
}
function scripted(rules: Rule[]) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const answer = (method: string, path: string, body?: unknown): unknown => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const rule = rules.find((candidate) => candidate.method === method && decodeURIComponent(path).includes(candidate.includes) && candidate.answers.length > 0);
    if (rule === undefined) throw new Error(`no scripted answer for ${method} ${decodeURIComponent(path)}`);
    const next = rule.answers.length > 1 ? rule.answers.shift() : rule.answers[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    calls,
    client: {
      get: async <T>(path: string): Promise<T> => answer("GET", path) as T,
      post: async <T>(path: string, body?: unknown): Promise<T> => answer("POST", path, body) as T,
      patch: async <T>(path: string, body: unknown): Promise<T> => answer("PATCH", path, body) as T,
    },
  };
}

describe("a grant for the server application on a department's site", () => {
  const lookup: Rule = { method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/Example", answers: [{ id: "site-1" }] };

  it("is created with the request the setup command sends when the site has none", async () => {
    const issuer = scripted([lookup, { method: "GET", includes: "/sites/site-1/permissions", answers: [{ value: [] }] }, { method: "POST", includes: "/sites/site-1/permissions", answers: [{ id: "p1", roles: ["write"] }] }]);

    const grant = await grantWrite(issuer.client, SITE, CLIENT);

    expect(grant).toEqual({ siteUrl: SITE, siteId: "site-1", permissionId: "p1", before: undefined, now: "write" });
    expect(issuer.calls.find((call) => call.method === "POST")!.body).toEqual({
      roles: ["write"],
      grantedToIdentities: [{ application: { id: CLIENT, displayName: "Ironwright MCP server application" } }],
    });
  });

  it("is widened when the application already holds one, leaving another application's entry alone", async () => {
    const entries = [
      { id: "theirs", roles: ["write"], grantedToIdentitiesV2: [{ application: { id: "someone-else" } }] },
      { id: "ours", roles: ["read"], grantedToIdentitiesV2: [{ application: { id: CLIENT } }] },
    ];
    const issuer = scripted([lookup, { method: "GET", includes: "/sites/site-1/permissions", answers: [{ value: entries }] }, { method: "PATCH", includes: "/sites/site-1/permissions/ours", answers: [{ id: "ours", roles: ["write"] }] }]);

    const grant = await grantWrite(issuer.client, SITE, CLIENT);

    expect(grant).toMatchObject({ permissionId: "ours", before: "read", now: "write" });
    expect(issuer.calls.filter((call) => call.method !== "GET").map((call) => call.path)).toEqual(["/sites/site-1/permissions/ours"]);
  });

  it("changes nothing when two entries name the application", async () => {
    const entry = (id: string): unknown => ({ id, roles: ["read"], grantedToIdentitiesV2: [{ application: { id: CLIENT } }] });
    const issuer = scripted([lookup, { method: "GET", includes: "/sites/site-1/permissions", answers: [{ value: [entry("a"), entry("b")] }] }]);

    await expect(grantWrite(issuer.client, SITE, CLIENT)).rejects.toThrow("2 permission entries");
    expect(issuer.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  // The grant exists by then, and nothing holds the id to restore it with. The words have to
  // say so, because the runner's summary is the only place the operator will learn of it.
  it("says a grant may stand at write when Graph accepted the grant and answered no id", async () => {
    const issuer = scripted([lookup, { method: "GET", includes: "/sites/site-1/permissions", answers: [{ value: [] }] }, { method: "POST", includes: "/sites/site-1/permissions", answers: [{ roles: ["write"] }] }]);

    await expect(grantWrite(issuer.client, SITE, CLIENT)).rejects.toThrow(
      `A GRANT MAY NOW STAND AT WRITE on ${SITE}: Graph accepted the grant and answered no permission id, so this run cannot put it back to read.`,
    );
  });

  it("is put back to read, answering the roles Graph says it holds", async () => {
    const issuer = scripted([{ method: "PATCH", includes: "/sites/site-1/permissions/p1", answers: [{ id: "p1", roles: ["read"] }] }]);

    expect(await restoreRead(issuer.client, { siteUrl: SITE, siteId: "site-1", permissionId: "p1", before: undefined, now: "write" })).toBe("read");
    expect(issuer.calls[0]!.body).toEqual({ roles: ["read"] });
  });
});

describe("the lists a profile names", () => {
  it("are defined from the profile's own list and column names, with the prose columns taking several lines", () => {
    const definitions = listDefinitionsFor(loaded("msp-security-incident.json"));

    expect(definitions.map((definition) => definition.displayName)).toEqual(["Clients", "Incidents", "Incident Findings"]);
    const columns = (index: number): Array<{ name: string; text: { allowMultipleLines?: boolean } }> => (definitions[index]!.body as { columns: Array<{ name: string; text: { allowMultipleLines?: boolean } }> }).columns;
    expect(columns(0).map((column) => column.name)).toEqual(["FolderName"]);
    expect(columns(1).map((column) => column.name)).toEqual(["IncidentId", "ClientFolder", "Category", "Status", "State", "Resolution", "Severity", "Summary"]);
    expect(columns(1).filter((column) => column.text.allowMultipleLines === true).map((column) => column.name)).toEqual(["Summary"]);
    expect(columns(2).filter((column) => column.text.allowMultipleLines === true).map((column) => column.name)).toEqual(["Observation", "Remediation"]);
  });

  it("are created only where absent, and one that exists is not touched", async () => {
    const definitions = listDefinitionsFor(loaded("msp-security-incident.json"));
    const missing = new GraphRequestError({ method: "GET", path: "x", status: 404, body: JSON.stringify({ error: { code: "itemNotFound" } }) });
    const issuer = scripted([
      ...columnRules(definitions),
      { method: "GET", includes: "/sites/site-1/lists/Clients", answers: [{ id: "l1" }] },
      { method: "GET", includes: "/sites/site-1/lists/Incidents", answers: [missing] },
      { method: "GET", includes: "/sites/site-1/lists/Incident Findings", answers: [missing] },
      { method: "POST", includes: "/sites/site-1/lists", answers: [{ id: "new" }] },
    ]);

    const result = await ensureLists(issuer.client, "site-1", definitions);

    expect(result).toEqual({ created: ["Incidents", "Incident Findings"], existing: ["Clients"] });
    expect(issuer.calls.filter((call) => call.method === "POST").map((call) => (call.body as { displayName: string }).displayName)).toEqual(["Incidents", "Incident Findings"]);
  });

  // SharePoint can give a column another internal name than the one asked for, when the name is
  // already taken on the site. The tools would then write to a column that is not there, and say
  // so one call at a time. Checked here, once, in words that name the list and the columns.
  it("refuses a list that lacks a column its profile maps, naming the list and the columns", async () => {
    const definitions = listDefinitionsFor(loaded("msp-security-incident.json"));
    const rules = columnRules(definitions);
    rules[1] = { method: "GET", includes: "/lists/Incidents/columns", answers: [{ value: [{ name: "Title" }, { name: "IncidentId" }, { name: "ClientFolder" }, { name: "Status" }, { name: "State" }, { name: "Summary" }, { name: "Category0" }] }] };
    const issuer = scripted([...rules, { method: "GET", includes: "/sites/site-1/lists/", answers: [{ id: "l" }] }]);

    await expect(ensureLists(issuer.client, "site-1", definitions)).rejects.toThrow(
      'The list "Incidents" has no column named Category, Resolution, Severity, which the profile maps. Its columns are Title, IncidentId, ClientFolder, Status, State, Summary, Category0.',
    );
  });

  it("says which lists it had already created when a later one lacks a column", async () => {
    const definitions = listDefinitionsFor(loaded("msp-security-incident.json"));
    const missing = new GraphRequestError({ method: "GET", path: "x", status: 404, body: JSON.stringify({ error: { code: "itemNotFound" } }) });
    const rules = columnRules(definitions);
    rules[1] = { method: "GET", includes: "/lists/Incidents/columns", answers: [{ value: [{ name: "Title" }] }] };
    const issuer = scripted([
      ...rules,
      { method: "GET", includes: "/sites/site-1/lists/Clients", answers: [missing] },
      { method: "GET", includes: "/sites/site-1/lists/Incidents", answers: [{ id: "l2" }] },
      { method: "POST", includes: "/sites/site-1/lists", answers: [{ id: "new" }] },
    ]);

    await expect(ensureLists(issuer.client, "site-1", definitions)).rejects.toThrow(/The list "Incidents" has no column named .* Created before this: Clients\.$/);
  });

  it("lets a failure that is not an absent list through, and creates nothing after it", async () => {
    const denied = new GraphRequestError({ method: "GET", path: "x", status: 403, body: JSON.stringify({ error: { code: "accessDenied" } }) });
    const issuer = scripted([{ method: "GET", includes: "/sites/site-1/lists/", answers: [denied] }]);

    await expect(ensureLists(issuer.client, "site-1", listDefinitionsFor(loaded("msp-security-incident.json")))).rejects.toBe(denied);
    expect(issuer.calls.filter((call) => call.method === "POST")).toEqual([]);
  });
});

// The real tool handlers over the simulated tenant, so the orchestration is run against the
// tools it will drive, under each shipped profile.
describe("a profile's whole workflow, driven by its own gates", () => {
  const handlers: Record<string, (input: unknown, context: ToolContext) => Promise<CallToolResult>> = {
    open_assessment: runOpenAssessment,
    save_assessment_artifact: runSaveAssessmentArtifact,
    record_findings: runRecordFindings,
    transition_assessment: runTransitionAssessment,
    verify_publication: runVerifyPublication,
    get_assessment: runGetAssessment,
  };
  const answerOf = (result: CallToolResult): ToolAnswer => ({
    isError: result.isError === true,
    text: result.content.map((entry) => ("text" in entry ? entry.text : "")).join(" "),
    sc: (result.structuredContent as Record<string, unknown> | undefined) ?? {},
  });

  it.each(EXAMPLES)("takes one case from open to completed under %s", async (file) => {
    const d = createSimDeployment({ profilePath: `examples/profiles/${file}`, now: () => new Date("2026-11-17T09:00:00.000Z") });
    const profile = loaded(file);
    const names: string[] = [];

    const result = await runProfileWorkflow(profile, {
      call: async (name, args) => {
        names.push(name);
        return answerOf(await handlers[name]!(args, d.context));
      },
      upload: async (path, bytes) => d.sim.putFile(path, bytes),
      tag: "T1",
    });

    expect(result.verdict, result.detail).toBe("pass");
    expect(result.detail).toContain(`completed from ${profile.lifecycle.status.provisional} as ${profile.lifecycle.status.completed}`);
    const item = d.sim.listItems(profile.lists.assessments.name)[0]!.fields;
    expect(item[profile.lists.assessments.columns.status]).toBe(profile.lifecycle.status.completed);
    expect(d.sim.listItems(profile.lists.findings.name)).toHaveLength(1);
    // Completion was tried before the external kind existed, and refused.
    expect(result.detail).toContain("completion refused until");
    expect(names.filter((name) => name === "transition_assessment")).toHaveLength(3);
  });

  it("uploads a kind produced elsewhere before findings when the findings gate waits on it", async () => {
    const folder = mkdtempSync(join(tmpdir(), "iw-department-"));
    try {
      const input = JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8")) as { lifecycle: Record<string, unknown> };
      input.lifecycle.gates = { findings: ["publication"], provisional: ["dossier"], completed: ["dossier", "publication"] };
      const path = join(folder, "profile.json");
      writeFileSync(path, JSON.stringify(input));
      const d = createSimDeployment({ profilePath: path, now: () => new Date("2026-11-17T09:00:00.000Z") });
      const names: string[] = [];

      const result = await runProfileWorkflow(loadAnyProfile(input) as unknown as WorkflowProfile, {
        call: async (name, args) => {
          names.push(name);
          return answerOf(await handlers[name]!(args, d.context));
        },
        upload: async (target, bytes) => d.sim.putFile(target, bytes),
        tag: "T1",
      });

      expect(result.verdict, result.detail).toBe("pass");
      // Nothing was left to refuse completion on, so the detail does not claim a refusal it never saw.
      expect(result.detail).not.toContain("completion refused");
      expect(names.indexOf("verify_publication")).toBeLessThan(names.indexOf("record_findings"));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("fails when completion is refused for a reason other than the kind it was waiting on", async () => {
    const profile = loaded("msp-client-onboarding.json");
    const result = await runProfileWorkflow(profile, {
      call: async (name, args) => {
        if (name === "open_assessment") return { isError: false, text: "", sc: { assessmentId: "ONB-1" } };
        if (name === "transition_assessment" && args.target === "provisional") return { isError: false, text: "", sc: { status: "Awaiting Handover" } };
        if (name === "transition_assessment") return { isError: true, text: 'The disposition "Onboarded" is not one.', sc: {} };
        return { isError: false, text: "", sc: {} };
      },
      upload: async () => undefined,
      tag: "T1",
    });

    expect(result.verdict).toBe("fail");
    expect(result.detail).toBe('transition_assessment to completed: it was refused, and not for the absent handover: The disposition "Onboarded" is not one.');
  });

  it("stops at the first call that fails and says which", async () => {
    const profile = loaded("msp-client-onboarding.json");
    const result = await runProfileWorkflow(profile, {
      call: async (name) =>
        name === "open_assessment" ? { isError: false, text: "opened", sc: { assessmentId: "ONB-1" } } : { isError: true, text: "Graph refused the write with 403.", sc: {} },
      upload: async () => undefined,
      tag: "T1",
    });

    expect(result).toEqual({ step: "department workflow client-onboarding", verdict: "fail", detail: "save_assessment_artifact intake: Graph refused the write with 403." });
  });

  it("fails when completion is not refused while its external kind is absent", async () => {
    const profile = loaded("msp-client-onboarding.json");
    const result = await runProfileWorkflow(profile, {
      call: async (name, args) => {
        if (name === "open_assessment") return { isError: false, text: "", sc: { assessmentId: "ONB-1" } };
        if (name === "transition_assessment") return { isError: false, text: "", sc: { status: args.target === "provisional" ? "Awaiting Handover" : "Completed", previousStatus: "Awaiting Handover" } };
        return { isError: false, text: "", sc: {} };
      },
      upload: async () => undefined,
      tag: "T1",
    });

    expect(result.verdict).toBe("fail");
    expect(result.detail).toContain("it was not refused while handover was absent");
  });
});
