import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createSimDeployment, type SimDeployment } from "../../../scripts/sim/deployment.js";
import { runOpenAssessment } from "../../../src/tools/assessment/open.js";
import { runSaveAssessmentArtifact } from "../../../src/tools/assessment/save-artifact.js";
import { runReadAssessmentArtifact } from "../../../src/tools/assessment/read-artifact.js";
import { runRecordFindings } from "../../../src/tools/assessment/record-findings.js";
import { runVerifyPublication } from "../../../src/tools/assessment/verify-publication.js";
import { runTransitionAssessment } from "../../../src/tools/assessment/transition.js";
import { runGetAssessment } from "../../../src/tools/assessment/get.js";

const PROFILE = "vendor-assessments";
const NOW = new Date("2026-11-17T09:00:00.000Z");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const FINDINGS = [
  { key: "F-1", observation: "SOC 2 report covers only the hosting subsidiary.", risk: "High", recommendation: "Request the parent company report." },
  { key: "F-2", observation: "No penetration test in the last year.", risk: "Medium", recommendation: "Request a current summary." },
];

function deployment(options: Parameters<typeof createSimDeployment>[0] = {}): SimDeployment {
  return createSimDeployment({ now: () => NOW, ...options });
}

function structured(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) throw new Error(`the tool refused: ${result.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ")}`);
  return result.structuredContent as Record<string, unknown>;
}

function text(result: CallToolResult): string {
  return result.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
}

/** The requests that wrote, since `from`. */
function writesSince(d: SimDeployment, from: number): { method: string; path: string }[] {
  return d.sim.calls.slice(from).filter((call) => call.method !== "GET");
}

// The real tool handlers against the simulated tenant, which holds state between calls. These
// show that the server's own steps compose; what Graph does is measured in the live sittings.
describe("the assessment lifecycle against the simulated tenant", () => {
  it("runs open, save, findings, publication and completion, leaving the lists, the library and the journal agreeing", async () => {
    const d = deployment();

    const opened = structured(await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context));
    const id = opened.assessmentId as string;
    expect(id).toBe("ASM-2026-00001");

    const saved = structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "# Acme Corp\n" }, d.context));
    expect(saved).toMatchObject({ operation: "created", stage: "DOSSIER", path: `Assessments/Acme Corp/${id}/Research/Acme Corp_Research_Dossier.md` });

    const read = structured(await runReadAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier" }, d.context));
    expect(read.content).toBe("# Acme Corp\n");
    expect(read.sha256).toBe(saved.sha256);

    expect(structured(await runRecordFindings({ profileId: PROFILE, assessmentId: id, findings: FINDINGS, summary: "Two findings, one high." }, d.context))).toMatchObject({ created: 2 });
    structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "executive_summary", content: "Summary.\n" }, d.context));

    // The publisher is not this server: it writes the publication at the canonical path itself.
    expect(structured(await runVerifyPublication({ profileId: PROFILE, assessmentId: id }, d.context)).present).toBe(false);
    d.sim.putFile(`Assessments/Acme Corp/${id}/Published/Acme Corp_${id}_Risk_Assessment.docx`, bytes("docx bytes"));
    expect(structured(await runVerifyPublication({ profileId: PROFILE, assessmentId: id }, d.context)).present).toBe(true);

    const moved = structured(await runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "completed", disposition: "Approved with conditions", risk: "Medium" }, d.context));
    expect(moved).toMatchObject({ transitioned: true, status: "Completed" });

    expect(d.sim.listItems("Vendors")).toEqual([{ id: "1", fields: { Title: "Acme Corp", FolderName: "Acme Corp" } }]);
    expect(d.sim.listItems("Assessments")).toEqual([
      {
        id: "1",
        fields: {
          Title: "Acme Corp", AssessmentId: id, VendorFolder: "Acme Corp", Scope: "Security", Status: "Completed",
          State: "LIFECYCLE", Disposition: "Approved with conditions", Risk: "Medium", Summary: "Two findings, one high.",
        },
      },
    ]);
    expect(d.sim.listItems("Findings").map((item) => item.fields.FindingKey)).toEqual(["F-1", "F-2"]);
    expect(d.sim.tree().filter((entry) => entry.kind === "file").map((entry) => entry.path)).toEqual([
      `Assessments/Acme Corp/${id}/Published/${id}_Executive_Summary.md`,
      `Assessments/Acme Corp/${id}/Published/Acme Corp_${id}_Risk_Assessment.docx`,
      `Assessments/Acme Corp/${id}/Research/Acme Corp_Research_Dossier.md`,
    ]);

    const got = structured(await runGetAssessment({ profileId: PROFILE, assessmentId: id }, d.context));
    expect(got.assessment).toMatchObject({ status: "Completed", disposition: "Approved with conditions", risk: "Medium" });
    expect((got.artifacts as { present: boolean }[]).every((artifact) => artifact.present)).toBe(true);
    // Every write the server made is in the journal: the id, six folders, two files and their
    // stage updates, two findings and their summary, and the transition.
    expect((got.journal as { entries: number }).entries).toBe(15);
  });

  it("writes nothing when each step is called a second time", async () => {
    const d = deployment();
    const id = structured(await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context)).assessmentId as string;
    const steps: (() => Promise<CallToolResult>)[] = [
      () => runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context),
      () => runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "# Acme Corp\n" }, d.context),
      () => runRecordFindings({ profileId: PROFILE, assessmentId: id, findings: FINDINGS, summary: "Two findings." }, d.context),
    ];
    for (const step of steps) {
      structured(await step());
      const mark = d.sim.calls.length;
      structured(await step());
      expect(writesSince(d, mark)).toEqual([]);
    }

    d.sim.putFile(`Assessments/Acme Corp/${id}/Published/Acme Corp_${id}_Risk_Assessment.docx`, bytes("docx"));
    const complete = (): Promise<CallToolResult> => runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "completed", disposition: "Approved", risk: "Low" }, d.context);
    expect(structured(await complete()).transitioned).toBe(true);
    const mark = d.sim.calls.length;
    expect(structured(await complete()).transitioned).toBe(false);
    expect(writesSince(d, mark)).toEqual([]);
  });

  it("opens one assessment when four opens for one vendor arrive together (the campaign's first defect)", async () => {
    const d = deployment();
    const open = (): Promise<CallToolResult> => runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context);

    const results = (await Promise.all([open(), open(), open(), open()])).map(structured);

    expect(d.sim.listItems("Assessments")).toHaveLength(1);
    expect(d.sim.listItems("Vendors")).toHaveLength(1);
    expect(results.map((result) => result.created).sort()).toEqual([false, false, false, true]);
    expect(new Set(results.map((result) => result.assessmentId)).size).toBe(1);
  });

  it("creates each finding once when two record_findings calls arrive together", async () => {
    const d = deployment();
    const id = structured(await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context)).assessmentId as string;
    structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "# Acme Corp\n" }, d.context));
    const record = (): Promise<CallToolResult> => runRecordFindings({ profileId: PROFILE, assessmentId: id, findings: FINDINGS, summary: "Two findings." }, d.context);

    const results = (await Promise.all([record(), record()])).map(structured);

    expect(d.sim.listItems("Findings")).toHaveLength(2);
    expect(results.map((result) => result.created).sort()).toEqual([0, 2]);
  });

  it("carries a vendor name with punctuation through open and save, under names the library accepts", async () => {
    // The simulated tenant refuses a name SharePoint would refuse, so a raw colon reaching a path fails here.
    const d = deployment();
    const opened = structured(await runOpenAssessment({ profileId: PROFILE, vendor: 'Acme: Cloud "West" Inc.', scope: "Security" }, d.context));
    expect(opened).toMatchObject({ vendor: 'Acme: Cloud "West" Inc.', vendorFolder: "Acme Cloud West Inc" });

    const saved = structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: opened.assessmentId, kind: "dossier", content: "x" }, d.context));
    expect(saved.path).toBe(`Assessments/Acme Cloud West Inc/${opened.assessmentId as string}/Research/Acme Cloud West Inc._Research_Dossier.md`);
  });

  it("does not complete on a publication whose name differs by case (the campaign's second defect)", async () => {
    const d = deployment();
    const id = structured(await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context)).assessmentId as string;
    structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "x" }, d.context));
    d.sim.putFile(`Assessments/Acme Corp/${id}/Published/acme corp_${id}_risk_assessment.docx`, bytes("docx"));

    const result = await runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "completed", disposition: "Approved", risk: "Low" }, d.context);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`the path answered a file named "acme corp_${id}_risk_assessment.docx"`);
    expect(d.sim.listItems("Assessments")[0]!.fields.Status).toBe("In Progress");
  });

  it("refuses a second vendor name that would file under the first vendor's folder", async () => {
    const d = deployment();
    structured(await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Inc", scope: "Security" }, d.context));

    const result = await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Inc.", scope: "Security" }, d.context);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('already uses');
    expect(d.sim.listItems("Vendors")).toHaveLength(1);
    expect(d.sim.listItems("Assessments")).toHaveLength(1);
  });

  it("runs the same lifecycle when list filters match case exactly, the reading no probe has settled", async () => {
    const d = deployment({ listFilterIgnoresCase: false });
    const id = structured(await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context)).assessmentId as string;
    structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "x" }, d.context));
    structured(await runRecordFindings({ profileId: PROFILE, assessmentId: id, findings: FINDINGS, summary: "Two findings." }, d.context));
    structured(await runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "provisional", disposition: "Approved", risk: "Low" }, d.context));

    expect(d.sim.listItems("Assessments")[0]!.fields.Status).toBe("Provisional");
    expect(structured(await runGetAssessment({ profileId: PROFILE, assessmentId: id.toLowerCase() }, d.context)).found).toBe(false);
  });
});

describe("overlapping lifecycle calls on one assessment", () => {
  async function opened(d: SimDeployment): Promise<string> {
    return structured(await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context)).assessmentId as string;
  }

  it("lets the second of two saves arriving together overwrite the first, instead of failing on the file the first created", async () => {
    const d = deployment();
    const id = await opened(d);
    const save = (content: string): Promise<CallToolResult> => runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content }, d.context);

    const results = (await Promise.all([save("first draft"), save("second draft")])).map(structured);

    expect(results.map((result) => result.operation)).toEqual(["created", "overwritten"]);
    const read = structured(await runReadAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier" }, d.context));
    expect(read.content).toBe("second draft");
  });

  it("does not let a save that started before a transition write its stage over the transition's", async () => {
    const d = deployment();
    const id = await opened(d);
    structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "first draft" }, d.context));

    const [saved, moved] = await Promise.all([
      runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "corrected draft" }, d.context),
      runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "provisional", disposition: "Approved", risk: "Low" }, d.context),
    ]);

    expect(structured(saved).operation).toBe("overwritten");
    expect(structured(moved).transitioned).toBe(true);
    // The transition ran after the save, so its stage is the last one written.
    expect(d.sim.listItems("Assessments")[0]!.fields).toMatchObject({ Status: "Provisional", State: "LIFECYCLE" });
  });

  // The six rulings of 2026-11-17, each run through the real handlers over state that persists.

  it("refuses a transition, and keeps a person's edit, when the item is changed between the tool's read and its write", async () => {
    const d = deployment();
    const id = await opened(d);
    structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "x" }, d.context));
    d.sim.putFile(`Assessments/Acme Corp/${id}/Published/Acme Corp_${id}_Risk_Assessment.docx`, bytes("docx"));

    // A person edits the item in the browser after the tool has read it and before it writes.
    let edited = false;
    const graph: typeof d.sim.graph = {
      ...d.sim.graph,
      patch: async <T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> => {
        if (!edited) {
          edited = true;
          d.sim.setListItemFields("Assessments", "1", { Disposition: "Rejected" });
        }
        return d.sim.graph.patch<T>(path, body, headers);
      },
    };

    const result = await runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "completed", disposition: "Approved", risk: "Low" }, { ...d.context, graph });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("expected Assessments item 1 unchanged since this call read it, observed the item changed: Graph answered 412 to If-Match");
    expect(text(result)).toContain("Nothing was written.");
    expect(d.sim.listItems("Assessments")[0]!.fields).toMatchObject({ Status: "In Progress", Disposition: "Rejected" });

    // The caller decides again on what is there now, and the same call then lands.
    const again = structured(await runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "completed", disposition: "Approved", risk: "Low" }, d.context));
    expect(again).toMatchObject({ transitioned: true, status: "Completed", disposition: "Approved" });
  });

  it("returns a provisional assessment on open and completes it once the publication exists, with one item throughout", async () => {
    const d = deployment();
    const id = await opened(d);
    structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "x" }, d.context));
    structured(await runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "provisional", disposition: "Approved with conditions", risk: "Medium" }, d.context));

    const reopened = structured(await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context));
    expect(reopened).toMatchObject({ assessmentId: id, created: false, status: "Provisional" });

    const early = await runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "completed", disposition: "Approved", risk: "Low" }, d.context);
    expect(early.isError).toBe(true);
    expect(text(early)).toContain("expected the publication present at its canonical path");

    d.sim.putFile(`Assessments/Acme Corp/${id}/Published/Acme Corp_${id}_Risk_Assessment.docx`, bytes("docx"));
    const done = structured(await runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "completed", disposition: "Approved", risk: "Low" }, d.context));
    expect(done).toMatchObject({ transitioned: true, previousStatus: "Provisional", status: "Completed" });
    expect(d.sim.listItems("Assessments")).toHaveLength(1);
  });

  it("leaves State at FINDINGS when the dossier is saved again unchanged", async () => {
    const d = deployment();
    const id = await opened(d);
    structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "the dossier" }, d.context));
    structured(await runRecordFindings({ profileId: PROFILE, assessmentId: id, findings: FINDINGS, summary: "Two findings." }, d.context));
    const from = d.sim.calls.length;

    const again = structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "the dossier" }, d.context));

    expect(again.operation).toBe("unchanged");
    expect(writesSince(d, from)).toEqual([]);
    expect(d.sim.listItems("Assessments")[0]!.fields.State).toBe("FINDINGS");
  });

  it("journals the Published folder when a save brings it back after it was deleted", async () => {
    const d = deployment();
    const id = await opened(d);
    structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "x" }, d.context));
    const published = `Assessments/Acme Corp/${id}/Published`;
    d.sim.removeItem(published);

    const saved = structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "executive_summary", content: "Summary." }, d.context));

    expect(saved).toMatchObject({ operation: "created", foldersCreated: [published] });
    expect(d.sim.tree().some((node) => node.path === published && node.kind === "folder")).toBe(true);
    const journal = await d.context.store.listJournal(PROFILE, id);
    expect(journal.filter((entry) => entry.operation === "folder_created" && entry.stage === "EXECUTIVE_SUMMARY").map((entry) => entry.target)).toEqual([published]);
  });

  // The same seven tools under a profile that names its own lists, kinds and gates. Nothing in
  // the code knows what an intake or a signed handover is; the shipped example profile does.
  it("runs a client onboarding end to end under a profile that defines its own workflow", async () => {
    const d = deployment({ profilePath: "examples/profiles/msp-client-onboarding.json" });
    const P = "client-onboarding";
    const id = structured(await runOpenAssessment({ profileId: P, vendor: "Contoso Dental", scope: "Managed IT" }, d.context)).assessmentId as string;
    expect(id).toBe("ONB-2026-00001");
    const root = `Clients/Contoso Dental/Onboarding/${id}`;

    // Findings wait on the intake, by this profile's gate.
    const early = await runRecordFindings({ profileId: P, assessmentId: id, findings: FINDINGS, summary: "Two issues." }, d.context);
    expect(early.isError).toBe(true);
    expect(text(early)).toContain("expected the intake present at its canonical path");

    expect(structured(await runSaveAssessmentArtifact({ profileId: P, assessmentId: id, kind: "intake", content: "# Intake\n" }, d.context))).toMatchObject({
      operation: "created",
      stage: "INTAKE",
      path: `${root}/Intake/Contoso Dental_Intake.md`,
    });
    // The intake is a kind this profile lists as corrected.
    expect(structured(await runSaveAssessmentArtifact({ profileId: P, assessmentId: id, kind: "intake", content: "# Intake, revised\n" }, d.context)).stage).toBe("CORRECTION");
    expect(structured(await runRecordFindings({ profileId: P, assessmentId: id, findings: FINDINGS, summary: "Two issues." }, d.context))).toMatchObject({ created: 2 });

    // The signed handover is the client's document. The server refuses to write it.
    const forged = await runSaveAssessmentArtifact({ profileId: P, assessmentId: id, kind: "handover", content: "signed" }, d.context);
    expect(forged.isError).toBe(true);
    expect(text(forged)).toContain("The handover is not written by this server");

    // Awaiting Handover, this profile's provisional status, waits on the runbook as well.
    const noRunbook = await runTransitionAssessment({ profileId: P, assessmentId: id, target: "provisional", disposition: "Onboarded with exceptions", risk: "Low" }, d.context);
    expect(text(noRunbook)).toContain("expected the runbook present at its canonical path");
    structured(await runSaveAssessmentArtifact({ profileId: P, assessmentId: id, kind: "runbook", content: "# Runbook\n" }, d.context));
    expect(structured(await runTransitionAssessment({ profileId: P, assessmentId: id, target: "provisional", disposition: "Onboarded with exceptions", risk: "Low" }, d.context)).status).toBe("Awaiting Handover");

    // Completion waits on the signed handover, which someone other than this server uploads.
    expect(structured(await runVerifyPublication({ profileId: P, assessmentId: id }, d.context))).toMatchObject({ kind: "handover", present: false });
    const noHandover = await runTransitionAssessment({ profileId: P, assessmentId: id, target: "completed", disposition: "Onboarded", risk: "Low" }, d.context);
    expect(text(noHandover)).toContain("expected the handover present at its canonical path");
    d.sim.putFile(`${root}/Handover/Contoso Dental_${id}_Signed_Handover.pdf`, bytes("pdf bytes"));
    expect(structured(await runVerifyPublication({ profileId: P, assessmentId: id }, d.context)).present).toBe(true);

    expect(structured(await runTransitionAssessment({ profileId: P, assessmentId: id, target: "completed", disposition: "Onboarded", risk: "Low" }, d.context))).toMatchObject({
      transitioned: true,
      previousStatus: "Awaiting Handover",
      status: "Completed",
    });
    expect(d.sim.listItems("Onboardings")[0]!.fields).toMatchObject({ OnboardingId: id, Status: "Completed", Outcome: "Onboarded", State: "LIFECYCLE" });
    expect(d.sim.listItems("Clients")).toHaveLength(1);
    expect(d.sim.listItems("Onboarding Issues")).toHaveLength(2);
  });

  it("orders a save and a record_findings call for one assessment typed in two cases", async () => {
    const d = deployment();
    const id = await opened(d);
    structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "first draft" }, d.context));

    const [recorded, saved] = await Promise.all([
      runRecordFindings({ profileId: PROFILE, assessmentId: id.toLowerCase(), findings: FINDINGS, summary: "Two findings." }, d.context),
      runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "executive_summary", content: "Summary." }, d.context),
    ]);

    structured(recorded);
    structured(saved);
    // The save ran second, so the stage it stands for is the one the item holds.
    expect(d.sim.listItems("Assessments")[0]!.fields.State).toBe("EXECUTIVE_SUMMARY");
  });
});

describe("the readiness get_assessment reports", () => {
  type Readiness = { tool: string; target?: string; ready: boolean };
  const scenarios: Record<string, (d: SimDeployment, id: string) => Promise<void>> = {
    "just opened": async () => undefined,
    "the dossier saved": async (d, id) => {
      structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "x" }, d.context));
    },
    "the dossier saved and the publication written": async (d, id) => {
      structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "x" }, d.context));
      d.sim.putFile(`Assessments/Acme Corp/${id}/Published/Acme Corp_${id}_Risk_Assessment.docx`, bytes("docx"));
    },
    "the workspace root deleted": async (d, id) => {
      d.sim.removeItem(`Assessments/Acme Corp/${id}`);
    },
    "moved to provisional": async (d, id) => {
      structured(await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "dossier", content: "x" }, d.context));
      structured(await runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "provisional", disposition: "Approved", risk: "Low" }, d.context));
    },
  };
  const actions: Record<string, (d: SimDeployment, id: string) => Promise<CallToolResult>> = {
    "save_assessment_artifact": (d, id) => runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: id, kind: "executive_summary", content: "s" }, d.context),
    "record_findings": (d, id) => runRecordFindings({ profileId: PROFILE, assessmentId: id, findings: FINDINGS, summary: "Two findings." }, d.context),
    "transition_assessment provisional": (d, id) => runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "provisional", disposition: "Approved with conditions", risk: "High" }, d.context),
    "transition_assessment completed": (d, id) => runTransitionAssessment({ profileId: PROFILE, assessmentId: id, target: "completed", disposition: "Approved with conditions", risk: "High" }, d.context),
  };

  // Each scenario is built afresh for each tool, the report is read, and the tool is then called.
  // The report is the tool's own precondition, so the two must agree in every cell.
  it.each(Object.keys(scenarios).flatMap((scenario) => Object.keys(actions).map((action) => [scenario, action] as const)))(
    "with %s, agrees with what %s then does",
    async (scenario, action) => {
      const d = deployment();
      const id = structured(await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context)).assessmentId as string;
      await scenarios[scenario]!(d, id);

      const readiness = structured(await runGetAssessment({ profileId: PROFILE, assessmentId: id }, d.context)).readiness as Readiness[];
      const reported = readiness.find((entry) => [entry.tool, entry.target].filter((part) => part !== undefined).join(" ") === action)!;
      const result = await actions[action]!(d, id);

      expect(reported.ready).toBe(result.isError !== true);
    },
  );
});

