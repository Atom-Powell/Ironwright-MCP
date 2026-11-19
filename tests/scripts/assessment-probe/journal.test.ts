// tests/scripts/assessment-probe/journal.test.ts
import { describe, expect, it } from "vitest";
import { JOURNAL_COLUMNS, journalListBody, probeJournalList } from "../../../scripts/assessment-probe/journal.js";
import { GraphRequestError } from "../../../src/graph/errors.js";

const SITE = "https://contoso.sharepoint.com/sites/ServiceDesk";
const STAMP = "20261118T200000";
const LIST = `IW Probe Journal ${STAMP}`;

type Answer = unknown | ((path: string, body?: unknown) => unknown);
type Rule = { method: "GET" | "POST"; includes: string; answer: Answer };

/** A client that answers by rule, and records every request with its headers. */
function scripted(rules: Rule[]) {
  const calls: Array<{ method: string; path: string; headers?: Record<string, string>; body?: unknown }> = [];
  const answer = (method: "GET" | "POST", path: string, body?: unknown, headers?: Record<string, string>): unknown => {
    calls.push({ method, path: decodeURIComponent(path), ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }) });
    const rule = rules.find((candidate) => candidate.method === method && decodeURIComponent(path).includes(candidate.includes));
    if (rule === undefined) throw new Error(`no scripted answer for ${method} ${decodeURIComponent(path)}`);
    const value = typeof rule.answer === "function" ? (rule.answer as (p: string, b?: unknown) => unknown)(decodeURIComponent(path), body) : rule.answer;
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    calls,
    client: {
      get: async <T>(path: string, headers?: Record<string, string>): Promise<T> => answer("GET", path, undefined, headers) as T,
      post: async <T>(path: string, body?: unknown): Promise<T> => answer("POST", path, body) as T,
    },
  };
}

const columnsBack = (overrides: Record<string, unknown> = {}): unknown => ({
  value: [{ name: "Title" }, ...JOURNAL_COLUMNS.map((name) => ({ name, indexed: name === "AssessmentId", text: { allowMultipleLines: name === "Target" }, ...((overrides[name] as object) ?? {}) }))],
});

/** The server side: items created are remembered and served back, filtered and paged by 50. */
function serverWith(options: { truncateTargetTo?: number; filterError?: Error } = {}) {
  const items: Array<{ id: string; fields: Record<string, unknown> }> = [];
  return scripted([
    {
      method: "POST",
      includes: `/lists/${LIST}/items`,
      answer: (_path: string, body?: unknown) => {
        const fields = { ...(body as { fields: Record<string, unknown> }).fields };
        if (options.truncateTargetTo !== undefined && typeof fields.Target === "string") fields.Target = fields.Target.slice(0, options.truncateTargetTo);
        const item = { id: String(items.length + 1), fields };
        items.push(item);
        return item;
      },
    },
    { method: "GET", includes: `/lists/${LIST}/items/1?`, answer: () => ({ fields: items[0]!.fields }) },
    {
      method: "GET",
      includes: `/lists/${LIST}/items?`,
      answer: (path: string) => {
        if (options.filterError !== undefined) return options.filterError;
        const skip = Number(/skip=(\d+)/.exec(path)?.[1] ?? 0);
        const matching = items.filter((item) => item.fields.AssessmentId === "PROBE-A");
        const page = matching.slice(skip, skip + 50);
        return { value: page, ...(skip + 50 < matching.length ? { "@odata.nextLink": `https://graph/sites/s1/lists/${LIST}/items?skip=${skip + 50}` } : {}) };
      },
    },
  ]);
}

function issuerWith(columns: unknown = columnsBack(), create: unknown = { id: "list" }) {
  return scripted([
    { method: "GET", includes: "/sites/contoso.sharepoint.com:/sites/ServiceDesk", answer: { id: "s1" } },
    { method: "POST", includes: "/sites/s1/lists", answer: create },
    { method: "GET", includes: `/lists/${LIST}/columns`, answer: columns },
  ]);
}

describe("the journal list probe", () => {
  it("passes every step when the list, the index, the long target and the paged filter all behave", async () => {
    const server = serverWith();
    const issuer = issuerWith();

    const steps = await probeJournalList({ issuer: issuer.client, server: server.client, siteUrl: SITE, stamp: STAMP, manyEntries: 60 });

    expect(steps.map((step) => [step.step.slice(0, 3), step.verdict])).toEqual([
      ["J1 ", "pass"],
      ["J2a", "pass"],
      ["J2b", "pass"],
      ["J3 ", "pass"],
      ["J2c", "pass"],
      ["J4 ", "pass"],
      ["J5 ", "observed"],
    ]);
    expect(steps.find((step) => step.step.startsWith("J4"))!.detail).toBe("60 of 60 entries for PROBE-A over 2 pages, and 0 for any other id");
    // The filter is sent without the non-indexed header: that is the question J2c asks.
    const filtered = server.calls.find((call) => call.method === "GET" && call.path.includes("$filter="));
    expect(filtered?.headers).toBeUndefined();
    // Every item is created by the server application; the issuer only creates the list.
    expect(issuer.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/sites/s1/lists"]);
  });

  it("creates the list with the assessment id indexed and the target multi line", () => {
    const body = journalListBody("Journal") as { columns: Array<Record<string, unknown>> };

    expect(body.columns.find((column) => column.name === "AssessmentId")).toEqual({ name: "AssessmentId", indexed: true, text: {} });
    expect(body.columns.find((column) => column.name === "Target")).toEqual({ name: "Target", text: { allowMultipleLines: true } });
    expect(body.columns).toHaveLength(JOURNAL_COLUMNS.length);
  });

  it("stops after J1 when the list cannot be created, and says so", async () => {
    const refused = new GraphRequestError({ method: "POST", path: "/sites/s1/lists", status: 403, body: JSON.stringify({ error: { code: "accessDenied" } }) });
    const server = serverWith();

    const steps = await probeJournalList({ issuer: issuerWith(columnsBack(), refused).client, server: server.client, siteUrl: SITE, stamp: STAMP });

    expect(steps).toEqual([{ step: "J1 create the journal list", verdict: "fail", detail: "the create answered 403 accessDenied; nothing further was run" }]);
    expect(server.calls).toHaveLength(0);
  });

  it("fails J2a when the column reads back unindexed, and still runs the rest", async () => {
    const steps = await probeJournalList({ issuer: issuerWith(columnsBack({ AssessmentId: { indexed: false } })).client, server: serverWith().client, siteUrl: SITE, stamp: STAMP, manyEntries: 3 });

    expect(steps.find((step) => step.step.startsWith("J2a"))).toEqual({ step: "J2a AssessmentId created indexed", verdict: "fail", detail: "the column reads back indexed false" });
    expect(steps.find((step) => step.step.startsWith("J4"))?.verdict).toBe("pass");
  });

  it("fails J3 when the target comes back cut short, naming both lengths", async () => {
    const steps = await probeJournalList({ issuer: issuerWith().client, server: serverWith({ truncateTargetTo: 255 }).client, siteUrl: SITE, stamp: STAMP, manyEntries: 3 });

    const j3 = steps.find((step) => step.step.startsWith("J3"))!;
    expect(j3.verdict).toBe("fail");
    expect(j3.detail).toMatch(/^created, but the target read back as 255 characters, not \d+$/);
  });

  it("records a 400 on the unheaded filter as observed, saying what the read must do instead", async () => {
    const refused = new GraphRequestError({ method: "GET", path: "items", status: 400, body: JSON.stringify({ error: { code: "invalidRequest" } }) });

    const steps = await probeJournalList({ issuer: issuerWith().client, server: serverWith({ filterError: refused }).client, siteUrl: SITE, stamp: STAMP, manyEntries: 3 });

    expect(steps.find((step) => step.step.startsWith("J2c"))).toEqual({
      step: "J2c filter on AssessmentId without the non-indexed header",
      verdict: "observed",
      detail: "answered 400 invalidRequest: the index does not stand in for the header, so the journal read sends it as the other reads do",
    });
    expect(steps.some((step) => step.step.startsWith("J4"))).toBe(false);
  });

  it("names the columns that did not come back", async () => {
    const columns = { value: [{ name: "Title" }, ...JOURNAL_COLUMNS.filter((name) => name !== "VersionId" && name !== "Stage").map((name) => ({ name }))] };

    const steps = await probeJournalList({ issuer: issuerWith(columns).client, server: serverWith().client, siteUrl: SITE, stamp: STAMP });

    expect(steps).toEqual([{ step: "J1 create the journal list", verdict: "fail", detail: "created, but columns missing on read back: Stage, VersionId" }]);
  });
});
