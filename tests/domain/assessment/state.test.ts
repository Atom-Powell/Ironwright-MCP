import { describe, expect, it } from "vitest";
import { L1B_ITEM_READ } from "../../graph/fixtures/assessment-probe.js";
import {
  allOf, fieldsFor, recordFromFields, requireArtifact, requireInProgress, requireRoot,
  type AssessmentColumns, type AssessmentState,
} from "../../../src/domain/assessment/state.js";

const columns: AssessmentColumns = {
  assessmentId: "AssessmentId", vendorFolder: "VendorFolder", scope: "Scope", status: "Status",
  state: "State", disposition: "Disposition", risk: "Risk", summary: "Summary",
};

function stateWith(overrides: Partial<AssessmentState> = {}): AssessmentState {
  return {
    record: recordFromFields(L1B_ITEM_READ.fields, "2", L1B_ITEM_READ.eTag, columns),
    rootPath: "Assessments/ProbeVendor/PRB-1",
    rootPresent: true,
    artifacts: [{ kind: "dossier", path: "Assessments/ProbeVendor/PRB-1/Research/d.md", present: true, eTag: "e", size: 3 }],
    ...overrides,
  };
}

describe("recordFromFields", () => {
  it("reads the probe item, with an absent column as undefined rather than an empty string", () => {
    expect(recordFromFields(L1B_ITEM_READ.fields, "2", L1B_ITEM_READ.eTag, columns)).toEqual({
      itemId: "2",
      etag: L1B_ITEM_READ.eTag,
      assessmentId: "PRB-20261107T203924Z-00002",
      vendorTitle: "probe 20261107T203924Z",
      vendorFolder: "ProbeVendor",
      scope: undefined,
      status: "In Progress",
      state: undefined,
      disposition: undefined,
      risk: undefined,
      summary: undefined,
    });
  });
});

describe("fieldsFor", () => {
  it("maps only the keys given to the list column names", () => {
    expect(fieldsFor(columns, { status: "Completed", disposition: "Approved" })).toEqual({ Status: "Completed", Disposition: "Approved" });
  });
});

describe("preconditions", () => {
  it("requireInProgress passes when the status is the in-progress label", () => {
    expect(requireInProgress(stateWith(), { inProgress: "In Progress" })).toEqual({ ok: true });
  });

  it("requireRoot passes when the root is present", () => {
    expect(requireRoot(stateWith())).toEqual({ ok: true });
  });

  it("requireArtifact passes when the artifact is present", () => {
    expect(requireArtifact(stateWith(), "dossier")).toEqual({ ok: true });
  });

  it("allOf passes when every check passes and otherwise returns the first failure", () => {
    expect(allOf({ ok: true }, { ok: true })).toEqual({ ok: true });
    const first = { ok: false as const, expected: "a", observed: "b", evidence: [] };
    const second = { ok: false as const, expected: "c", observed: "d", evidence: [] };
    expect(allOf({ ok: true }, first, second)).toBe(first);
  });
});
