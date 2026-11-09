import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSITION_INPUT_CONSTRAINTS, runTransitionAssessment } from "../../../src/tools/assessment/transition.js";
import { assessmentToolContext, createScriptedGraph, listItem, resultText } from "./fake-graph.js";
import { DOSSIER_PATH, ID, PROFILE, PUBLICATION_PATH, dossierItem, publicationItem, stateFields, stateScript } from "./state-script.js";

const INPUT = { profileId: PROFILE, assessmentId: ID, target: "completed", disposition: "Approved", risk: "Low" };
const COMPLETED = { Status: "Completed", Disposition: "Approved", Risk: "Low", State: "LIFECYCLE" };

describe("transition_assessment failures", () => {
  // The handler logs an unexpected failure before describing it; silenced so the run's output stays clean.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a disposition the profile does not name before any Graph request, listing the labels", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runTransitionAssessment({ ...INPUT, disposition: "Waived" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(TRANSITION_INPUT_CONSTRAINTS);
    expect(resultText(result)).toContain('"Waived"');
    expect(resultText(result)).toContain("Approved, Approved with conditions, Rejected");
    expect(graph.requests()).toBe(0);
  });

  it("refuses a risk the profile does not name before any Graph request, listing the labels", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runTransitionAssessment({ ...INPUT, risk: "Severe" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(TRANSITION_INPUT_CONSTRAINTS);
    expect(resultText(result)).toContain('"Severe"');
    expect(resultText(result)).toContain("Low, Medium, High");
    expect(graph.requests()).toBe(0);
  });

  it("refuses completion while the publication is absent, naming its path", async () => {
    const { graph, calls } = createScriptedGraph(stateScript({ dossier: dossierItem('"d1"', 120) }));

    const result = await runTransitionAssessment(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      refused: true,
      tool: "transition_assessment",
      stage: "LIFECYCLE",
      assessmentId: ID,
      evidence: [{ source: "drive", target: PUBLICATION_PATH, found: "not found" }],
    });
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses a provisional transition while the dossier is absent, naming its path", async () => {
    const { graph, calls } = createScriptedGraph(stateScript());

    const result = await runTransitionAssessment({ ...INPUT, target: "provisional" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ refused: true, stage: "LIFECYCLE", evidence: [{ source: "drive", target: DOSSIER_PATH, found: "not found" }] });
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses to move a completed assessment to provisional", async () => {
    const { graph, calls } = createScriptedGraph(stateScript({ fields: COMPLETED, dossier: dossierItem('"d1"', 120) }));

    const result = await runTransitionAssessment({ ...INPUT, target: "provisional" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    const refusal = result.structuredContent as { expected: string; observed: string };
    expect(refusal.expected).toContain("In Progress");
    expect(refusal.observed).toContain("Completed");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("reports a read back showing another status, keeping the journal entry for the update", async () => {
    const { graph } = createScriptedGraph([
      ...stateScript({ dossier: dossierItem('"d1"', 120), publication: publicationItem('"p1"', 10) }),
      { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", response: stateFields(COMPLETED) },
      { method: "get", pathIncludes: "/lists/Assessments/items/2?", response: listItem("2", stateFields({ ...COMPLETED, Status: "In Progress" }), '"item-2,2"') },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runTransitionAssessment(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('status "In Progress"');
    expect(resultText(result)).toContain('"Completed"');
    expect(resultText(result)).toContain("The journal records the update.");
    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal.map((entry) => [entry.operation, entry.stage, entry.etagAfter])).toEqual([["list_item_updated", "LIFECYCLE", '"item-2,2"']]);
  });

  it("reports a read back whose State is not LIFECYCLE, though status, disposition and risk match", async () => {
    const { graph } = createScriptedGraph([
      ...stateScript({ dossier: dossierItem('"d1"', 120), publication: publicationItem('"p1"', 10) }),
      { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", response: stateFields(COMPLETED) },
      { method: "get", pathIncludes: "/lists/Assessments/items/2?", response: listItem("2", stateFields({ ...COMPLETED, State: "FINDINGS" }), '"item-2,2"') },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runTransitionAssessment(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('reading it back found status "Completed", disposition "Approved", risk "Low" and State "FINDINGS".');
    expect(resultText(result)).toContain("The journal records the update.");
    expect((await context.store.listJournal(PROFILE, ID)).map((entry) => entry.operation)).toEqual(["list_item_updated"]);
  });

  it("reports a read back that finds no item, keeping the journal entry for the update", async () => {
    const { graph } = createScriptedGraph([
      ...stateScript({ dossier: dossierItem('"d1"', 120), publication: publicationItem('"p1"', 10) }),
      { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", response: stateFields(COMPLETED) },
      { method: "get", pathIncludes: "/lists/Assessments/items/2?", throws: { status: 404, code: "itemNotFound" } },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runTransitionAssessment(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("answered 404");
    expect(resultText(result)).toContain("The journal records the update.");
    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal).toHaveLength(1);
    expect(journal[0]!.etagAfter).toBeUndefined();
  });

  it("keeps the journal entry for the update when the read back itself fails", async () => {
    const { graph } = createScriptedGraph([
      ...stateScript({ dossier: dossierItem('"d1"', 120), publication: publicationItem('"p1"', 10) }),
      { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", response: stateFields(COMPLETED) },
      { method: "get", pathIncludes: "/lists/Assessments/items/2?", throws: { status: 503, code: "serviceNotAvailable" } },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runTransitionAssessment(INPUT, context);

    expect(result.isError).toBe(true);
    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal.map((entry) => entry.operation)).toEqual(["list_item_updated"]);
  });
});
