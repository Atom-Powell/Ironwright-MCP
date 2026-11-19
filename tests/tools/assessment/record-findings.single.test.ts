import { describe, expect, it } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { RECORD_INPUT_CONSTRAINTS, RECORD_INPUT_SCHEMA, runRecordFindings } from "../../../src/tools/assessment/record-findings.js";
import { assessmentToolContext, createScriptedGraph, listItem, resultText, type ScriptEntry } from "./fake-graph.js";
import { ID, PROFILE, dossierItem, findingFields, findingsQuery, stateFields, stateScript } from "./state-script.js";

// Copilot Studio could not fill a list of records: on 2026-11-18 it asked the user for the key
// again after being given it, then failed before sending anything. One finding as plain fields
// is the shape it fills, so that form is accepted beside the list.
const SUMMARY = "One finding, high.";
const FLAT = { findingKey: "F-1", findingObservation: "Invoices were forwarded to an external address for six days.", findingRisk: "High", findingRecommendation: "Block external auto-forwarding." };
const WITH_DOSSIER = stateScript({ dossier: dossierItem('"d1"', 120) });

function summaryPatch(): ScriptEntry {
  return { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", response: { ...stateFields(), Summary: SUMMARY, State: "FINDINGS" } };
}

describe("record_findings with one finding as plain fields", () => {
  it("records it exactly as the list form records a one-item list", async () => {
    const row = findingFields(FLAT.findingKey, FLAT.findingObservation, FLAT.findingRisk, FLAT.findingRecommendation);
    const { graph, calls } = createScriptedGraph([
      ...WITH_DOSSIER,
      findingsQuery([]),
      { method: "post", pathIncludes: "/lists/Findings/items", response: listItem("11", row) },
      summaryPatch(),
    ]);

    const result = await runRecordFindings({ profileId: PROFILE, assessmentId: ID, ...FLAT, summary: SUMMARY }, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ created: 1, updated: 0, unchanged: 0, findings: [{ key: "F-1", itemId: "11", outcome: "created" }] });
    expect(calls.filter((call) => call.method === "post").map((call) => call.body)).toEqual([{ fields: row }]);
    expect(resultText(result)).toContain("1 created, 0 updated, 0 unchanged");
  });

  it("refuses both forms in one call before any Graph request", async () => {
    const { graph } = createScriptedGraph([]);
    const both = { profileId: PROFILE, assessmentId: ID, ...FLAT, findings: [{ key: "F-2", observation: "x", risk: "Low", recommendation: "y" }], summary: SUMMARY };

    const result = await runRecordFindings(both, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(RECORD_INPUT_CONSTRAINTS);
    expect(resultText(result)).toContain("The findings list and findingKey, findingObservation, findingRisk and findingRecommendation were both given.");
    expect(graph.requests()).toBe(0);
  });

  it("refuses a call with no finding at all before any Graph request", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runRecordFindings({ profileId: PROFILE, assessmentId: ID, summary: SUMMARY }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(RECORD_INPUT_CONSTRAINTS);
    expect(resultText(result)).toContain("Neither was given.");
    expect(graph.requests()).toBe(0);
  });

  it("names the plain fields that are missing when only some are given", async () => {
    const { graph } = createScriptedGraph([]);
    const partial = { profileId: PROFILE, assessmentId: ID, findingKey: "F-1", findingObservation: FLAT.findingObservation, summary: SUMMARY };

    const result = await runRecordFindings(partial, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("findingRisk and findingRecommendation are missing");
    expect(graph.requests()).toBe(0);
  });

  it("refuses a plain finding's risk the profile does not name, as the list form does", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runRecordFindings({ profileId: PROFILE, assessmentId: ID, ...FLAT, findingRisk: "Severe", summary: SUMMARY }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('"Severe"');
    expect(graph.requests()).toBe(0);
  });

  // An agent that also calls transition_assessment may carry its top-level risk over by habit.
  // The words name the stray field, so the agent knows which one to drop.
  it("names a stray plain field sent beside the list", async () => {
    const { graph } = createScriptedGraph([]);
    const stray = { profileId: PROFILE, assessmentId: ID, findings: [{ key: "F-2", observation: "x", risk: "Low", recommendation: "y" }], findingRisk: "High", summary: SUMMARY };

    const result = await runRecordFindings(stray, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("The findings list and findingRisk were both given.");
    expect(graph.requests()).toBe(0);
  });

  it("refuses a profile of another kind before looking at the findings' shape", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runRecordFindings({ profileId: "example", assessmentId: ID, findingKey: "F-1", summary: SUMMARY }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("assessment profile");
    expect(resultText(result)).not.toContain("are missing");
    expect(graph.requests()).toBe(0);
  });

  it("on a retry with the same plain key leaves an identical finding unchanged", async () => {
    const row = findingFields(FLAT.findingKey, FLAT.findingObservation, FLAT.findingRisk, FLAT.findingRecommendation);
    const held = { ...stateFields(), Summary: SUMMARY, State: "FINDINGS" };
    const { graph, calls } = createScriptedGraph([...stateScript({ dossier: dossierItem('"d1"', 120), fields: held }), findingsQuery([listItem("11", row)])]);

    const result = await runRecordFindings({ profileId: PROFILE, assessmentId: ID, ...FLAT, summary: SUMMARY }, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ created: 0, updated: 0, unchanged: 1, findings: [{ key: "F-1", itemId: "11", outcome: "unchanged" }] });
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  // A connector that fills an unused list as [] is refused by the schema before the handler runs.
  // Pinned so the behavior is known, not assumed: the words are the schema's, not the tool's.
  it("refuses an empty findings list at the schema, even beside plain fields", async () => {
    const { graph } = createScriptedGraph([]);

    await expect(runRecordFindings({ profileId: PROFILE, assessmentId: ID, ...FLAT, findings: [], summary: SUMMARY }, assessmentToolContext(graph))).rejects.toThrow();
    expect(graph.requests()).toBe(0);
  });

  // What a client sees: four plain string fields at the top level, none of them required, and the
  // list no longer required either, since a call carries one form or the other.
  it("advertises the plain fields as top-level strings and requires neither form", () => {
    const schema = zodToJsonSchema(z.object(RECORD_INPUT_SCHEMA)) as { properties: Record<string, { type?: string }>; required: string[] };

    for (const field of ["findingKey", "findingObservation", "findingRisk", "findingRecommendation"]) expect(schema.properties[field]?.type).toBe("string");
    expect(schema.required.sort()).toEqual(["assessmentId", "profileId", "summary"]);
  });
});
