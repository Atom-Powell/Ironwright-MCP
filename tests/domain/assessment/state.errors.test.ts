import { describe, expect, it } from "vitest";
import {
  recordFromFields, requireArtifact, requireInProgress, requireRecord, requireRoot,
  type AssessmentColumns, type AssessmentState, type Precondition,
} from "../../../src/domain/assessment/state.js";

const columns: AssessmentColumns = {
  assessmentId: "AssessmentId", vendorFolder: "VendorFolder", scope: "Scope", status: "Status",
  state: "State", disposition: "Disposition", risk: "Risk", summary: "Summary",
};

function stateWith(overrides: Partial<AssessmentState> = {}): AssessmentState {
  return {
    record: recordFromFields({ Status: "Completed" }, "7", undefined, columns),
    rootPath: "Assessments/V/A-1",
    rootPresent: true,
    artifacts: [{ kind: "dossier", path: "Assessments/V/A-1/Research/d.md", present: false, eTag: undefined, size: undefined }],
    ...overrides,
  };
}

function failure(check: Precondition) {
  if (check.ok) throw new Error("expected a failed precondition");
  expect(check.evidence.length).toBeGreaterThan(0);
  return check;
}

describe("precondition failures", () => {
  it("names the missing assessment item and cites the list", () => {
    const result = failure(requireRecord(stateWith({ record: undefined }), "Assessments#A-1"));
    expect(result.expected).toContain("assessment item");
    expect(result.observed).toContain("no item");
    expect(result.evidence[0]).toMatchObject({ source: "list", target: "Assessments#A-1" });
  });

  it("names the status label it read when in progress is required", () => {
    const result = failure(requireInProgress(stateWith(), { inProgress: "In Progress" }));
    expect(result.expected).toContain("In Progress");
    expect(result.observed).toContain("Completed");
    expect(result.evidence[0]).toMatchObject({ source: "list" });
  });

  it("cites the root path when the root is absent", () => {
    const result = failure(requireRoot(stateWith({ rootPresent: false })));
    expect(result.evidence[0]).toMatchObject({ source: "drive", target: "Assessments/V/A-1" });
  });

  it("cites the artifact path when the artifact is absent", () => {
    const result = failure(requireArtifact(stateWith(), "dossier"));
    expect(result.observed).toContain("not present");
    expect(result.evidence[0]).toMatchObject({ source: "drive", target: "Assessments/V/A-1/Research/d.md" });
  });

  it("throws, naming the kind, for an artifact kind the state does not know", () => {
    expect(() => requireArtifact(stateWith(), "memo")).toThrow(/"memo"/);
  });
});
