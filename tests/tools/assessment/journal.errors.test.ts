import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSimDeployment, type SimDeployment } from "../../../scripts/sim/deployment.js";
import { runOpenAssessment } from "../../../src/tools/assessment/open.js";
import { runSaveAssessmentArtifact } from "../../../src/tools/assessment/save-artifact.js";
import { resultText } from "./fake-graph.js";

const PROFILE = "vendor-assessments";

/** The deployment's context with a journal that refuses its next append, as a table store that is unreachable would. */
function failNextAppend(d: SimDeployment): void {
  const append = d.context.store.appendJournalEntry.bind(d.context.store);
  let failed = false;
  d.context.store.appendJournalEntry = async (profileId, assessmentId, entry) => {
    if (!failed) {
      failed = true;
      throw new Error("the table service did not answer");
    }
    return append(profileId, assessmentId, entry);
  };
}

describe("a journal append that fails after Graph confirmed the write", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says the write happened and is not in the journal, rather than reporting only the store's error", async () => {
    const d = createSimDeployment();
    const opened = await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context);
    const assessmentId = (opened.structuredContent as { assessmentId: string }).assessmentId;
    const path = `Assessments/Acme Corp/${assessmentId}/Research/Acme Corp_Research_Dossier.md`;
    failNextAppend(d);

    const result = await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId, kind: "dossier", content: "# Acme Corp\n" }, d.context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      `save_assessment_artifact stopped after a write it could not record: Graph confirmed file_created at ${path}, and the journal entry for it could not be stored ` +
        `(the table service did not answer). The write stands, and the journal for ${assessmentId} does not show it. Nothing further was written by this call.`,
    );
    // The file is there, which is what the message says.
    expect(d.sim.tree().some((entry) => entry.path === path)).toBe(true);
    expect((await d.context.store.listJournal(PROFILE, assessmentId)).some((entry) => entry.target === path)).toBe(false);
  });

  it("stops at the first create, which is the assessment item, and names the id it is filed under", async () => {
    const d = createSimDeployment();
    failNextAppend(d);

    const result = await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("open_assessment stopped after a write it could not record: Graph confirmed list_item_created at Assessments/1");
    expect(resultText(result)).toMatch(/the journal for ASM-\d{4}-00001 does not show it/);
    // Nothing further: the vendor record and the id are not written once the journal has failed.
    expect(d.sim.listItems("Assessments")).toHaveLength(1);
    expect(d.sim.listItems("Vendors")).toHaveLength(0);
  });
});
