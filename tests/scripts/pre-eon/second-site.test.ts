// tests/scripts/pre-eon/second-site.test.ts
import { describe, expect, it } from "vitest";
import { GraphRequestError } from "../../../src/graph/errors.js";
import { probeSecondSite, type SecondSiteInputs } from "../../../scripts/pre-eon/second-site.js";

const FIRST = "https://contoso.sharepoint.com/sites/First";
const SECOND = "https://contoso.sharepoint.com/sites/Second";
const CLIENT = "11111111-2222-3333-4444-555555555555";

type Rule = { method: string; includes: string; answers: unknown[] };

/** A Graph client that answers each request from the first rule matching its verb and path, in order. */
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
      putBytes: async <T>(path: string): Promise<T> => answer("PUT", path) as T,
      getBytes: async (path: string): Promise<Uint8Array> => answer("GETBYTES", path) as Uint8Array,
      requests: () => calls.length,
    },
  };
}

const refused = (path: string): GraphRequestError => new GraphRequestError({ method: "GET", path, status: 403, body: JSON.stringify({ error: { code: "accessDenied" } }) });
const CONTENT = (stamp: string): Uint8Array => new TextEncoder().encode(`Written to the second site by the sitting of ${stamp}.\n`);

function serverRules(stamp: string, before: unknown[]): Rule[] {
  return [
    { method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/Second", answers: [...before, { id: "site-2" }] },
    { method: "GET", includes: "/sites/site-2/drives", answers: [{ value: [{ id: "drive-2", name: "Documents" }] }] },
    { method: "POST", includes: "/drives/drive-2/root/children", answers: [{ id: "f1", name: "IW-MultiSite", folder: {}, eTag: '"f,1"' }] },
    { method: "PUT", includes: `/drives/drive-2/root:/IW-MultiSite/probe ${stamp}.md:/content`, answers: [{ id: "x1", name: `probe ${stamp}.md`, file: {}, eTag: '"x,1"', size: 10 }] },
    { method: "GETBYTES", includes: `/drives/drive-2/root:/IW-MultiSite/probe ${stamp}.md:/content`, answers: [CONTENT(stamp)] },
    { method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/First", answers: [{ id: "site-1" }] },
    { method: "GET", includes: "/sites/site-1/drives", answers: [{ value: [{ id: "drive-1", name: "Documents" }] }] },
  ];
}

function inputs(server: ReturnType<typeof scripted>, issuer: ReturnType<typeof scripted>, stamp = "20261118T000000Z"): SecondSiteInputs {
  return {
    server: server.client,
    issuer: issuer.client,
    firstSiteUrl: FIRST,
    secondSiteUrl: SECOND,
    clientId: CLIENT,
    library: "Documents",
    stamp,
    sleep: async () => {},
    log: () => {},
  };
}

describe("the two site probe", () => {
  it("shows the second site refused before its grant, reachable after it, the first still reachable, and the grant left at read", async () => {
    const stamp = "20261118T000000Z";
    const server = scripted(serverRules(stamp, [refused("/sites/contoso.sharepoint.com:/sites/Second")]));
    const issuer = scripted([
      { method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/Second", answers: [{ id: "site-2" }] },
      { method: "GET", includes: "/sites/site-2/permissions", answers: [{ value: [] }] },
      { method: "POST", includes: "/sites/site-2/permissions", answers: [{ id: "perm-9", roles: ["write"] }] },
      { method: "PATCH", includes: "/sites/site-2/permissions/perm-9", answers: [{ id: "perm-9", roles: ["read"] }] },
    ]);

    const results = await probeSecondSite(inputs(server, issuer, stamp));

    expect(results.map((result) => [result.step, result.verdict])).toEqual([
      ["second site before its grant", "pass"],
      ["grant on the second site", "pass"],
      ["the server application on the second site", "pass"],
      ["the first site under the same token", "pass"],
      ["second site grant restored to read", "pass"],
    ]);
    expect(results[0]!.detail).toContain("403 accessDenied");
    // The grant names the server application and nothing else, in the shape the setup command sends.
    expect(issuer.calls.find((call) => call.method === "POST")!.body).toEqual({
      roles: ["write"],
      grantedToIdentities: [{ application: { id: CLIENT, displayName: "Ironwright MCP server application" } }],
    });
    expect(issuer.calls.find((call) => call.method === "PATCH")!.body).toEqual({ roles: ["read"] });
  });

  // The runner's clean up restores what it holds on record. A grant known only inside the
  // probe would be left at write by an interrupt that cuts the probe off.
  it("hands its grant to the caller while it stands at write, and says when it is back at read", async () => {
    const stamp = "20261118T000000Z";
    const server = scripted(serverRules(stamp, [refused("/sites/contoso.sharepoint.com:/sites/Second")]));
    const issuer = scripted([
      { method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/Second", answers: [{ id: "site-2" }] },
      { method: "GET", includes: "/sites/site-2/permissions", answers: [{ value: [] }] },
      { method: "POST", includes: "/sites/site-2/permissions", answers: [{ id: "perm-9", roles: ["write"] }] },
      { method: "PATCH", includes: "/sites/site-2/permissions/perm-9", answers: [{ id: "perm-9", roles: ["read"] }] },
    ]);
    const events: string[] = [];

    await probeSecondSite({
      ...inputs(server, issuer, stamp),
      onGrant: (grant) => events.push(`granted ${grant.siteUrl} ${grant.siteId} ${grant.permissionId} after ${issuer.calls.filter((call) => call.method === "PATCH").length} restores`),
      onRestored: (grant) => events.push(`restored ${grant.permissionId}`),
    });

    expect(events).toEqual([`granted ${SECOND} site-2 perm-9 after 0 restores`, "restored perm-9"]);
  });

  it("does not say the grant is back at read when the restore answered otherwise", async () => {
    const stamp = "20261118T000000Z";
    const server = scripted(serverRules(stamp, [refused("/sites/contoso.sharepoint.com:/sites/Second")]));
    const issuer = scripted([
      { method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/Second", answers: [{ id: "site-2" }] },
      { method: "GET", includes: "/sites/site-2/permissions", answers: [{ value: [] }] },
      { method: "POST", includes: "/sites/site-2/permissions", answers: [{ id: "perm-9", roles: ["write"] }] },
      { method: "PATCH", includes: "/sites/site-2/permissions/perm-9", answers: [{ id: "perm-9", roles: ["write"] }] },
    ]);
    const events: string[] = [];

    await probeSecondSite({ ...inputs(server, issuer, stamp), onGrant: () => events.push("granted"), onRestored: () => events.push("restored") });

    expect(events).toEqual(["granted"]);
  });

  it("widens a grant an earlier run left at read, and says the site was already reachable", async () => {
    const stamp = "20261118T000000Z";
    const server = scripted(serverRules(stamp, []));
    const issuer = scripted([
      { method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/Second", answers: [{ id: "site-2" }] },
      { method: "GET", includes: "/sites/site-2/permissions", answers: [{ value: [{ id: "perm-9", roles: ["read"], grantedToIdentitiesV2: [{ application: { id: CLIENT } }] }, { id: "other", roles: ["write"], grantedToIdentitiesV2: [{ application: { id: "someone-else" } }] }] }] },
      { method: "PATCH", includes: "/sites/site-2/permissions/perm-9", answers: [{ id: "perm-9", roles: ["write"] }, { id: "perm-9", roles: ["read"] }] },
    ]);

    const results = await probeSecondSite(inputs(server, issuer, stamp));

    expect(results[0]).toMatchObject({ step: "second site before its grant", verdict: "observed" });
    expect(results[0]!.detail).toContain("already answered");
    expect(results[1]).toMatchObject({ verdict: "pass" });
    expect(results[1]!.detail).toContain("widened from read");
    expect(issuer.calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(issuer.calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([{ roles: ["write"] }, { roles: ["read"] }]);
    expect(results.at(-1)).toMatchObject({ step: "second site grant restored to read", verdict: "pass" });
  });

  it("waits for a new grant to take effect, and fails without writing when it never does", async () => {
    const denied = refused("/sites/contoso.sharepoint.com:/sites/Second");
    const server = scripted([{ method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/Second", answers: [denied] }]);
    const issuer = scripted([
      { method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/Second", answers: [{ id: "site-2" }] },
      { method: "GET", includes: "/sites/site-2/permissions", answers: [{ value: [] }] },
      { method: "POST", includes: "/sites/site-2/permissions", answers: [{ id: "perm-9", roles: ["write"] }] },
      { method: "PATCH", includes: "/sites/site-2/permissions/perm-9", answers: [{ id: "perm-9", roles: ["read"] }] },
    ]);
    let slept = 0;

    const results = await probeSecondSite({ ...inputs(server, issuer), sleep: async () => { slept += 1; } });

    expect(slept).toBeGreaterThan(3);
    expect(results.find((result) => result.step === "the server application on the second site")).toMatchObject({ verdict: "fail" });
    expect(server.calls.filter((call) => call.method !== "GET")).toEqual([]);
    // The grant is put back even though the probe failed.
    expect(results.at(-1)).toMatchObject({ step: "second site grant restored to read", verdict: "pass" });
  });

  it("stops before granting when more than one entry on the site names the application", async () => {
    const server = scripted([{ method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/Second", answers: [refused("x")] }]);
    const entry = (id: string): unknown => ({ id, roles: ["read"], grantedToIdentitiesV2: [{ application: { id: CLIENT } }] });
    const issuer = scripted([
      { method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/Second", answers: [{ id: "site-2" }] },
      { method: "GET", includes: "/sites/site-2/permissions", answers: [{ value: [entry("a"), entry("b")] }] },
    ]);

    const results = await probeSecondSite(inputs(server, issuer));

    expect(results.at(-1)).toMatchObject({ step: "grant on the second site", verdict: "fail" });
    expect(results.at(-1)!.detail).toContain("2 permission entries");
    expect(issuer.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("reports a restore that did not answer read as a failure that says the grant may stand at write", async () => {
    const stamp = "20261118T000000Z";
    const server = scripted(serverRules(stamp, [refused("x")]));
    const issuer = scripted([
      { method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/Second", answers: [{ id: "site-2" }] },
      { method: "GET", includes: "/sites/site-2/permissions", answers: [{ value: [] }] },
      { method: "POST", includes: "/sites/site-2/permissions", answers: [{ id: "perm-9", roles: ["write"] }] },
      { method: "PATCH", includes: "/sites/site-2/permissions/perm-9", answers: [new GraphRequestError({ method: "PATCH", path: "p", status: 503, body: "" })] },
    ]);

    const results = await probeSecondSite(inputs(server, issuer, stamp));

    expect(results.at(-1)).toMatchObject({ step: "second site grant restored to read", verdict: "fail" });
    expect(results.at(-1)!.detail).toContain("MAY STILL BE AT WRITE");
  });
});
