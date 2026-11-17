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

