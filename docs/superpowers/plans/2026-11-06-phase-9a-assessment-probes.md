# Phase 9a: Assessment Probes and the Grant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every Graph row of the spec's Assumptions table into a dated, recorded observation against the Ironwright developer tenant, so that plans 9c and 9d can be written against evidence rather than belief.

**Architecture:** A probe script under `scripts/assessment-probe/` runs a fixed sequence of Graph requests under the server application's own `Sites.Selected` token, records every request and response, redacts the recording, and writes a report. A seed script creates the three lists the probes need, under the grant issuer's broader token, because list creation is setup work the server never does. The probe plan (which requests, what each proves, how each is judged) is pure data and functions, tested without a tenant; only the runner touches the network.

**Tech Stack:** TypeScript, Node 22, vitest, the existing Graph token provider and client in `src/graph/`, raw `fetch` for the one verb the client lacks (PUT).

## Global Constraints

From `CLAUDE.md` and the spec at `docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md`:

- **No em dashes and no en dashes anywhere**, including string literals, comments and commit messages. `tests/source-hygiene.test.ts` enforces it.
- **No emojis. US English.**
- **Every live step runs on the Ironwright developer tenant.** The employer tenant is never touched.
- **No customer constants in the code.** List names, folder names and site URLs come from the environment; the defaults are invented names.
- **A message states only what the code observed.** A probe verdict names the status and error code it received, never what it expected to receive as though it had.
- **Never log a token, a secret or a key.** The runner reads credentials from the environment and the recording carries presence only.
- **Nothing under `scripts/` is compiled by `npm run build:prod`**, which compiles `src/` only, minus `src/setup`.
- **Test file naming:** happy path in `X.test.ts`, failures in `X.errors.test.ts`.
- **Conventional commits**, each ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `npm run lint`, `npm run typecheck` and `npm test` before every commit.

---

## File Structure

**Created:**
- `scripts/assessment-probe/plan.ts`: the probe steps as data, the judges, the redaction. Pure, no I/O.
- `scripts/assessment-probe/lists.ts`: the three list definitions the seed creates. Pure.
- `scripts/assessment-probe/seed.ts`: creates the lists and the probe root folder under the grant issuer's token. I/O.
- `scripts/assessment-probe/main.ts`: runs the steps, writes the raw and redacted recordings and the report. I/O.
- `tests/scripts/assessment-probe.test.ts`, `tests/scripts/assessment-probe.errors.test.ts`.
- `docs/superpowers/specs/evidence/<run-date>-assessment-probe/recordings.jsonl` and `report.md`: the redacted evidence, committed.

**Modified:**
- `package.json`: two scripts, `probe:assessment` and `probe:assessment:seed`.
- `docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md`: the Assumptions table gains an Evidence column filled from the report.
- `docs/COPILOT-STUDIO-PROBE.md`: A3 and B1 additions.
- `docs/OPEN-ITEMS.md`: the 9a row.

---

## Task 0: Operator preflight (no code, done by hand)

These steps need a signed-in Global Administrator on the Ironwright developer tenant and produce credentials that go into the environment, never into a file in this repository.

- [ ] **Step 1: Stand the grant issuer back up.** Its previous secret expired on 2026-10-01.

```bash
npm run setup -- --tenant=<tenant-id> --create-bootstrap
```

Set the two values it prints as `IW_BOOTSTRAP_CLIENT_ID` and `IW_BOOTSTRAP_CLIENT_SECRET` in the shell that will run the seed. If the command refuses because an application named `Ironwright Grant Issuer` already exists with an expired secret, delete that application in Entra first, as `docs/SETUP.md` says under "Running --create-bootstrap".

- [ ] **Step 2: Widen the server application's grant on the probe site to write.** The server application is the one whose client id is `IW_CLIENT_ID`. Follow the procedure in `docs/SETUP.md` under "Running the normal setup": with the grant issuer's app-only token, `GET /sites/{site-id}/permissions`, find the entry whose `grantedToIdentitiesV2[0].application.id` equals `IW_CLIENT_ID`, and `PATCH` that entry with `{"roles": ["write"]}`. Restore it to `read` after the 9c live sitting. If the server application has no grant on the probe site yet, run the normal setup against that site with `--write` instead.

- [ ] **Step 3: Set the environment for the probe.**

| Variable | Value |
|---|---|
| `IW_TENANT_ID`, `IW_CLIENT_ID`, `IW_CLIENT_SECRET` | the server application, as the server itself uses them |
| `IW_SITE_URL` | the probe site on the developer tenant, the same site the grant covers |
| `IW_PROBE_LIBRARY` | the document library to probe in, default `Shared Documents` |
| `IW_PROBE_LIST_PREFIX` | prefix for the three lists, default `IW Probe` |
| `IW_BOOTSTRAP_CLIENT_ID`, `IW_BOOTSTRAP_CLIENT_SECRET` | the grant issuer, read by the seed only |

Nothing here goes into a session transcript. Describe shapes, not values.

---

## Task 1: The list definitions

**Files:**
- Create: `scripts/assessment-probe/lists.ts`
- Test: `tests/scripts/assessment-probe.test.ts`

**Interfaces:**
- Produces: `listDefinitions(prefix: string): ListDefinition[]` and `type ListDefinition = { displayName: string; body: unknown }`, where `body` is the exact JSON Graph's `POST /sites/{id}/lists` takes. Used by Task 3.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scripts/assessment-probe.test.ts
import { describe, expect, it } from "vitest";
import { listDefinitions } from "../../scripts/assessment-probe/lists.js";

describe("probe list definitions", () => {
  it("defines the three lists the assessment module reads and writes, under the prefix", () => {
    const lists = listDefinitions("IW Probe");
    expect(lists.map((l) => l.displayName)).toEqual(["IW Probe Vendors", "IW Probe Assessments", "IW Probe Findings"]);
  });

  it("gives the assessment list a text AssessmentId column, which the ID stage writes back into", () => {
    const assessments = listDefinitions("IW Probe")[1]!.body as { columns: Array<{ name: string; text?: unknown }> };
    const column = assessments.columns.find((c) => c.name === "AssessmentId");
    expect(column).toBeDefined();
    expect(column!.text).toEqual({});
  });

  it("uses the generic list template for every list", () => {
    for (const list of listDefinitions("X")) {
      expect((list.body as { list: { template: string } }).list.template).toBe("genericList");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scripts/assessment-probe.test.ts`
Expected: FAIL, cannot find module `scripts/assessment-probe/lists.js`.

- [ ] **Step 3: Write the implementation**

```ts
// scripts/assessment-probe/lists.ts
/**
 * The three lists the assessment module treats as the consumer's system of
 * record: vendors, assessments and findings. Column names here are the
 * module's logical field names used directly as internal names, which is the
 * simplest profile a customer could write (an identity column map). A real
 * customer's lists map their own internal names in the profile instead.
 *
 * Created by the seed under the grant issuer's token, never by the server:
 * creating a list is setup, and the server's Sites.Selected grant is for
 * reading and writing items, which is what the probes measure.
 */
export interface ListDefinition {
  displayName: string;
  body: unknown;
}

function text(name: string, multiline = false): unknown {
  return multiline ? { name, text: { allowMultipleLines: true } } : { name, text: {} };
}

export function listDefinitions(prefix: string): ListDefinition[] {
  return [
    {
      displayName: `${prefix} Vendors`,
      body: { displayName: `${prefix} Vendors`, list: { template: "genericList" }, columns: [text("FolderName")] },
    },
    {
      displayName: `${prefix} Assessments`,
      body: {
        displayName: `${prefix} Assessments`,
        list: { template: "genericList" },
        columns: [
          text("AssessmentId"),
          text("VendorFolder"),
          text("Scope"),
          text("Status"),
          text("State"),
          text("Disposition"),
          text("Risk"),
          text("Summary", true),
        ],
      },
    },
    {
      displayName: `${prefix} Findings`,
      body: {
        displayName: `${prefix} Findings`,
        list: { template: "genericList" },
        columns: [text("AssessmentId"), text("FindingKey"), text("Observation", true), text("Risk"), text("Recommendation", true)],
      },
    },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scripts/assessment-probe.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/assessment-probe/lists.ts tests/scripts/assessment-probe.test.ts
git commit -m "feat(probe): define the three lists the assessment probes need"
```

---

## Task 2: The probe plan, judges and redaction

**Files:**
- Create: `scripts/assessment-probe/plan.ts`
- Test: `tests/scripts/assessment-probe.test.ts` (extend), `tests/scripts/assessment-probe.errors.test.ts`

**Interfaces:**
- Produces, used by Task 4:

```ts
export interface ProbeContext {
  graphBase: string;          // "https://graph.microsoft.com/v1.0"
  siteUrl: string;
  library: string;
  listPrefix: string;
  runId: string;              // e.g. "20261107T093000Z"
  siteId?: string; driveId?: string; itemId?: string;
  folderEtag?: string; fileEtag?: string; newEtag?: string;
}
export interface ProbeRequest {
  method: "GET" | "POST" | "PATCH" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: string;              // already serialized
  readBodyAsText?: boolean;   // for the content read-back, which is not JSON
}
export interface ProbeResponse { status: number; headers: Record<string, string>; body: string }
export type Verdict = { kind: "pass" } | { kind: "fail"; because: string } | { kind: "observed"; note: string };
export interface ProbeStep {
  id: string;                 // "R1", "L1", "F2b"
  assumption: string;         // the spec row this feeds, in words
  expected: string;
  request(ctx: ProbeContext): ProbeRequest;
  judge(res: ProbeResponse, ctx: ProbeContext): Verdict;
  capture?(res: ProbeResponse, ctx: ProbeContext): void;
}
export function probeSteps(): ProbeStep[];
export interface ProbeRecord { id: string; assumption: string; expected: string; request: ProbeRequest; response: ProbeResponse; verdict: Verdict }
export function redact(record: ProbeRecord, ctx: ProbeContext): ProbeRecord;
export function reportMarkdown(records: ProbeRecord[], runId: string): string;
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/scripts/assessment-probe.test.ts`:

```ts
import { probeSteps, redact, reportMarkdown, type ProbeContext, type ProbeRecord } from "../../scripts/assessment-probe/plan.js";

function ctx(overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    graphBase: "https://graph.microsoft.com/v1.0",
    siteUrl: "https://contoso.sharepoint.com/sites/Probe",
    library: "Shared Documents",
    listPrefix: "IW Probe",
    runId: "20261107T093000Z",
    siteId: "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222",
    driveId: "b!driveid",
    itemId: "17",
    fileEtag: '"{AAAA},1"',
    ...overrides,
  };
}

function step(id: string) {
  const found = probeSteps().find((s) => s.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
}

describe("probe steps", () => {
  it("runs in the order the spec's assumptions depend on each other", () => {
    expect(probeSteps().map((s) => s.id)).toEqual([
      "R1", "R2", "L1", "L2a", "L2b", "L1b", "L3a", "L3b", "F0", "F1a", "F1b", "F2a", "F2b", "F3a", "F3b", "F4",
    ]);
  });

  it("resolves the site by hostname and server-relative path", () => {
    expect(step("R1").request(ctx()).url).toBe("https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/Probe?$select=id");
  });

  it("reads list items by list display name under the site, expanding fields", () => {
    expect(step("L1").request(ctx()).url).toBe(
      "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222/lists/IW%20Probe%20Assessments/items?$expand=fields&$top=5",
    );
  });

  it("creates the assessment item with a title carrying the run id and no AssessmentId yet", () => {
    const req = step("L2a").request(ctx());
    expect(req.method).toBe("POST");
    expect(JSON.parse(req.body!)).toEqual({ fields: { Title: "probe 20261107T093000Z", VendorFolder: "ProbeVendor", Status: "In Progress" } });
  });

  it("captures the item id from the create response and writes the rendered id back", () => {
    const c = ctx({ itemId: undefined });
    step("L2a").capture!({ status: 201, headers: {}, body: JSON.stringify({ id: "17" }) }, c);
    expect(c.itemId).toBe("17");
    const patch = step("L2b").request(c);
    expect(patch.method).toBe("PATCH");
    expect(patch.url.endsWith("/lists/IW%20Probe%20Assessments/items/17/fields")).toBe(true);
    expect(JSON.parse(patch.body!)).toEqual({ AssessmentId: "PRB-20261107T093000Z-00017" });
  });

  it("sends the non-indexed query header only on L3b", () => {
    expect(step("L3a").request(ctx()).headers?.["Prefer"]).toBeUndefined();
    expect(step("L3b").request(ctx()).headers?.["Prefer"]).toBe("HonorNonIndexedQueriesWarningMayFailRandomly");
  });

  it("creates the probe folder with conflictBehavior fail", () => {
    const req = step("F1a").request(ctx());
    expect(req.url).toBe("https://graph.microsoft.com/v1.0/drives/b!driveid/root:/IW-Probe:/children");
    expect(JSON.parse(req.body!)).toEqual({ name: "probe-20261107T093000Z", folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
  });

  it("creates the file by content PUT with conflictBehavior fail in the query and text/plain content", () => {
    const req = step("F2a").request(ctx());
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(
      "https://graph.microsoft.com/v1.0/drives/b!driveid/root:/IW-Probe/probe-20261107T093000Z/dossier.md:/content?@microsoft.graph.conflictBehavior=fail",
    );
    expect(req.headers?.["content-type"]).toBe("text/plain");
    expect(req.body).toBe("# probe\n");
  });

  it("overwrites under If-Match with the captured etag and no conflict query", () => {
    const req = step("F3a").request(ctx());
    expect(req.url.includes("conflictBehavior")).toBe(false);
    expect(req.headers?.["if-match"]).toBe('"{AAAA},1"');
    expect(req.body).toBe("# probe v2\n");
  });

  it("reads the file content back as text", () => {
    const req = step("F4").request(ctx());
    expect(req.url.endsWith("/dossier.md:/content")).toBe(true);
    expect(req.readBodyAsText).toBe(true);
  });
});

describe("judges", () => {
  it("passes F1b only on a 409 whose error code is nameAlreadyExists", () => {
    const body = JSON.stringify({ error: { code: "nameAlreadyExists", message: "x" } });
    expect(step("F1b").judge({ status: 409, headers: {}, body }, ctx())).toEqual({ kind: "pass" });
  });

  it("passes F3b only on a 412", () => {
    expect(step("F3b").judge({ status: 412, headers: {}, body: "{}" }, ctx())).toEqual({ kind: "pass" });
  });

  it("passes F3a when the response etag differs from the one sent", () => {
    const res = { status: 200, headers: {}, body: JSON.stringify({ eTag: '"{AAAA},2"' }) };
    expect(step("F3a").judge(res, ctx())).toEqual({ kind: "pass" });
  });

  it("passes F4 when the content read back is the overwritten text", () => {
    expect(step("F4").judge({ status: 200, headers: {}, body: "# probe v2\n" }, ctx())).toEqual({ kind: "pass" });
  });

  it("records L3a as observed rather than failed whichever way it answers, since both outcomes inform the design", () => {
    expect(step("L3a").judge({ status: 400, headers: {}, body: "{}" }, ctx()).kind).toBe("observed");
    expect(step("L3a").judge({ status: 200, headers: {}, body: JSON.stringify({ value: [{ id: "17" }] }) }, ctx())).toEqual({ kind: "pass" });
  });
});

describe("redaction", () => {
  it("replaces the site id, drive id, host, item id and every etag with stable placeholders", () => {
    const c = ctx();
    const record: ProbeRecord = {
      id: "F3a",
      assumption: "a",
      expected: "e",
      request: { method: "PUT", url: `${c.graphBase}/drives/${c.driveId}/root:/x:/content`, headers: { "if-match": '"{AAAA},1"' } },
      response: { status: 200, headers: {}, body: JSON.stringify({ eTag: '"{AAAA},2"', id: "17", webUrl: "https://contoso.sharepoint.com/sites/Probe/x" }) },
      verdict: { kind: "pass" },
    };
    const out = redact(record, c);
    expect(out.request.url).toBe("https://graph.microsoft.com/v1.0/drives/<drive-id>/root:/x:/content");
    expect(out.request.headers?.["if-match"]).toBe("<etag-1>");
    expect(out.response.body).toContain('"eTag":"<etag-2>"');
    expect(out.response.body).not.toContain("contoso");
    expect(out.response.body).toContain("<host>");
  });

  it("never carries an Authorization header into the record", () => {
    const record: ProbeRecord = {
      id: "R1", assumption: "a", expected: "e",
      request: { method: "GET", url: "u", headers: { authorization: "Bearer abc" } },
      response: { status: 200, headers: {}, body: "{}" },
      verdict: { kind: "pass" },
    };
    expect(redact(record, ctx()).request.headers?.["authorization"]).toBeUndefined();
  });
});

describe("report", () => {
  it("writes one row per step with the verdict and the observed status", () => {
    const records: ProbeRecord[] = [{
      id: "L1", assumption: "Sites.Selected reaches list items", expected: "200",
      request: { method: "GET", url: "u" }, response: { status: 200, headers: {}, body: "{}" }, verdict: { kind: "pass" },
    }];
    const md = reportMarkdown(records, "20261107T093000Z");
    expect(md).toContain("| L1 | Sites.Selected reaches list items | 200 | 200 | pass |");
    expect(md).toContain("20261107T093000Z");
  });
});
```

And the errors file:

```ts
// tests/scripts/assessment-probe.errors.test.ts
import { describe, expect, it } from "vitest";
import { probeSteps, type ProbeContext } from "../../scripts/assessment-probe/plan.js";

const base: ProbeContext = {
  graphBase: "https://graph.microsoft.com/v1.0",
  siteUrl: "https://contoso.sharepoint.com/sites/Probe",
  library: "Shared Documents",
  listPrefix: "IW Probe",
  runId: "20261107T093000Z",
};

function step(id: string) {
  return probeSteps().find((s) => s.id === id)!;
}

describe("probe steps refuse to run ahead of what they depend on", () => {
  it("L1 throws when the site id has not been captured", () => {
    expect(() => step("L1").request(base)).toThrow(/siteId/);
  });

  it("F1a throws when the drive id has not been captured", () => {
    expect(() => step("F1a").request({ ...base, siteId: "s" })).toThrow(/driveId/);
  });

  it("F3a throws when no file etag was captured, rather than sending an unguarded overwrite", () => {
    expect(() => step("F3a").request({ ...base, siteId: "s", driveId: "d" })).toThrow(/fileEtag/);
  });
});

describe("judges name what they saw", () => {
  it("F1b fails on a 201, naming the status, because a second create must not succeed", () => {
    const v = step("F1b").judge({ status: 201, headers: {}, body: "{}" }, { ...base, driveId: "d" });
    expect(v).toEqual({ kind: "fail", because: "expected 409 nameAlreadyExists, received 201" });
  });

  it("F3b fails on a 200, naming the status, because a stale precondition must be refused", () => {
    const v = step("F3b").judge({ status: 200, headers: {}, body: "{}" }, { ...base, driveId: "d", fileEtag: "e" });
    expect(v).toEqual({ kind: "fail", because: "expected 412, received 200" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scripts/assessment-probe.test.ts tests/scripts/assessment-probe.errors.test.ts`
Expected: FAIL, cannot find module `scripts/assessment-probe/plan.js`.

- [ ] **Step 3: Write the implementation**

```ts
// scripts/assessment-probe/plan.ts
import { siteLookupPath } from "../../src/graph/drive.js";
import { graphErrorCodeFromBody } from "../../src/graph/errors.js";

/**
 * The probe sequence for the assessment domain's Graph assumptions. Pure: a
 * step builds a request from the context and judges a response, and the
 * runner in main.ts is the only thing that sends anything. Each step names
 * the spec row it feeds, so the report reads straight into the Assumptions
 * table.
 *
 * Steps depend on captures from earlier steps (site id, drive id, item id,
 * etags). A step whose capture is missing throws rather than sending a
 * request with a hole in it, because a probe that sends an overwrite with no
 * If-Match would "pass" by testing nothing.
 */
export interface ProbeContext {
  graphBase: string;
  siteUrl: string;
  library: string;
  listPrefix: string;
  runId: string;
  siteId?: string;
  driveId?: string;
  itemId?: string;
  folderEtag?: string;
  fileEtag?: string;
  newEtag?: string;
}

export interface ProbeRequest {
  method: "GET" | "POST" | "PATCH" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  readBodyAsText?: boolean;
}

export interface ProbeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Verdict = { kind: "pass" } | { kind: "fail"; because: string } | { kind: "observed"; note: string };

export interface ProbeStep {
  id: string;
  assumption: string;
  expected: string;
  request(ctx: ProbeContext): ProbeRequest;
  judge(res: ProbeResponse, ctx: ProbeContext): Verdict;
  capture?(res: ProbeResponse, ctx: ProbeContext): void;
}

export interface ProbeRecord {
  id: string;
  assumption: string;
  expected: string;
  request: ProbeRequest;
  response: ProbeResponse;
  verdict: Verdict;
}

const PROBE_ROOT = "IW-Probe";

function need<K extends "siteId" | "driveId" | "itemId" | "fileEtag">(ctx: ProbeContext, key: K): NonNullable<ProbeContext[K]> {
  const value = ctx[key];
  if (value === undefined) throw new Error(`step needs ${key}, which no earlier step captured`);
  return value as NonNullable<ProbeContext[K]>;
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function etagOf(body: string): string | undefined {
  const parsed = parse(body) as { eTag?: unknown } | undefined;
  return typeof parsed?.eTag === "string" ? parsed.eTag : undefined;
}

function expectStatus(status: number, label: string): (res: ProbeResponse) => Verdict {
  return (res) => (res.status === status ? { kind: "pass" } : { kind: "fail", because: `expected ${label}, received ${res.status}` });
}

function listUrl(ctx: ProbeContext, suffix: string): string {
  const name = encodeURIComponent(`${ctx.listPrefix} Assessments`);
  return `${ctx.graphBase}/sites/${need(ctx, "siteId")}/lists/${name}/items${suffix}`;
}

function renderedId(ctx: ProbeContext): string {
  return `PRB-${ctx.runId}-${need(ctx, "itemId").padStart(5, "0")}`;
}

function folderName(ctx: ProbeContext): string {
  return `probe-${ctx.runId}`;
}

function filePath(ctx: ProbeContext): string {
  return `${PROBE_ROOT}/${folderName(ctx)}/dossier.md`;
}

function json(method: ProbeRequest["method"], url: string, body: unknown, headers: Record<string, string> = {}): ProbeRequest {
  return { method, url, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

export function probeSteps(): ProbeStep[] {
  return [
    {
      id: "R1",
      assumption: "the probe site resolves under the server's grant",
      expected: "200",
      request: (ctx) => ({ method: "GET", url: `${ctx.graphBase}${siteLookupPath(ctx.siteUrl)}?$select=id` }),
      judge: expectStatus(200, "200"),
      capture: (res, ctx) => {
        const id = (parse(res.body) as { id?: unknown } | undefined)?.id;
        if (typeof id === "string") ctx.siteId = id;
      },
    },
    {
      id: "R2",
      assumption: "the probe library resolves to a drive",
      expected: "200 with a drive named as configured",
      request: (ctx) => ({ method: "GET", url: `${ctx.graphBase}/sites/${need(ctx, "siteId")}/drives?$select=id,name` }),
      judge: (res, ctx) => {
        if (res.status !== 200) return { kind: "fail", because: `expected 200, received ${res.status}` };
        const drives = (parse(res.body) as { value?: Array<{ id?: string; name?: string }> } | undefined)?.value ?? [];
        return drives.some((d) => d.name?.toLowerCase() === ctx.library.toLowerCase())
          ? { kind: "pass" }
          : { kind: "fail", because: `no drive named ${ctx.library} among ${drives.map((d) => d.name).join(", ")}` };
      },
      capture: (res, ctx) => {
        const drives = (parse(res.body) as { value?: Array<{ id?: string; name?: string }> } | undefined)?.value ?? [];
        const match = drives.find((d) => d.name?.toLowerCase() === ctx.library.toLowerCase());
        if (match?.id !== undefined) ctx.driveId = match.id;
      },
    },
    {
      id: "L1",
      assumption: "Sites.Selected reaches list items for read",
      expected: "200",
      request: (ctx) => ({ method: "GET", url: listUrl(ctx, "?$expand=fields&$top=5") }),
      judge: expectStatus(200, "200"),
    },
    {
      id: "L2a",
      assumption: "Sites.Selected creates a list item and the response carries its integer id",
      expected: "201 with id",
      request: (ctx) =>
        json("POST", listUrl(ctx, ""), { fields: { Title: `probe ${ctx.runId}`, VendorFolder: "ProbeVendor", Status: "In Progress" } }),
      judge: (res) => {
        if (res.status !== 201) return { kind: "fail", because: `expected 201, received ${res.status}` };
        const id = (parse(res.body) as { id?: unknown } | undefined)?.id;
        return typeof id === "string" && /^\d+$/.test(id) ? { kind: "pass" } : { kind: "fail", because: "201 without an integer id" };
      },
      capture: (res, ctx) => {
        const id = (parse(res.body) as { id?: unknown } | undefined)?.id;
        if (typeof id === "string") ctx.itemId = id;
      },
    },
    {
      id: "L2b",
      assumption: "a fields PATCH writes the rendered AssessmentId back and returns the updated fields",
      expected: "200 with AssessmentId",
      request: (ctx) => json("PATCH", listUrl(ctx, `/${need(ctx, "itemId")}/fields`), { AssessmentId: renderedId(ctx) }),
      judge: (res, ctx) => {
        if (res.status !== 200) return { kind: "fail", because: `expected 200, received ${res.status}` };
        const value = (parse(res.body) as { AssessmentId?: unknown } | undefined)?.AssessmentId;
        return value === renderedId(ctx) ? { kind: "pass" } : { kind: "fail", because: "200 without the AssessmentId just written" };
      },
    },
    {
      id: "L1b",
      assumption: "a single item reads back with the field just written",
      expected: "200 with fields.AssessmentId",
      request: (ctx) => ({ method: "GET", url: listUrl(ctx, `/${need(ctx, "itemId")}?$expand=fields`) }),
      judge: (res, ctx) => {
        if (res.status !== 200) return { kind: "fail", because: `expected 200, received ${res.status}` };
        const fields = (parse(res.body) as { fields?: { AssessmentId?: unknown } } | undefined)?.fields;
        return fields?.AssessmentId === renderedId(ctx) ? { kind: "pass" } : { kind: "fail", because: "read back without the AssessmentId" };
      },
    },
    {
      id: "L3a",
      assumption: "a list query filtered on a text field works without the non-indexed header",
      expected: "200 with one item, or a status that says the column must be indexed",
      request: (ctx) => ({
        method: "GET",
        url: listUrl(ctx, `?$expand=fields&$filter=fields/AssessmentId eq '${renderedId(ctx)}'`),
      }),
      judge: (res) => {
        const items = (parse(res.body) as { value?: unknown[] } | undefined)?.value;
        if (res.status === 200 && Array.isArray(items) && items.length === 1) return { kind: "pass" };
        return { kind: "observed", note: `status ${res.status}, ${graphErrorCodeFromBody(res.body) ?? "no error code"}` };
      },
    },
    {
      id: "L3b",
      assumption: "the same query works with Prefer: HonorNonIndexedQueriesWarningMayFailRandomly",
      expected: "200 with one item",
      request: (ctx) => ({
        method: "GET",
        url: listUrl(ctx, `?$expand=fields&$filter=fields/AssessmentId eq '${renderedId(ctx)}'`),
        headers: { Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly" },
      }),
      judge: (res) => {
        const items = (parse(res.body) as { value?: unknown[] } | undefined)?.value;
        if (res.status === 200 && Array.isArray(items) && items.length === 1) return { kind: "pass" };
        return { kind: "observed", note: `status ${res.status}, ${graphErrorCodeFromBody(res.body) ?? "no error code"}` };
      },
    },
    {
      id: "F0",
      assumption: "the probe root folder exists at the library root (created once, 409 on later runs)",
      expected: "201, or 409 nameAlreadyExists",
      request: (ctx) =>
        json("POST", `${ctx.graphBase}/drives/${need(ctx, "driveId")}/root/children`, {
          name: PROBE_ROOT,
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      judge: (res) =>
        res.status === 201 || (res.status === 409 && graphErrorCodeFromBody(res.body) === "nameAlreadyExists")
          ? { kind: "pass" }
          : { kind: "fail", because: `expected 201 or 409 nameAlreadyExists, received ${res.status}` },
    },
    {
      id: "F1a",
      assumption: "folder create by path with conflictBehavior fail returns the item with an ETag",
      expected: "201 with eTag",
      request: (ctx) =>
        json("POST", `${ctx.graphBase}/drives/${need(ctx, "driveId")}/root:/${PROBE_ROOT}:/children`, {
          name: folderName(ctx),
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      judge: (res) =>
        res.status === 201 && etagOf(res.body) !== undefined
          ? { kind: "pass" }
          : { kind: "fail", because: `expected 201 with eTag, received ${res.status}${etagOf(res.body) === undefined ? " without eTag" : ""}` },
      capture: (res, ctx) => {
        ctx.folderEtag = etagOf(res.body);
      },
    },
    {
      id: "F1b",
      assumption: "a second create of the same folder answers 409 nameAlreadyExists",
      expected: "409 nameAlreadyExists",
      request: (ctx) =>
        json("POST", `${ctx.graphBase}/drives/${need(ctx, "driveId")}/root:/${PROBE_ROOT}:/children`, {
          name: folderName(ctx),
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      judge: (res) =>
        res.status === 409 && graphErrorCodeFromBody(res.body) === "nameAlreadyExists"
          ? { kind: "pass" }
          : { kind: "fail", because: `expected 409 nameAlreadyExists, received ${res.status}` },
    },
    {
      id: "F2a",
      assumption: "a small content PUT with conflictBehavior fail creates the file and returns its ETag",
      expected: "201 with eTag",
      request: (ctx) => ({
        method: "PUT",
        url: `${ctx.graphBase}/drives/${need(ctx, "driveId")}/root:/${filePath(ctx)}:/content?@microsoft.graph.conflictBehavior=fail`,
        headers: { "content-type": "text/plain" },
        body: "# probe\n",
      }),
      judge: (res) =>
        res.status === 201 && etagOf(res.body) !== undefined
          ? { kind: "pass" }
          : { kind: "fail", because: `expected 201 with eTag, received ${res.status}` },
      capture: (res, ctx) => {
        ctx.fileEtag = etagOf(res.body);
      },
    },
    {
      id: "F2b",
      assumption: "the same PUT against the occupied name answers 409 and replaces nothing",
      expected: "409 nameAlreadyExists",
      request: (ctx) => ({
        method: "PUT",
        url: `${ctx.graphBase}/drives/${need(ctx, "driveId")}/root:/${filePath(ctx)}:/content?@microsoft.graph.conflictBehavior=fail`,
        headers: { "content-type": "text/plain" },
        body: "# must not land\n",
      }),
      judge: (res) =>
        res.status === 409 && graphErrorCodeFromBody(res.body) === "nameAlreadyExists"
          ? { kind: "pass" }
          : { kind: "fail", because: `expected 409 nameAlreadyExists, received ${res.status}` },
    },
    {
      id: "F3a",
      assumption: "a content PUT under If-Match with the current ETag succeeds and returns a new ETag",
      expected: "200 with a different eTag",
      request: (ctx) => ({
        method: "PUT",
        url: `${ctx.graphBase}/drives/${need(ctx, "driveId")}/root:/${filePath(ctx)}:/content`,
        headers: { "content-type": "text/plain", "if-match": need(ctx, "fileEtag") },
        body: "# probe v2\n",
      }),
      judge: (res, ctx) => {
        const etag = etagOf(res.body);
        if (res.status !== 200) return { kind: "fail", because: `expected 200, received ${res.status}` };
        if (etag === undefined) return { kind: "fail", because: "200 without eTag" };
        return etag !== ctx.fileEtag ? { kind: "pass" } : { kind: "fail", because: "200 but the eTag did not change" };
      },
      capture: (res, ctx) => {
        ctx.newEtag = etagOf(res.body);
      },
    },
    {
      id: "F3b",
      assumption: "a content PUT under a stale If-Match answers 412",
      expected: "412",
      request: (ctx) => ({
        method: "PUT",
        url: `${ctx.graphBase}/drives/${need(ctx, "driveId")}/root:/${filePath(ctx)}:/content`,
        headers: { "content-type": "text/plain", "if-match": need(ctx, "fileEtag") },
        body: "# must not land\n",
      }),
      judge: expectStatus(412, "412"),
    },
    {
      id: "F4",
      assumption: "the content reads back as what the last successful write sent",
      expected: "the overwritten text",
      request: (ctx) => ({
        method: "GET",
        url: `${ctx.graphBase}/drives/${need(ctx, "driveId")}/root:/${filePath(ctx)}:/content`,
        readBodyAsText: true,
      }),
      judge: (res) => (res.status === 200 && res.body === "# probe v2\n" ? { kind: "pass" } : { kind: "fail", because: `received ${res.status} with ${JSON.stringify(res.body.slice(0, 40))}` }),
    },
  ];
}

/**
 * Replaces every identifier that names this tenant with a placeholder, and
 * every ETag with a numbered token in order of first appearance, so a reader
 * can still see that F3a's response ETag differs from F2a's. The redacted
 * record is what gets committed; the raw one stays under .superpowers/.
 */
export function redact(record: ProbeRecord, ctx: ProbeContext): ProbeRecord {
  const etags = new Map<string, string>();
  const host = new URL(ctx.siteUrl).hostname;
  const replacements: Array<[string, string]> = [];
  if (ctx.siteId !== undefined) replacements.push([ctx.siteId, "<site-id>"]);
  if (ctx.driveId !== undefined) replacements.push([ctx.driveId, "<drive-id>"]);
  replacements.push([host, "<host>"]);

  function scrub(text: string): string {
    let out = text;
    for (const [value, placeholder] of replacements) out = out.split(value).join(placeholder);
    out = out.replace(/"\{[0-9A-Fa-f-]+\},\d+"/g, (etag) => {
      const known = etags.get(etag);
      if (known !== undefined) return known;
      const token = `<etag-${etags.size + 1}>`;
      etags.set(etag, token);
      return token;
    });
    out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<guid>");
    return out;
  }

  function scrubHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
    if (headers === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === "authorization") continue;
      out[name] = scrub(value);
    }
    return out;
  }

  return {
    ...record,
    request: {
      ...record.request,
      url: scrub(record.request.url),
      ...(record.request.headers === undefined ? {} : { headers: scrubHeaders(record.request.headers) }),
      ...(record.request.body === undefined ? {} : { body: scrub(record.request.body) }),
    },
    response: { status: record.response.status, headers: scrubHeaders(record.response.headers) ?? {}, body: scrub(record.response.body) },
  };
}

export function reportMarkdown(records: ProbeRecord[], runId: string): string {
  const lines = [
    `# Assessment probe report, run ${runId}`,
    "",
    "Each row is one request sent under the server application's Sites.Selected token against the",
    "Ironwright developer tenant. Verdicts are the judge's reading of the status and body; the",
    "redacted request and response are in recordings.jsonl beside this file.",
    "",
    "| Step | Assumption | Expected | Observed | Verdict |",
    "|---|---|---|---|---|",
  ];
  for (const r of records) {
    const verdict = r.verdict.kind === "pass" ? "pass" : r.verdict.kind === "fail" ? `fail: ${r.verdict.because}` : `observed: ${r.verdict.note}`;
    lines.push(`| ${r.id} | ${r.assumption} | ${r.expected} | ${r.response.status} | ${verdict} |`);
  }
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/assessment-probe.test.ts tests/scripts/assessment-probe.errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add scripts/assessment-probe/plan.ts tests/scripts/assessment-probe.test.ts tests/scripts/assessment-probe.errors.test.ts
git commit -m "feat(probe): define the assessment Graph probes, their judges and the redaction"
```

---

## Task 3: The seed

**Files:**
- Create: `scripts/assessment-probe/seed.ts`
- Modify: `package.json` (script `probe:assessment:seed`)

**Interfaces:**
- Consumes: `listDefinitions` from Task 1; `clientCredentialsTokenProvider` and `createGraphClient` from `src/graph/`; `siteLookupPath` from `src/graph/drive.ts`.
- Produces: a runnable script. No exports other than `main` wiring.

No unit test: the script is three Graph calls under the grant issuer and is verified by running it. Its only logic, the list bodies, is tested in Task 1.

- [ ] **Step 1: Write the script**

```ts
// scripts/assessment-probe/seed.ts
/**
 * Creates the three probe lists on the probe site, under the grant issuer's
 * token (Sites.FullControl.All). Idempotent: a list that already exists by
 * display name is left alone and reported. Run once before the probe.
 *
 * Reads IW_BOOTSTRAP_CLIENT_ID, IW_BOOTSTRAP_CLIENT_SECRET, IW_TENANT_ID,
 * IW_SITE_URL and IW_PROBE_LIST_PREFIX (default "IW Probe").
 */
import { createGraphClient } from "../../src/graph/client.js";
import { siteLookupPath } from "../../src/graph/drive.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { clientCredentialsTokenProvider } from "../../src/graph/token.js";
import { listDefinitions } from "./lists.js";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const tokenProvider = clientCredentialsTokenProvider({
    tenantId: env("IW_TENANT_ID"),
    clientId: env("IW_BOOTSTRAP_CLIENT_ID"),
    clientSecret: env("IW_BOOTSTRAP_CLIENT_SECRET"),
  });
  const client = createGraphClient({ tokenProvider });
  const siteUrl = env("IW_SITE_URL");
  const prefix = process.env.IW_PROBE_LIST_PREFIX?.trim() || "IW Probe";

  const site = await client.get<{ id: string }>(`${siteLookupPath(siteUrl)}?$select=id`);

  for (const list of listDefinitions(prefix)) {
    try {
      await client.get<unknown>(`/sites/${site.id}/lists/${encodeURIComponent(list.displayName)}?$select=id`);
      console.log(`exists: ${list.displayName}`);
      continue;
    } catch (error) {
      if (!(error instanceof GraphRequestError && error.status === 404)) throw error;
    }
    await client.post<unknown>(`/sites/${site.id}/lists`, list.body);
    console.log(`created: ${list.displayName}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add the npm script**

In `package.json` scripts, after `"seed-library"`:

```json
"probe:assessment:seed": "tsx scripts/assessment-probe/seed.ts",
```

- [ ] **Step 3: Run it against the developer tenant (operator, with the Task 0 environment)**

Run: `npm run probe:assessment:seed`
Expected: three `created:` lines the first time, three `exists:` lines the second time. Record in the session what the output said, never the values from the environment.

- [ ] **Step 4: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add scripts/assessment-probe/seed.ts package.json
git commit -m "feat(probe): seed the three probe lists under the grant issuer"
```

---

## Task 4: The runner

**Files:**
- Create: `scripts/assessment-probe/main.ts`
- Modify: `package.json` (script `probe:assessment`)

**Interfaces:**
- Consumes: everything from Task 2; `clientCredentialsTokenProvider`, `requireExactRoles`, `SERVER_TOKEN_ROLES` from `src/graph/token.ts`; `GRAPH_BASE` from `src/graph/client.ts`.
- Produces: `.superpowers/assessment-probe/<runId>.raw.jsonl` (raw, gitignored), and under `--out=<dir>`: `recordings.jsonl` (redacted) and `report.md`.

The runner uses raw `fetch` for every step rather than `GraphClient`, for two reasons: the client has no PUT, and a probe is about what Graph answers to an exact request, so the request should be visible in full in the recording rather than assembled by code the probe is meant to inform. The token goes through `requireExactRoles` so the probe cannot accidentally run under a broader token and prove the wrong thing.

- [ ] **Step 1: Write the script**

```ts
// scripts/assessment-probe/main.ts
/**
 * Runs the assessment domain's Graph probes. See plan.ts for the steps and
 * docs/superpowers/plans/2026-11-06-phase-9a-assessment-probes.md for why.
 *
 *   npm run probe:assessment -- --out=docs/superpowers/specs/evidence/2026-11-07-assessment-probe
 *
 * Reads IW_TENANT_ID, IW_CLIENT_ID, IW_CLIENT_SECRET (the server application),
 * IW_SITE_URL, IW_PROBE_LIBRARY (default "Shared Documents") and
 * IW_PROBE_LIST_PREFIX (default "IW Probe").
 *
 * The raw recording, which carries real ids, goes under .superpowers/ and is
 * never committed. The redacted recording and the report go to --out.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GRAPH_BASE } from "../../src/graph/client.js";
import { clientCredentialsTokenProvider, requireExactRoles, SERVER_TOKEN_ROLES } from "../../src/graph/token.js";
import { probeSteps, redact, reportMarkdown, type ProbeContext, type ProbeRecord, type ProbeRequest, type ProbeResponse } from "./plan.js";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function send(token: string, req: ProbeRequest): Promise<ProbeResponse> {
  const response = await fetch(req.url, {
    method: req.method,
    headers: { ...(req.headers ?? {}), authorization: `Bearer ${token}` },
    ...(req.body === undefined ? {} : { body: req.body }),
    redirect: "follow",
  });
  const body = await response.text();
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "etag", "location", "retry-after", "request-id"]) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { status: response.status, headers, body };
}

async function main(): Promise<void> {
  const out = argValue("out");
  if (out === undefined) throw new Error("--out=<dir> is required: where the redacted recording and report go");

  const tokenProvider = requireExactRoles(
    clientCredentialsTokenProvider({ tenantId: env("IW_TENANT_ID"), clientId: env("IW_CLIENT_ID"), clientSecret: env("IW_CLIENT_SECRET") }),
    SERVER_TOKEN_ROLES,
  );

  const ctx: ProbeContext = {
    graphBase: GRAPH_BASE,
    siteUrl: env("IW_SITE_URL"),
    library: process.env.IW_PROBE_LIBRARY?.trim() || "Shared Documents",
    listPrefix: process.env.IW_PROBE_LIST_PREFIX?.trim() || "IW Probe",
    runId: new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""),
  };

  const raw: ProbeRecord[] = [];
  for (const step of probeSteps()) {
    const req = step.request(ctx);
    const token = await tokenProvider.getToken();
    const res = await send(token, req);
    const verdict = step.judge(res, ctx);
    step.capture?.(res, ctx);
    raw.push({ id: step.id, assumption: step.assumption, expected: step.expected, request: req, response: res, verdict });
    const label = verdict.kind === "pass" ? "pass" : verdict.kind === "fail" ? `FAIL ${verdict.because}` : `observed ${verdict.note}`;
    console.error(`${step.id.padEnd(4)} ${res.status}  ${label}`);
    // A failed capture makes every later step throw on its missing input,
    // which is the right outcome: the report then shows exactly where the
    // chain broke instead of a run of failures with one cause.
  }

  const rawDir = join(".superpowers", "assessment-probe");
  await mkdir(rawDir, { recursive: true });
  await writeFile(join(rawDir, `${ctx.runId}.raw.jsonl`), raw.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const redacted = raw.map((r) => redact(r, ctx));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "recordings.jsonl"), redacted.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await writeFile(join(out, "report.md"), reportMarkdown(redacted, ctx.runId));
  console.error(`wrote ${out}/recordings.jsonl and ${out}/report.md`);

  console.error(`cleanup: the folder IW-Probe/probe-${ctx.runId} and list item ${ctx.itemId ?? "(none)"} were left in place; remove them by hand or leave them, they are named by run`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add the npm script**

```json
"probe:assessment": "tsx scripts/assessment-probe/main.ts",
```

- [ ] **Step 3: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck && npm test
git add scripts/assessment-probe/main.ts package.json
git commit -m "feat(probe): run the assessment Graph probes and write a redacted recording"
```

---

## Task 5: Run the probes and record the evidence (operator)

**Files:**
- Create: `docs/superpowers/specs/evidence/<run-date>-assessment-probe/recordings.jsonl`, `report.md`
- Modify: `docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md` (Assumptions table)

- [ ] **Step 1: Run**

```bash
npm run probe:assessment -- --out=docs/superpowers/specs/evidence/2026-11-07-assessment-probe
```

Expected: sixteen lines on stderr, one per step, and the two files written. If R1 or R2 fails, the site or library in the environment is wrong; fix and rerun. If L1 fails with 403, that is itself the evidence the design needs and the run should continue (the runner does continue, because L1's judge does not capture anything later steps need).

- [ ] **Step 2: Read the report before committing it.** Confirm no real hostname, site id, drive id or GUID survived redaction by searching `recordings.jsonl` for the tenant's hostname and for the characters `sharepoint.com`. If anything survived, fix `redact` in Task 2 with a test for that case and rerun.

- [ ] **Step 3: Amend the spec's Assumptions table.** Add an Evidence column. For each Graph row, write the step id, the date, and the observed status in one line, for example `L1, 2026-11-07: 200`. For a row whose probe failed or came back observed, write what was received and amend the design section that depended on it before any later plan is written. The two Copilot rows and the two suite rows stay as they are.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/evidence/ docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md
git commit -m "docs: record the assessment probe evidence against the developer tenant"
```

---

## Task 6: Copilot Studio probe additions and the status row

**Files:**
- Modify: `docs/COPILOT-STUDIO-PROBE.md`, `docs/OPEN-ITEMS.md`

- [ ] **Step 1: Extend A3 and B1.** Under A3, after the existing text, add:

> Also record whether the dialog can send more than one custom header with a fixed value. Cloudflare Access service tokens need two (`CF-Access-Client-Id` and `CF-Access-Client-Secret`), and whether that is possible decides whether Access is documented as optional hardening or left out.

Under B1, change the question to cover both hostnames:

> Does Copilot Studio accept the server URL as given, for a dev tunnel hostname and for a hostname on an owned domain fronted by Cloudflare Tunnel? Record any validation message either produces.

- [ ] **Step 2: Update the 9a row** in the status table of `docs/OPEN-ITEMS.md` to `Complete, probes run <date>` with the evidence path, in the same commit.

- [ ] **Step 3: Commit**

```bash
git add docs/COPILOT-STUDIO-PROBE.md docs/OPEN-ITEMS.md
git commit -m "docs: extend the Copilot Studio probes for Access headers and the Cloudflare hostname"
```

---

## Self-review against the spec

- Every Graph row of the Assumptions table has a step: L1 (read), L2a and L2b (create, PATCH), L3a and L3b (filter), F1a and F1b (folder), F2a and F2b (create file), F3a and F3b (overwrite), F4 (read-back, which the spec names as the rule every write follows). Copilot rows A3 and B1 are extended in Task 6. The two suite rows belong to plan 9b.
- No placeholders: every step has code or an exact command. Task 0 and Task 5 are operator steps and say so.
- Names used across tasks: `listDefinitions` (Task 1, used by Task 3), `probeSteps`, `redact`, `reportMarkdown`, `ProbeContext`, `ProbeRecord`, `ProbeRequest`, `ProbeResponse` (Task 2, used by Task 4). Consistent.
