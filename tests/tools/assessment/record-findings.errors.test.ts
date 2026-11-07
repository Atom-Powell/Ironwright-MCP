import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECORD_INPUT_CONSTRAINTS, runRecordFindings } from "../../../src/tools/assessment/record-findings.js";
import { assessmentToolContext, createScriptedGraph, listItem, resultText } from "./fake-graph.js";
import { DOSSIER_PATH, ID, PROFILE, dossierItem, findingFields, findingsQuery, stateFields, stateScript } from "./state-script.js";

const F1 = { key: "F-1", observation: "SOC 2 Type II report covers only the hosting subsidiary.", risk: "High", recommendation: "Request the parent company report." };
const F2 = { key: "F-2", observation: "No penetration test in the last year.", risk: "Medium", recommendation: "Request a current penetration test summary." };
const SUMMARY = "Two findings, one high.";
const INPUT = { profileId: PROFILE, assessmentId: ID, findings: [F1, F2], summary: SUMMARY };
const WITH_DOSSIER = stateScript({ dossier: dossierItem('"d1"', 120) });

describe("record_findings failures", () => {
  // The handler logs an unexpected failure before describing it; silenced so the run's output stays clean.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a risk the profile does not name before any Graph request, listing the labels", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runRecordFindings({ ...INPUT, findings: [F1, { ...F2, risk: "Severe" }] }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(RECORD_INPUT_CONSTRAINTS);
    expect(resultText(result)).toContain('"F-2"');
    expect(resultText(result)).toContain('"Severe"');
    expect(resultText(result)).toContain("Low, Medium, High");
    expect(graph.requests()).toBe(0);
  });

  it("refuses two findings sharing a key before any Graph request", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runRecordFindings({ ...INPUT, findings: [F1, { ...F2, key: "F-1" }] }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(RECORD_INPUT_CONSTRAINTS);
    expect(resultText(result)).toContain('"F-1"');
    expect(graph.requests()).toBe(0);
  });

  it("refuses an assessment that is not in progress at the FINDINGS stage", async () => {
    const { graph, calls } = createScriptedGraph(stateScript({ fields: { Status: "Completed" }, dossier: dossierItem('"d1"', 120) }));

    const result = await runRecordFindings(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ refused: true, tool: "record_findings", stage: "FINDINGS", assessmentId: ID });
    expect((result.structuredContent as { observed: string }).observed).toContain("Completed");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses when the dossier is absent, naming the dossier path", async () => {
    const { graph, calls } = createScriptedGraph(stateScript());

    const result = await runRecordFindings(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ refused: true, stage: "FINDINGS", evidence: [{ source: "drive", target: DOSSIER_PATH, found: "not found" }] });
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses when two existing findings share a key, naming the key and the count, and writes nothing", async () => {
    const row = findingFields("F-1", F1.observation, F1.risk, F1.recommendation);
    const { graph, calls } = createScriptedGraph([...WITH_DOSSIER, findingsQuery([listItem("11", row), listItem("14", row)])]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('2 items in list "Findings" carry the finding key "F-1"');
    expect(resultText(result)).toContain("Nothing was written.");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("reports a created finding whose answer disagrees with what was sent, keeps its journal entry and writes nothing after it", async () => {
    const { graph, calls } = createScriptedGraph([
      ...WITH_DOSSIER,
      findingsQuery([]),
      { method: "post", pathIncludes: "/lists/Findings/items", response: listItem("11", findingFields("F-1", F1.observation, "Low", F1.recommendation)) },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Findings item 11 for finding "F-1"');
    expect(resultText(result)).toContain('Risk read "Low", not "High"');
    expect(calls.filter((call) => call.method === "post")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "patch")).toEqual([]);
    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal.map((entry) => [entry.operation, entry.target])).toEqual([["list_item_created", "Findings/11"]]);
  });

  it("reports a summary update whose answer disagrees with what was sent, keeping its journal entry", async () => {
    const { graph } = createScriptedGraph([
      ...WITH_DOSSIER,
      findingsQuery([
        listItem("11", findingFields("F-1", F1.observation, F1.risk, F1.recommendation)),
        listItem("12", findingFields("F-2", F2.observation, F2.risk, F2.recommendation)),
      ]),
      { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", response: { ...stateFields(), Summary: SUMMARY, State: "DOSSIER" } },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Assessments item 2");
    expect(resultText(result)).toContain('State read "DOSSIER", not "FINDINGS"');
    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal.map((entry) => [entry.operation, entry.target])).toEqual([["list_item_updated", "Assessments/2"]]);
  });
});
