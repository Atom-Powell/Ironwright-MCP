import { describe, expect, it } from "vitest";
import { runRecordFindings } from "../../../src/tools/assessment/record-findings.js";
import { assessmentToolContext, createScriptedGraph, listItem, resultText, type ScriptEntry } from "./fake-graph.js";
import { ID, PROFILE, dossierItem, findingFields, findingsQuery, stateFields, stateScript } from "./state-script.js";

const SUMMARY = "Two findings, one high.";
const F1 = { key: "F-1", observation: "SOC 2 Type II report covers only the hosting subsidiary.", risk: "High", recommendation: "Request the parent company report." };
const F2 = { key: "F-2", observation: "No penetration test in the last year.", risk: "Medium", recommendation: "Request a current penetration test summary." };
const INPUT = { profileId: PROFILE, assessmentId: ID, findings: [F1, F2], summary: SUMMARY };

const WITH_DOSSIER = stateScript({ dossier: dossierItem('"d1"', 120) });

function rowOf(finding: typeof F1): Record<string, unknown> {
  return findingFields(finding.key, finding.observation, finding.risk, finding.recommendation);
}

function summaryPatch(): ScriptEntry {
  return { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", response: { ...stateFields(), Summary: SUMMARY, State: "FINDINGS" } };
}

describe("record_findings", () => {
  it("creates each finding and records the summary and the FINDINGS stage", async () => {
    const { graph, calls } = createScriptedGraph([
      ...WITH_DOSSIER,
      findingsQuery([]),
      { method: "post", pathIncludes: "/lists/Findings/items", response: listItem("11", rowOf(F1)) },
      { method: "post", pathIncludes: "/lists/Findings/items", response: listItem("12", rowOf(F2)) },
      summaryPatch(),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as Record<string, unknown>;
    expect(output).toMatchObject({ assessmentId: ID, created: 2, updated: 0, unchanged: 0, graphRequests: graph.requests() });
    expect(output.findings).toEqual([
      { key: "F-1", itemId: "11", outcome: "created" },
      { key: "F-2", itemId: "12", outcome: "created" },
    ]);
    expect(calls.filter((call) => call.method === "post").map((call) => call.body)).toEqual([{ fields: rowOf(F1) }, { fields: rowOf(F2) }]);
    expect(calls.filter((call) => call.method === "patch").map((call) => call.body)).toEqual([{ Summary: SUMMARY, State: "FINDINGS" }]);
    expect(resultText(result)).toContain("2 created, 0 updated, 0 unchanged");
    expect(resultText(result)).toContain("The summary and stage FINDINGS were recorded on Assessments item 2, and Graph's answer matched what was sent.");

    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal.map((entry) => [entry.operation, entry.target, entry.stage])).toEqual([
      ["list_item_created", "Findings/11", "FINDINGS"],
      ["list_item_created", "Findings/12", "FINDINGS"],
      ["list_item_updated", "Assessments/2", "FINDINGS"],
    ]);
    expect(journal[2]!.etagBefore).toBe('"item-2,1"');
    expect(journal.every((entry) => entry.correlationId === output.correlationId)).toBe(true);
  });

  it("on a retry updates a changed finding and leaves an identical one unchanged", async () => {
    const { graph, calls } = createScriptedGraph([
      ...WITH_DOSSIER,
      findingsQuery([listItem("11", rowOf(F1)), listItem("12", rowOf({ ...F2, observation: "An older observation." }))]),
      { method: "patch", pathIncludes: "/lists/Findings/items/12/fields", response: rowOf(F2) },
      summaryPatch(),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      created: 0,
      updated: 1,
      unchanged: 1,
      findings: [
        { key: "F-1", itemId: "11", outcome: "unchanged" },
        { key: "F-2", itemId: "12", outcome: "updated" },
      ],
    });
    expect(calls.filter((call) => call.method === "post")).toEqual([]);
    const findingPatches = calls.filter((call) => call.method === "patch" && call.path.includes("/lists/Findings/"));
    expect(findingPatches.map((call) => call.path)).toEqual([expect.stringContaining("/lists/Findings/items/12/fields")]);
    expect(findingPatches[0]!.body).toEqual({ Observation: F2.observation, Risk: F2.risk, Recommendation: F2.recommendation });

    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal.map((entry) => [entry.operation, entry.target])).toEqual([
      ["list_item_updated", "Findings/12"],
      ["list_item_updated", "Assessments/2"],
    ]);
    expect(journal[0]!.etagBefore).toBe('"item-12,1"');
  });

  it("updates a changed finding without rewriting a summary and stage the item already holds", async () => {
    const { graph, calls } = createScriptedGraph([
      ...stateScript({ fields: { Summary: SUMMARY, State: "FINDINGS" }, dossier: dossierItem('"d1"', 120) }),
      findingsQuery([listItem("11", rowOf(F1)), listItem("12", rowOf({ ...F2, risk: "Low" }))]),
      { method: "patch", pathIncludes: "/lists/Findings/items/12/fields", response: rowOf(F2) },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    expect(resultText(result)).toContain("Each finding written was answered with the values sent.");
    expect(resultText(result)).toContain("Assessments item 2 already held this summary and stage FINDINGS, so it was not written.");
    expect(calls.filter((call) => call.method === "patch").map((call) => call.path)).toEqual([expect.stringContaining("/lists/Findings/items/12/fields")]);
    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal.map((entry) => [entry.operation, entry.target])).toEqual([["list_item_updated", "Findings/12"]]);
  });

  it("writes nothing when every finding, the summary and the stage already hold what was sent", async () => {
    const { graph, calls } = createScriptedGraph([
      ...stateScript({ fields: { Summary: SUMMARY, State: "FINDINGS" }, dossier: dossierItem('"d1"', 120) }),
      findingsQuery([listItem("11", rowOf(F1)), listItem("12", rowOf(F2))]),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(resultText(result)).toContain("Every finding already held the values sent, and Assessments item 2 already held this summary and stage FINDINGS. Nothing was written.");
    expect(resultText(result)).not.toContain("Each finding written");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });
});
