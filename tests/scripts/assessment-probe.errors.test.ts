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
