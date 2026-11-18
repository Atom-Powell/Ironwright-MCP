import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSITION_INPUT_CONSTRAINTS, runTransitionAssessment } from "../../../src/tools/assessment/transition.js";
import { RESOLVE_DRIVE_SCRIPT, assessmentToolContext, createScriptedGraph, folderItem, listItem, refusalOf, resultText } from "./fake-graph.js";
import { DOSSIER_PATH, ID, PROFILE, PUBLICATION_PATH, ROOT, SUMMARY_PATH, assessmentByIdQuery, dossierItem, itemRead, publicationItem, stateFields, stateScript } from "./state-script.js";

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
    expect(refusalOf(result)).toMatchObject({
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
    expect(refusalOf(result)).toMatchObject({ refused: true, stage: "LIFECYCLE", evidence: [{ source: "drive", target: DOSSIER_PATH, found: "not found" }] });
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses to move a completed assessment to provisional", async () => {
    const { graph, calls } = createScriptedGraph(stateScript({ fields: COMPLETED, dossier: dossierItem('"d1"', 120) }));

    const result = await runTransitionAssessment({ ...INPUT, target: "provisional" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    const refusal = refusalOf(result) as { expected: string; observed: string };
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

  // Measured 2026-11-17 (L4a): Graph answers a fields PATCH under a stale eTag with 412 and writes
  // nothing. Someone changed the item after this call read it, so what the call decided on is gone.
  it("refuses when the item changed after it was read, with the 412 as its evidence and no journal entry", async () => {
    const { graph } = createScriptedGraph([
      ...stateScript({ dossier: dossierItem('"d1"', 120), publication: publicationItem('"p1"', 48213) }),
      { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", throws: { status: 412, code: "resourceModified" } },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runTransitionAssessment(INPUT, context);

    expect(result.isError).toBe(true);
    expect(refusalOf(result)).toMatchObject({
      refused: true,
      tool: "transition_assessment",
      stage: "LIFECYCLE",
      assessmentId: ID,
      expected: "Assessments item 2 unchanged since this call read it",
      observed: 'the item changed: Graph answered 412 to If-Match "item-2,1"',
      evidence: [{ source: "list", target: "Assessments item 2", found: 'changed since it was read with eTag "item-2,1"' }],
    });
    expect(resultText(result)).toContain("Nothing was written.");
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("refuses an item read without an eTag, since the update could carry no precondition", async () => {
    const bare = { ...listItem("2", stateFields()), eTag: undefined, "@odata.etag": undefined };
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      assessmentByIdQuery([bare]),
      itemRead(ROOT, folderItem(ID)),
      itemRead(DOSSIER_PATH, dossierItem('"d1"', 120)),
      itemRead(SUMMARY_PATH, undefined),
      itemRead(PUBLICATION_PATH, publicationItem('"p1"', 48213)),
    ]);

    const result = await runTransitionAssessment(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe("Assessments item 2 was read without an ETag, so no If-Match precondition could be sent. Nothing was written.");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses to complete a provisional assessment whose publication is absent, naming the publication and not the status", async () => {
    const { graph, calls } = createScriptedGraph(
      stateScript({ fields: { Status: "Provisional", Disposition: "Approved with conditions", Risk: "Medium", State: "LIFECYCLE" }, dossier: dossierItem('"d1"', 120) }),
    );

    const result = await runTransitionAssessment(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(refusalOf(result)).toMatchObject({ refused: true, evidence: [{ source: "drive", target: PUBLICATION_PATH, found: "not found" }] });
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses to complete a completed assessment under other labels, naming both statuses it would have accepted", async () => {
    const { graph } = createScriptedGraph(stateScript({ fields: COMPLETED, dossier: dossierItem('"d1"', 120), publication: publicationItem('"p1"', 48213) }));

    const result = await runTransitionAssessment({ ...INPUT, disposition: "Rejected" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(refusalOf(result)).toMatchObject({ expected: 'status "In Progress" or "Provisional"', observed: 'status "Completed"' });
  });

  it("still refuses to relabel a provisional assessment as provisional: only completion leaves that status", async () => {
    const { graph, calls } = createScriptedGraph(
      stateScript({ fields: { Status: "Provisional", Disposition: "Approved with conditions", Risk: "Medium", State: "LIFECYCLE" }, dossier: dossierItem('"d1"', 120) }),
    );

    const result = await runTransitionAssessment({ ...INPUT, target: "provisional", disposition: "Rejected", risk: "High" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(refusalOf(result)).toMatchObject({ expected: 'status "In Progress"', observed: 'status "Provisional"' });
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses an assessment id no item carries with the structured refusal, not a failure blaming the profile", async () => {
    const { graph, calls } = createScriptedGraph([...RESOLVE_DRIVE_SCRIPT, assessmentByIdQuery([])]);

    const result = await runTransitionAssessment(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(refusalOf(result)).toMatchObject({ refused: true, tool: "transition_assessment", stage: "LIFECYCLE", assessmentId: ID, observed: "no item matched" });
    expect(resultText(result)).not.toContain("artifact kind");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });
});
