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

  it("F3b records a 412 as observed, not passed, when F3a captured no changed eTag", () => {
    const res = { status: 412, headers: {}, body: "{}" };
    const note = "412 received but F3a did not capture a changed eTag, so staleness was not established";
    expect(step("F3b").judge(res, { ...base, fileEtag: "e" })).toEqual({ kind: "observed", note });
    expect(step("F3b").judge(res, { ...base, fileEtag: "e", newEtag: "e" })).toEqual({ kind: "observed", note });
  });

  it("F3c fails on a 201, naming the status, because an absent path must not be created under a stale precondition", () => {
    const v = step("F3c").judge({ status: 201, headers: {}, body: "{}" }, { ...base, driveId: "d", fileEtag: "e" });
    expect(v).toEqual({ kind: "fail", because: "expected 412, received 201" });
  });

  it("F3c names the error code when the status is wrong and the body carries one", () => {
    const body = JSON.stringify({ error: { code: "itemNotFound", message: "x" } });
    const v = step("F3c").judge({ status: 404, headers: {}, body }, { ...base, driveId: "d", fileEtag: "e" });
    expect(v).toEqual({ kind: "fail", because: "expected 412, received 404 itemNotFound" });
  });

  it("F3c throws when no file etag was captured", () => {
    expect(() => step("F3c").request({ ...base, siteId: "s", driveId: "d" })).toThrow(/fileEtag/);
  });

  it("F1b names the error code it saw when the status was right but the code was not", () => {
    const body = JSON.stringify({ error: { code: "accessDenied", message: "x" } });
    const v = step("F1b").judge({ status: 409, headers: {}, body }, { ...base, driveId: "d" });
    expect(v).toEqual({ kind: "fail", because: "expected 409 nameAlreadyExists, received 409 accessDenied" });
  });

  it("F0 names the error code on a 409 that is not nameAlreadyExists", () => {
    const body = JSON.stringify({ error: { code: "notAllowed", message: "x" } });
    const v = step("F0").judge({ status: 409, headers: {}, body }, { ...base, driveId: "d" });
    expect(v).toEqual({ kind: "fail", because: "expected 201 or 409 nameAlreadyExists, received 409 notAllowed" });
  });

  it("F2a notes a missing eTag the way F1a does", () => {
    const v = step("F2a").judge({ status: 201, headers: {}, body: "{}" }, { ...base, driveId: "d" });
    expect(v).toEqual({ kind: "fail", because: "expected 201 with eTag, received 201 without eTag" });
  });
});
