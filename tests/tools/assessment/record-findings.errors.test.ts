import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECORD_INPUT_CONSTRAINTS, runRecordFindings } from "../../../src/tools/assessment/record-findings.js";
import { RESOLVE_DRIVE_SCRIPT, assessmentToolContext, createScriptedGraph, fileItem, folderItem, listItem, refusalOf, resultText } from "./fake-graph.js";
import { DOSSIER_PATH, ID, PROFILE, PUBLICATION_PATH, ROOT, SUMMARY_PATH, assessmentByIdQuery, dossierItem, findingFields, findingsQuery, itemRead, stateFields, stateScript } from "./state-script.js";

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
    expect(refusalOf(result)).toMatchObject({ refused: true, tool: "record_findings", stage: "FINDINGS", assessmentId: ID });
    expect((refusalOf(result) as { observed: string }).observed).toContain("Completed");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses when the dossier is absent, naming the dossier path", async () => {
    const { graph, calls } = createScriptedGraph(stateScript());

    const result = await runRecordFindings(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(refusalOf(result)).toMatchObject({ refused: true, stage: "FINDINGS", evidence: [{ source: "drive", target: DOSSIER_PATH, found: "not found" }] });
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

  it("reports an updated finding whose answer disagrees with what was sent, keeps its journal entry and writes nothing after it", async () => {
    const { graph, calls } = createScriptedGraph([
      ...WITH_DOSSIER,
      // F-1 exists with an older risk, so the call updates it; Graph answers the PATCH with Medium.
      findingsQuery([listItem("11", findingFields("F-1", F1.observation, "Low", F1.recommendation), '"finding-11,1"')]),
      { method: "patch", pathIncludes: "/lists/Findings/items/11/fields", response: findingFields("F-1", F1.observation, "Medium", F1.recommendation) },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Graph accepted the write to Findings item 11 for finding "F-1", but its answer disagrees with what was sent: Risk read "Medium", not "High".');
    expect(resultText(result)).toContain("The journal records the write; nothing after it was written.");
    expect(calls.filter((call) => call.method === "patch").map((call) => call.path)).toHaveLength(1);
    expect(calls.filter((call) => call.method === "post")).toEqual([]);
    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal.map((entry) => [entry.operation, entry.target, entry.etagBefore])).toEqual([["list_item_updated", "Findings/11", '"finding-11,1"']]);
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

  // Measured 2026-11-17 (L4a): Graph answers a fields PATCH under a stale eTag with 412 and writes
  // nothing. Ruled the same day: the tool says so and stops, and does not read again and retry.
  it("says nothing was written when the first finding it would update changed after it was read", async () => {
    const { graph, calls } = createScriptedGraph([
      ...WITH_DOSSIER,
      findingsQuery([listItem("11", findingFields("F-1", "An older observation.", F1.risk, F1.recommendation))]),
      { method: "patch", pathIncludes: "/lists/Findings/items/11/fields", throws: { status: 412, code: "resourceModified" } },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      'Finding "F-1" on Findings item 11 was not updated: Findings item 11 changed after this call read it: Graph answered 412 to If-Match "item-11,1". Nothing was written.',
    );
    expect(calls.filter((call) => call.method === "post")).toEqual([]);
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("says what it had already written when a later finding changed after it was read, and writes nothing after it", async () => {
    const { graph, calls } = createScriptedGraph([
      ...WITH_DOSSIER,
      findingsQuery([listItem("12", findingFields("F-2", "An older observation.", F2.risk, F2.recommendation))]),
      { method: "post", pathIncludes: "/lists/Findings/items", response: listItem("11", findingFields(F1.key, F1.observation, F1.risk, F1.recommendation)) },
      { method: "patch", pathIncludes: "/lists/Findings/items/12/fields", throws: { status: 412, code: "resourceModified" } },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      'Finding "F-2" on Findings item 12 was not updated: Findings item 12 changed after this call read it: Graph answered 412 to If-Match "item-12,1". ' +
        "Before it this call wrote 1 created, 0 updated; the journal records them. Nothing after it was written.",
    );
    expect(calls.filter((call) => call.path.includes("/lists/Assessments/items/2/fields"))).toEqual([]);
    expect((await context.store.listJournal(PROFILE, ID)).map((entry) => entry.operation)).toEqual(["list_item_created"]);
  });

  it("reports the findings recorded and the summary refused when the assessment item changed after it was read", async () => {
    const { graph } = createScriptedGraph([
      ...WITH_DOSSIER,
      findingsQuery([]),
      { method: "post", pathIncludes: "/lists/Findings/items", response: listItem("11", findingFields(F1.key, F1.observation, F1.risk, F1.recommendation)) },
      { method: "post", pathIncludes: "/lists/Findings/items", response: listItem("12", findingFields(F2.key, F2.observation, F2.risk, F2.recommendation)) },
      { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", throws: { status: 412, code: "resourceModified" } },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      "Findings recorded (2 created, 0 updated, 0 unchanged), but the summary and stage FINDINGS were not recorded: " +
        'Assessments item 2 changed after this call read it: Graph answered 412 to If-Match "item-2,1". The journal records what was written.',
    );
    expect((await context.store.listJournal(PROFILE, ID)).map((entry) => entry.target)).toEqual(["Findings/11", "Findings/12"]);
  });

  it("does not say findings were recorded when none needed writing and the summary was refused", async () => {
    const { graph } = createScriptedGraph([
      ...WITH_DOSSIER,
      findingsQuery([
        listItem("11", findingFields(F1.key, F1.observation, F1.risk, F1.recommendation)),
        listItem("12", findingFields(F2.key, F2.observation, F2.risk, F2.recommendation)),
      ]),
      { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", throws: { status: 412, code: "resourceModified" } },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      "No finding needed writing (0 created, 0 updated, 2 unchanged), and the summary and stage FINDINGS were not recorded: " +
        'Assessments item 2 changed after this call read it: Graph answered 412 to If-Match "item-2,1". Nothing was written.',
    );
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("refuses before any write when the assessment item was read without an eTag and its summary needs writing", async () => {
    const bare = { ...listItem("2", stateFields()), eTag: undefined, "@odata.etag": undefined };
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      assessmentByIdQuery([bare]),
      itemRead(ROOT, folderItem(ID)),
      itemRead(DOSSIER_PATH, dossierItem('"d1"', 120)),
      itemRead(SUMMARY_PATH, undefined),
      itemRead(PUBLICATION_PATH, undefined),
      findingsQuery([]),
    ]);

    const result = await runRecordFindings(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe("Assessments item 2 was read without an ETag, so no If-Match precondition could be sent. Nothing was written.");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses before any write when a finding it would update was read without an eTag", async () => {
    const bare = { ...listItem("12", findingFields("F-2", "An older observation.", F2.risk, F2.recommendation)), eTag: undefined, "@odata.etag": undefined };
    const { graph, calls } = createScriptedGraph([...WITH_DOSSIER, findingsQuery([bare])]);

    const result = await runRecordFindings(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe("Findings item 12 was read without an ETag, so no If-Match precondition could be sent. Nothing was written.");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses an assessment id no item carries with the structured refusal, not a failure blaming the profile", async () => {
    const { graph, calls } = createScriptedGraph([...RESOLVE_DRIVE_SCRIPT, assessmentByIdQuery([])]);
    const context = assessmentToolContext(graph);

    const result = await runRecordFindings(INPUT, context);

    expect(result.isError).toBe(true);
    expect(refusalOf(result)).toMatchObject({ refused: true, tool: "record_findings", stage: "FINDINGS", assessmentId: ID, observed: "no item matched" });
    expect(resultText(result)).not.toContain("artifact kind");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("says a file under another name holds the dossier's path, rather than reporting the path not found", async () => {
    const { graph, calls } = createScriptedGraph(stateScript({ dossier: fileItem("acme corp_research_dossier.md", '"d1"', 120) }));

    const result = await runRecordFindings(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(refusalOf(result)).toMatchObject({
      refused: true,
      evidence: [{ source: "drive", target: DOSSIER_PATH, found: 'a file named "acme corp_research_dossier.md"' }],
    });
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });
});
