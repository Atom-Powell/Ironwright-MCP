// tests/scripts/department-setup.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSetupArguments, prepareSite } from "../../scripts/department-setup.js";
import { listDefinitionsFor, type WorkflowProfile } from "../../scripts/pre-eon/department.js";
import { loadAnyProfile } from "../../src/profiles/registry.js";

describe("the department setup command's arguments", () => {
  it("takes a profile and leaves the grant at write unless told otherwise", () => {
    expect(parseSetupArguments(["--profile=profiles/desk.json"])).toEqual({ profile: "profiles/desk.json", roles: "write", dryRun: false });
  });

  it("takes read for a deployment that only reads, and a dry run", () => {
    expect(parseSetupArguments(["--profile=p.json", "--roles=read", "--dry-run"])).toEqual({ profile: "p.json", roles: "read", dryRun: true });
  });

  it("refuses to run without a profile, saying what the profile is for", () => {
    expect(parseSetupArguments([])).toEqual({ refusal: "--profile=<file> is required: the assessment profile whose site is to be prepared." });
    expect(parseSetupArguments(["--profile="])).toMatchObject({ refusal: expect.stringContaining("--profile=<file> is required") });
  });

  it("refuses a role that is neither read nor write, quoting it", () => {
    expect(parseSetupArguments(["--profile=p.json", "--roles=fullcontrol"])).toEqual({ refusal: '--roles must be read or write, received "fullcontrol".' });
  });

  // An argument that was ignored would run for real when a dry run was meant. Every spelling
  // that is not exactly one of the three is refused, whatever it starts with.
  it.each(["--dryrun", "--dry-run=true", "--dry-runs", "-dry-run", "dry-run", "--profile", "--rolesread"])("refuses %s, so a mistyped dry run cannot become a real run", (argument) => {
    expect(parseSetupArguments(["--profile=p.json", argument])).toEqual({
      refusal: `Unknown argument ${argument}. The arguments are --profile=<file>, --roles=read|write and --dry-run.`,
    });
  });
});

const CLIENT = "11111111-2222-3333-4444-555555555555";
const profile = loadAnyProfile(JSON.parse(readFileSync("examples/profiles/msp-security-incident.json", "utf8"))) as unknown as WorkflowProfile;
const SITE = profile.sites[0]!.siteUrl;
const definitions = listDefinitionsFor(profile);

type Rule = { method: string; includes: string; answers: unknown[] };
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
    writes: (): string[] => calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${decodeURIComponent(call.path)}`),
    client: {
      get: async <T>(path: string): Promise<T> => answer("GET", path) as T,
      post: async <T>(path: string, body?: unknown): Promise<T> => answer("POST", path, body) as T,
      patch: async <T>(path: string, body: unknown): Promise<T> => answer("PATCH", path, body) as T,
    },
  };
}

const columnsOf = (definition: { body: unknown }): Array<{ name: string }> => (definition.body as { columns: Array<{ name: string }> }).columns;
/** A site whose three lists exist with every mapped column, and whose permissions hold what is given. */
function site(permissions: unknown[], more: Rule[] = []): Rule[] {
  return [
    ...more,
    ...definitions.map((definition) => ({ method: "GET", includes: `/lists/${definition.displayName}/columns`, answers: [{ value: [{ name: "Title" }, ...columnsOf(definition)] }] })),
    { method: "GET", includes: "/sites/site-1/permissions", answers: [{ value: permissions }] },
    { method: "GET", includes: "/sites/site-1/lists/", answers: [{ id: "list" }] },
    { method: "GET", includes: new URL(SITE).pathname, answers: [{ id: "site-1" }] },
  ];
}
const ours = (roles: string): unknown => ({ id: "ours", roles: [roles], grantedToIdentitiesV2: [{ application: { id: CLIENT } }] });

async function run(issuer: ReturnType<typeof scripted>, roles: "read" | "write", dryRun = false): Promise<{ lines: string[]; failure: unknown }> {
  const lines: string[] = [];
  const failure = await prepareSite({ issuer: issuer.client, profile, clientId: CLIENT, roles, dryRun, print: (line) => lines.push(line) }).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { lines, failure };
}

describe("preparing a department's site", () => {
  it("checks the lists, then grants write, and says what Graph answered", async () => {
    const issuer = scripted(site([ours("read")], [{ method: "PATCH", includes: "/permissions/ours", answers: [{ id: "ours", roles: ["write"] }] }]));

    const { lines, failure } = await run(issuer, "write");

    expect(failure).toBeUndefined();
    expect(issuer.writes()).toEqual(["PATCH /sites/site-1/permissions/ours"]);
    expect(lines).toEqual([
      "Lists created: none. Already there: Clients, Incidents, Incident Findings. Each has the columns the profile maps.",
      `Grant on ${SITE}: was read, now write.`,
      `Add ${SITE} to IW_SITE_URL on the server, and index the columns docs/SETUP.md names.`,
    ]);
  });

  // The lists come first so that a list problem is found with the grant untouched.
  it("leaves the grant as it was when a list lacks a column the profile maps", async () => {
    const short: Rule = { method: "GET", includes: "/lists/Incidents/columns", answers: [{ value: [{ name: "Title" }] }] };
    const issuer = scripted(site([ours("read")], [short]));

    const { failure } = await run(issuer, "read");

    expect((failure as Error).message).toContain('The list "Incidents" has no column named');
    expect(issuer.writes()).toEqual([]);
  });

  it("refuses before anything is made when more than one entry names the application", async () => {
    const issuer = scripted(site([ours("read"), { ...(ours("write") as object), id: "also-ours" }]));

    const { failure } = await run(issuer, "write");

    expect((failure as Error).message).toBe(`2 permission entries on ${SITE} name the server application. Nothing was changed. Remove all but one in the site's permissions and run this again.`);
    expect(issuer.writes()).toEqual([]);
  });

  it("fails when the grant did not come back as write, and does not say it was granted", async () => {
    const issuer = scripted(site([ours("read")], [{ method: "PATCH", includes: "/permissions/ours", answers: [{ id: "ours", roles: ["read"] }] }]));

    const { lines, failure } = await run(issuer, "write");

    expect((failure as Error).message).toBe(`The grant on ${SITE} answered roles read, not write. The lifecycle tools need write.`);
    expect(lines.some((line) => line.startsWith("Grant on"))).toBe(false);
  });

  it("sets the grant to read when asked, and says so only when Graph answers read", async () => {
    const issuer = scripted(site([], [
      { method: "POST", includes: "/sites/site-1/permissions", answers: [{ id: "new", roles: ["write"] }] },
      { method: "PATCH", includes: "/permissions/new", answers: [{ id: "new", roles: ["read"] }] },
    ]));

    const { lines, failure } = await run(issuer, "read");

    expect(failure).toBeUndefined();
    expect(issuer.calls.at(-1)).toMatchObject({ method: "PATCH", body: { roles: ["read"] } });
    expect(lines).toContain(`Grant on ${SITE}: created at write, then set to read as asked. Roles now read.`);
  });

  it("says the grant may still be at write when the update to read answers anything else", async () => {
    const issuer = scripted(site([], [
      { method: "POST", includes: "/sites/site-1/permissions", answers: [{ id: "new", roles: ["write"] }] },
      { method: "PATCH", includes: "/permissions/new", answers: [{ id: "new", roles: ["write"] }] },
    ]));

    const { lines, failure } = await run(issuer, "read");

    expect((failure as Error).message).toBe(`THE GRANT MAY STILL BE AT WRITE on ${SITE}: read was asked for, and the update to read answered roles write.`);
    expect(lines.some((line) => line.includes("set to read"))).toBe(false);
  });

  it("says the grant may still be at write when the update to read fails", async () => {
    const issuer = scripted(site([], [
      { method: "POST", includes: "/sites/site-1/permissions", answers: [{ id: "new", roles: ["write"] }] },
      { method: "PATCH", includes: "/permissions/new", answers: [new Error("socket hang up")] },
    ]));

    const { failure } = await run(issuer, "read");

    expect((failure as Error).message).toBe(`THE GRANT MAY STILL BE AT WRITE on ${SITE}: read was asked for, and the update to read failed: socket hang up`);
  });

  it("changes nothing on a dry run, and says what the grant is now and what a run would do", async () => {
    const issuer = scripted(site([ours("write")]));

    const { lines, failure } = await run(issuer, "read", true);

    expect(failure).toBeUndefined();
    expect(issuer.writes()).toEqual([]);
    expect(lines[0]).toBe(`Dry run for profile "security-incidents" on ${SITE}. Nothing was changed.`);
    expect(lines[1]).toBe(`The server application ${CLIENT} holds a grant with roles write. A run would set it to write and then to read.`);
    expect(lines[2]).toMatch(/^The list "Clients" exists and would be checked for the columns /);
    expect(lines).toHaveLength(5);
  });

  it("says on a dry run that a grant would be created when the application holds none", async () => {
    const issuer = scripted(site([]));

    const { lines } = await run(issuer, "write", true);

    expect(lines[1]).toBe(`The server application ${CLIENT} holds no grant on the site. A run would create one at write.`);
    expect(issuer.writes()).toEqual([]);
  });
});
