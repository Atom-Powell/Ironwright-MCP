import { describe, expect, it } from "vitest";
import { L1B_ITEM_READ } from "../../graph/fixtures/assessment-probe.js";
import {
  allOf, fieldsFor, findingsPrecondition, lifecycleReadiness, recordFromFields, requireArtifact, requireInProgress, requireRoot,
  savePrecondition, transitionPrecondition,
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

describe("the lifecycle preconditions, one definition per tool", () => {
  const RULES = {
    status: { inProgress: "In Progress", provisional: "Provisional" },
    gates: { findings: ["dossier"], provisional: ["dossier"], completed: ["dossier", "publication"] },
  };
  const DOSSIER = "Assessments/ProbeVendor/PRB-1/Research/d.md";
  const PUBLICATION = "Assessments/ProbeVendor/PRB-1/Published/p.docx";
  const artifact = (kind: string, path: string, present: boolean): AssessmentState["artifacts"][number] => ({ kind, path, present, eTag: present ? "e" : undefined, size: present ? 3 : undefined });
  const withArtifacts = (dossier: boolean, publication: boolean): AssessmentState =>
    stateWith({ artifacts: [artifact("dossier", DOSSIER, dossier), artifact("publication", PUBLICATION, publication)] });

  it("a save needs the item in progress and the workspace root, and no artifact", () => {
    expect(savePrecondition(withArtifacts(false, false), RULES, "the list").ok).toBe(true);
    expect(savePrecondition(stateWith({ rootPresent: false }), RULES, "the list").ok).toBe(false);
  });

  it("recording findings needs the dossier", () => {
    expect(findingsPrecondition(withArtifacts(true, false), RULES, "the list").ok).toBe(true);
    expect(findingsPrecondition(withArtifacts(false, false), RULES, "the list")).toMatchObject({ ok: false, observed: "not present" });
  });

  it("completing needs the dossier and the publication, and a provisional move only the dossier", () => {
    expect(transitionPrecondition(withArtifacts(true, false), RULES, "provisional", "the list").ok).toBe(true);
    expect(transitionPrecondition(withArtifacts(true, false), RULES, "completed", "the list")).toMatchObject({
      ok: false,
      expected: "the publication present at its canonical path",
      evidence: [{ source: "drive", target: PUBLICATION, found: "not found" }],
    });
    expect(transitionPrecondition(withArtifacts(true, true), RULES, "completed", "the list").ok).toBe(true);
  });

  // Ruled 2026-11-17: provisional is not an end state.
  it("completion is reached from provisional as well as from in progress, and nothing else is", () => {
    const parked = withArtifacts(true, true);
    parked.record!.status = "Provisional";

    expect(transitionPrecondition(parked, RULES, "completed", "the list").ok).toBe(true);
    expect(transitionPrecondition(parked, RULES, "provisional", "the list")).toMatchObject({ ok: false, expected: 'status "In Progress"', observed: 'status "Provisional"' });
    expect(savePrecondition(parked, RULES, "the list")).toMatchObject({ ok: false, expected: 'status "In Progress"' });
    expect(findingsPrecondition(parked, RULES, "the list")).toMatchObject({ ok: false, expected: 'status "In Progress"' });

    const done = withArtifacts(true, true);
    done.record!.status = "Completed";
    expect(transitionPrecondition(done, RULES, "completed", "the list")).toMatchObject({ ok: false, expected: 'status "In Progress" or "Provisional"', observed: 'status "Completed"' });
  });

  it("a provisional assessment without its publication is refused for the publication, not for its status", () => {
    const parked = withArtifacts(true, false);
    parked.record!.status = "Provisional";

    expect(transitionPrecondition(parked, RULES, "completed", "the list")).toMatchObject({ ok: false, expected: "the publication present at its canonical path" });
    expect(lifecycleReadiness(parked, RULES, "the list").map((entry) => entry.ready)).toEqual([false, false, false, false]);
  });

  // The kinds that gate a stage are the profile's, not the code's: vendor risk names a dossier
  // and a publication, and a client onboarding names an intake, a runbook and a signed handover.
  it("takes each gate from the profile, so another workflow's kinds gate its stages", () => {
    const onboarding = { status: RULES.status, gates: { findings: ["intake"], provisional: ["intake", "runbook"], completed: ["intake", "runbook", "handover"] } };
    const having = (intake: boolean, runbook: boolean, handover: boolean): AssessmentState =>
      stateWith({ artifacts: [artifact("intake", "C/Intake/i.md", intake), artifact("runbook", "C/Handover/r.md", runbook), artifact("handover", "C/Handover/h.pdf", handover)] });

    expect(findingsPrecondition(having(true, false, false), onboarding, "the list").ok).toBe(true);
    expect(findingsPrecondition(having(false, true, true), onboarding, "the list")).toMatchObject({ ok: false, expected: "the intake present at its canonical path" });
    expect(transitionPrecondition(having(true, false, false), onboarding, "provisional", "the list")).toMatchObject({ ok: false, expected: "the runbook present at its canonical path" });
    expect(transitionPrecondition(having(true, true, false), onboarding, "provisional", "the list").ok).toBe(true);
    expect(transitionPrecondition(having(true, true, false), onboarding, "completed", "the list")).toMatchObject({
      ok: false,
      expected: "the handover present at its canonical path",
      evidence: [{ source: "drive", target: "C/Handover/h.pdf", found: "not found" }],
    });
    expect(transitionPrecondition(having(true, true, true), onboarding, "completed", "the list").ok).toBe(true);
  });

  it("asks for no artifact where a gate names none", () => {
    const open = { status: RULES.status, gates: { findings: [], provisional: [], completed: ["dossier"] } };

    expect(findingsPrecondition(withArtifacts(false, false), open, "the list").ok).toBe(true);
    expect(transitionPrecondition(withArtifacts(false, false), open, "provisional", "the list").ok).toBe(true);
    expect(transitionPrecondition(withArtifacts(false, false), open, "completed", "the list").ok).toBe(false);
  });

  it("lifecycleReadiness reports each tool from those same preconditions, with the evidence of a refusal", () => {
    const readiness = lifecycleReadiness(withArtifacts(true, false), RULES, "the list");

    expect(readiness.map((entry) => [entry.tool, entry.target, entry.ready])).toEqual([
      ["save_assessment_artifact", undefined, true],
      ["record_findings", undefined, true],
      ["transition_assessment", "provisional", true],
      ["transition_assessment", "completed", false],
    ]);
    expect(readiness[3]).toMatchObject({ expected: "the publication present at its canonical path", observed: "not present", evidence: [{ source: "drive", target: PUBLICATION }] });
    expect(readiness[0]).toEqual({ tool: "save_assessment_artifact", ready: true });
  });

  it("reports nothing ready for an assessment that is no longer in progress", () => {
    const completed = withArtifacts(true, true);
    completed.record!.status = "Completed";

    const readiness = lifecycleReadiness(completed, RULES, "the list");

    expect(readiness.every((entry) => !entry.ready)).toBe(true);
    expect(readiness[0]).toMatchObject({ expected: 'status "In Progress"', observed: 'status "Completed"' });
  });
});
