// tests/scripts/assessment-probe.test.ts
import { describe, expect, it } from "vitest";
import { listDefinitions } from "../../scripts/assessment-probe/lists.js";
import { probeSteps, redact, reportMarkdown, type ProbeContext, type ProbeRecord } from "../../scripts/assessment-probe/plan.js";

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

  it("gives a header etag and the same etag inside a JSON body one shared token", () => {
    const record: ProbeRecord = {
      id: "F3b",
      assumption: "a",
      expected: "e",
      request: { method: "PUT", url: "u", headers: { "if-match": '"{AAAA},1"' } },
      response: { status: 200, headers: {}, body: JSON.stringify({ eTag: '"{AAAA},1"' }) },
      verdict: { kind: "pass" },
    };
    const out = redact(record, ctx());
    expect(out.request.headers?.["if-match"]).toBe("<etag-1>");
    expect(out.response.body).toBe('{"eTag":"<etag-1>"}');
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

describe("redaction coverage", () => {
  function rec(body: string, url = "u"): ProbeRecord {
    return { id: "X", assumption: "a", expected: "e", request: { method: "GET", url }, response: { status: 200, headers: {}, body }, verdict: { kind: "pass" } };
  }

  it("replaces URL-encoded drive and site ids", () => {
    const c = ctx();
    const out = redact(rec(`https://g/v1.0/$metadata#drives('${encodeURIComponent(c.driveId!)}') ${encodeURIComponent(c.siteId!)}`), c);
    expect(out.response.body).not.toContain("driveid");
    expect(out.response.body).toContain("<drive-id>");
    expect(out.response.body).toContain("<site-id>");
  });

  it("replaces other drives' ids in raw and encoded form", () => {
    const out = redact(rec(JSON.stringify({ value: [{ id: "b!OtherDrive_1-x" }, { id: "b%21Enc_2" }] })), ctx());
    expect(out.response.body).toBe('{"value":[{"id":"<drive-id>"},{"id":"<drive-id>"}]}');
  });

  it("replaces the download URL value and any tempauth parameter", () => {
    const body = JSON.stringify({ "@microsoft.graph.downloadUrl": "https://h/x?tempauth=SECRET&a=1", other: "https://h/y?tempauth=SECRET2" });
    const out = redact(rec(body), ctx());
    expect(out.response.body).not.toContain("SECRET");
    expect(out.response.body).toContain('"@microsoft.graph.downloadUrl":"<download-url>"');
    expect(out.response.body).toContain("tempauth=<tempauth>");
  });

  it("continues etag numbering across records that share a map", () => {
    const shared = new Map<string, string>();
    const a = redact(rec(JSON.stringify({ eTag: '"{AAAA},1"' })), ctx(), shared);
    const b = redact(rec(JSON.stringify({ eTag: '"{AAAA},2"' })), ctx(), shared);
    const c = redact(rec(JSON.stringify({ eTag: '"{AAAA},1"' })), ctx(), shared);
    expect(a.response.body).toBe('{"eTag":"<etag-1>"}');
    expect(b.response.body).toBe('{"eTag":"<etag-2>"}');
    expect(c.response.body).toBe('{"eTag":"<etag-1>"}');
  });
});

describe("report", () => {
  it("writes one row per step with the verdict and the observed status", () => {
    const records: ProbeRecord[] = [{
      id: "L1", assumption: "Sites.Selected reaches list items", expected: "200",
      request: { method: "GET", url: "u" }, response: { status: 200, headers: {}, body: "{}" }, verdict: { kind: "pass" },
    }];
    const md = reportMarkdown(records, "20261107T093000Z", ["Sites.Selected"]);
    expect(md).toContain("| L1 | Sites.Selected reaches list items | 200 | 200 | pass |");
    expect(md).toContain("20261107T093000Z");
    expect(md).toContain("exactly: Sites.Selected.");
    expect(md).not.toContain("developer tenant");
  });
});
