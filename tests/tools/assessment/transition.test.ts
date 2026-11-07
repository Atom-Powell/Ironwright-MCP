import { describe, expect, it } from "vitest";
import { runTransitionAssessment } from "../../../src/tools/assessment/transition.js";
import { assessmentToolContext, createScriptedGraph, fileItem, listItem, resultText, type ScriptEntry } from "./fake-graph.js";
import { ID, PROFILE, dossierItem, stateFields, stateScript } from "./state-script.js";

const PUBLICATION = fileItem("Acme Corp_ASM-2026-00002_Risk_Assessment.docx", '"p1"', 48213);
const INPUT = { profileId: PROFILE, assessmentId: ID, target: "completed", disposition: "Approved", risk: "Low" };

function patchAndReadBack(values: Record<string, string>): ScriptEntry[] {
  return [
    { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", response: stateFields(values) },
    { method: "get", pathIncludes: "/lists/Assessments/items/2?", response: listItem("2", stateFields(values), '"item-2,2"') },
  ];
}

describe("transition_assessment", () => {
  it("completes an assessment whose dossier and publication are present, reading the item back", async () => {
    const values = { Status: "Completed", Disposition: "Approved", Risk: "Low", State: "LIFECYCLE" };
    const { graph, calls } = createScriptedGraph([
      ...stateScript({ dossier: dossierItem('"d1"', 120), publication: PUBLICATION }),
      ...patchAndReadBack(values),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runTransitionAssessment(INPUT, context);

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as Record<string, unknown>;
    expect(output).toMatchObject({
      assessmentId: ID,
      transitioned: true,
      previousStatus: "In Progress",
      status: "Completed",
      disposition: "Approved",
      risk: "Low",
      graphRequests: graph.requests(),
    });
    expect(calls.filter((call) => call.method === "patch").map((call) => call.body)).toEqual([values]);
    expect(resultText(result)).toContain('from "In Progress" to "Completed"');

    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      operation: "list_item_updated",
      stage: "LIFECYCLE",
      target: "Assessments/2",
      etagBefore: '"item-2,1"',
      etagAfter: '"item-2,2"',
      correlationId: output.correlationId,
    });
  });

  it("marks an assessment provisional with only the dossier present", async () => {
    const values = { Status: "Provisional", Disposition: "Approved with conditions", Risk: "Medium", State: "LIFECYCLE" };
    const { graph, calls } = createScriptedGraph([...stateScript({ dossier: dossierItem('"d1"', 120) }), ...patchAndReadBack(values)]);

    const result = await runTransitionAssessment(
      { ...INPUT, target: "provisional", disposition: "Approved with conditions", risk: "Medium" },
      assessmentToolContext(graph),
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ transitioned: true, status: "Provisional", disposition: "Approved with conditions", risk: "Medium" });
    expect(calls.filter((call) => call.method === "patch").map((call) => call.body)).toEqual([values]);
  });

  it("reports a transition already made without writing", async () => {
    const { graph, calls } = createScriptedGraph(
      stateScript({
        fields: { Status: "Completed", Disposition: "Approved", Risk: "Low", State: "LIFECYCLE" },
        dossier: dossierItem('"d1"', 120),
        publication: PUBLICATION,
      }),
    );
    const context = assessmentToolContext(graph);

    const result = await runTransitionAssessment(INPUT, context);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ transitioned: false, previousStatus: "Completed", status: "Completed", disposition: "Approved", risk: "Low" });
    expect(resultText(result)).toContain("already");
    expect(resultText(result)).toContain("Nothing was written.");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });
});
