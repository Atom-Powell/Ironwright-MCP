// scripts/assessment-probe/plan.ts
import { siteLookupPath } from "../../src/graph/drive.js";
import { graphErrorCodeFromBody } from "../../src/graph/errors.js";
import { driveItemPath } from "../../src/graph/paths.js";

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

// Names the status and, when the body carries one, the Graph error code, so a
// 409 with the wrong code is not reported as "expected 409, received 409".
function received(res: ProbeResponse): string {
  const code = graphErrorCodeFromBody(res.body);
  return code === undefined ? String(res.status) : `${res.status} ${code}`;
}

function expectStatus(status: number, label: string): (res: ProbeResponse) => Verdict {
  return (res) => (res.status === status ? { kind: "pass" } : { kind: "fail", because: `expected ${label}, received ${res.status}` });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listUrl(ctx: ProbeContext, suffix: string): string {
  const name = encodeURIComponent(`${ctx.listPrefix} Assessments`);
  return `${ctx.graphBase}/sites/${need(ctx, "siteId")}/lists/${name}/items${suffix}`;
}

function renderedId(ctx: ProbeContext): string {
  return `PRB-${ctx.runId}-${need(ctx, "itemId").padStart(5, "0")}`;
}

// The space is deliberate: 9c builds workspace paths from vendor folder names,
// so the recorded URLs and responses must include a segment that needs encoding.
function folderName(ctx: ProbeContext): string {
  return `probe ${ctx.runId}`;
}

function filePath(ctx: ProbeContext): string {
  return `${PROBE_ROOT}/${folderName(ctx)}/dossier.md`;
}

function absentPath(ctx: ProbeContext): string {
  return `${PROBE_ROOT}/${folderName(ctx)}/absent.md`;
}

// Built through the same helper the server uses, so the probe measures the URL
// 9c will send. The result ends at the path's trailing colon (or at "root"), so
// callers append "/children" or "/content" themselves.
function itemUrl(ctx: ProbeContext, libraryRelativePath: string): string {
  return `${ctx.graphBase}${driveItemPath(need(ctx, "driveId"), libraryRelativePath)}`;
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
        json("POST", `${itemUrl(ctx, "")}/children`, {
          name: PROBE_ROOT,
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      judge: (res) =>
        res.status === 201 || (res.status === 409 && graphErrorCodeFromBody(res.body) === "nameAlreadyExists")
          ? { kind: "pass" }
          : { kind: "fail", because: `expected 201 or 409 nameAlreadyExists, received ${received(res)}` },
    },
    {
      id: "F1a",
      assumption: "folder create by path with conflictBehavior fail returns the item with an ETag",
      expected: "201 with eTag",
      request: (ctx) =>
        json("POST", `${itemUrl(ctx, PROBE_ROOT)}/children`, {
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
        json("POST", `${itemUrl(ctx, PROBE_ROOT)}/children`, {
          name: folderName(ctx),
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      judge: (res) =>
        res.status === 409 && graphErrorCodeFromBody(res.body) === "nameAlreadyExists"
          ? { kind: "pass" }
          : { kind: "fail", because: `expected 409 nameAlreadyExists, received ${received(res)}` },
    },
    {
      id: "F2a",
      assumption: "a small content PUT with conflictBehavior fail creates the file and returns its ETag",
      expected: "201 with eTag",
      request: (ctx) => ({
        method: "PUT",
        url: `${itemUrl(ctx, filePath(ctx))}/content?@microsoft.graph.conflictBehavior=fail`,
        headers: { "content-type": "text/plain" },
        body: "# probe\n",
      }),
      judge: (res) =>
        res.status === 201 && etagOf(res.body) !== undefined
          ? { kind: "pass" }
          : { kind: "fail", because: `expected 201 with eTag, received ${res.status}${etagOf(res.body) === undefined ? " without eTag" : ""}` },
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
        url: `${itemUrl(ctx, filePath(ctx))}/content?@microsoft.graph.conflictBehavior=fail`,
        headers: { "content-type": "text/plain" },
        body: "# must not land\n",
      }),
      judge: (res) =>
        res.status === 409 && graphErrorCodeFromBody(res.body) === "nameAlreadyExists"
          ? { kind: "pass" }
          : { kind: "fail", because: `expected 409 nameAlreadyExists, received ${received(res)}` },
    },
    {
      id: "F3a",
      assumption: "a content PUT under If-Match with the current ETag succeeds and returns a new ETag",
      expected: "200 with a different eTag",
      request: (ctx) => ({
        method: "PUT",
        url: `${itemUrl(ctx, filePath(ctx))}/content`,
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
        url: `${itemUrl(ctx, filePath(ctx))}/content`,
        headers: { "content-type": "text/plain", "if-match": need(ctx, "fileEtag") },
        body: "# must not land\n",
      }),
      judge: (res, ctx) => {
        if (res.status !== 412) return { kind: "fail", because: `expected 412, received ${received(res)}` };
        // A 412 only shows a stale precondition was refused if F3a changed the
        // eTag, so the If-Match sent here is known to be out of date.
        if (ctx.newEtag === undefined || ctx.newEtag === ctx.fileEtag) {
          return { kind: "observed", note: "412 received but F3a did not capture a changed eTag, so staleness was not established" };
        }
        return { kind: "pass" };
      },
    },
    {
      id: "F3c",
      assumption: "a content PUT under If-Match against an absent path answers 412, so the precondition is checked before existence",
      expected: "412",
      request: (ctx) => ({
        method: "PUT",
        url: `${itemUrl(ctx, absentPath(ctx))}/content`,
        headers: { "content-type": "text/plain", "if-match": need(ctx, "fileEtag") },
        body: "# must not land\n",
      }),
      judge: (res) => (res.status === 412 ? { kind: "pass" } : { kind: "fail", because: `expected 412, received ${received(res)}` }),
    },
    {
      id: "F4",
      assumption: "the content reads back as what the last successful write sent",
      expected: "the overwritten text",
      request: (ctx) => ({
        method: "GET",
        url: `${itemUrl(ctx, filePath(ctx))}/content`,
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
export function redact(record: ProbeRecord, ctx: ProbeContext, etags: Map<string, string> = new Map()): ProbeRecord {
  const host = new URL(ctx.siteUrl).hostname;
  const replacements: Array<[string, string]> = [];
  // Graph puts ids URL-encoded into @odata.context, so both forms are replaced.
  if (ctx.siteId !== undefined) replacements.push([ctx.siteId, "<site-id>"], [encodeURIComponent(ctx.siteId), "<site-id>"]);
  if (ctx.driveId !== undefined) replacements.push([ctx.driveId, "<drive-id>"], [encodeURIComponent(ctx.driveId), "<drive-id>"]);
  replacements.push([host, "<host>"]);
  const label = host.split(".")[0] ?? "";
  const tenantLabel = label.length === 0 ? undefined : new RegExp(escapeRegExp(label), "gi");

  function scrub(text: string): string {
    let out = text;
    for (const [value, placeholder] of replacements) out = out.split(value).join(placeholder);
    // A response body is JSON text, so an etag inside it carries escaped
    // quotes. Match the escaped form whole and key on the unescaped value, so
    // a header etag and the same etag in a body share one token.
    out = out.replace(/\\?"\{[0-9A-Fa-f-]+\},\d+\\?"/g, (etag) => {
      const key = etag.replace(/\\/g, "");
      const known = etags.get(key);
      if (known !== undefined) return known;
      const token = `<etag-${etags.size + 1}>`;
      etags.set(key, token);
      return token;
    });
    // R2 lists every drive on the site, so other drives' ids appear too.
    out = out.replace(/b(?:!|%21)[A-Za-z0-9_-]+/g, "<drive-id>");
    // A content PUT response can carry a pre-authenticated download URL whose
    // query string is a bearer credential.
    out = out.replace(/("@microsoft\.graph\.downloadUrl"\s*:\s*)"[^"]*"/g, '$1"<download-url>"');
    out = out.replace(/tempauth=[^&"\s\\]+/g, "tempauth=<tempauth>");
    // Done after the exact host replacement so "<host>" is not damaged. Covers
    // the -my host and the onmicrosoft.com domain, which share the label.
    if (tenantLabel !== undefined) out = out.replace(tenantLabel, "<tenant>");
    out = out.replace(/("email"\s*:\s*)"[^"]*"/g, '$1"<email>"');
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

  // A judge builds its text from the raw body, so it can name an id or a host.
  function scrubVerdict(verdict: Verdict): Verdict {
    if (verdict.kind === "fail") return { kind: "fail", because: scrub(verdict.because) };
    if (verdict.kind === "observed") return { kind: "observed", note: scrub(verdict.note) };
    return { kind: "pass" };
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
    verdict: scrubVerdict(record.verdict),
  };
}

export function reportMarkdown(records: ProbeRecord[], runId: string, tokenRoles: readonly string[]): string {
  const lines = [
    `# Assessment probe report, run ${runId}`,
    "",
    `Each row whose Observed status is not 0 is one request sent under a token whose roles the runner verified to be exactly: ${tokenRoles.join(", ")}.`,
    "A row whose Observed status is 0 was not sent, because its request could not be built.",
    "The site is the one configured in IW_SITE_URL, which the recordings show as <host>. Verdicts are the",
    "judge's reading of the status and body; the redacted request and response are in recordings.jsonl",
    "beside this file.",
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
