import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSaveAssessmentArtifact } from "../../../src/tools/assessment/save-artifact.js";
import { sha256Hex } from "../../../src/tools/assessment/hash.js";
import { MAX_SMALL_UPLOAD_BYTES } from "../../../src/graph/items.js";
import { RESOLVE_DRIVE_SCRIPT, assessmentToolContext, createScriptedGraph, fileItem, resultText } from "./fake-graph.js";
import { DOSSIER_PATH, ID, PROFILE, ROOT, assessmentByIdQuery, contentRead, dossierItem, itemRead, stateScript } from "./state-script.js";

const CONTENT = "# Acme Corp research dossier\n";
const BYTES = new TextEncoder().encode(CONTENT);
const INPUT = { profileId: PROFILE, assessmentId: ID, kind: "dossier", content: CONTENT };

describe("save_assessment_artifact failures", () => {
  // The handler logs an unexpected failure before describing it; silenced so the run's output stays clean.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses content over the small upload cap before any Graph request", async () => {
    const { graph } = createScriptedGraph([]);
    const content = "a".repeat(MAX_SMALL_UPLOAD_BYTES + 1);
    expect(new TextEncoder().encode(content).byteLength).toBe(4194305);

    const result = await runSaveAssessmentArtifact({ ...INPUT, content }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(`capped at ${MAX_SMALL_UPLOAD_BYTES} bytes`);
    expect(graph.requests()).toBe(0);
  });

  it("refuses kind publication before any Graph request", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runSaveAssessmentArtifact({ ...INPUT, kind: "publication" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("The publication is written by the consumer's publisher at its canonical path; verify_publication checks it.");
    expect(graph.requests()).toBe(0);
  });

  it("refuses a kind the profile does not name before any Graph request, listing the kinds it does", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runSaveAssessmentArtifact({ ...INPUT, kind: "appendix" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('"appendix"');
    expect(resultText(result)).toContain("dossier, executive_summary, publication");
    expect(graph.requests()).toBe(0);
  });

  it("refuses an assessment id no item carries", async () => {
    const { graph } = createScriptedGraph([...RESOLVE_DRIVE_SCRIPT, assessmentByIdQuery([])]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact(INPUT, context);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ refused: true, tool: "save_assessment_artifact", stage: "DOSSIER", assessmentId: ID });
    expect((result.structuredContent as { expected: string }).expected).toContain("assessment item");
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("refuses an assessment that is not in progress", async () => {
    const { graph, calls } = createScriptedGraph(stateScript({ fields: { Status: "Completed" } }));

    const result = await runSaveAssessmentArtifact(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ refused: true, stage: "DOSSIER" });
    expect((result.structuredContent as { observed: string }).observed).toContain("Completed");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses when the workspace root is absent, naming the root path", async () => {
    const { graph, calls } = createScriptedGraph(stateScript({ rootPresent: false }));

    const result = await runSaveAssessmentArtifact(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ refused: true, evidence: [{ source: "drive", target: ROOT, found: "not found" }] });
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("reports a create answered 409 as a file that appeared between the read and the write, with no journal entry", async () => {
    const { graph } = createScriptedGraph([
      ...stateScript(),
      { method: "putBytes", pathIncludes: `${DOSSIER_PATH}:/content?@microsoft.graph.conflictBehavior=fail`, throws: { status: 409, code: "nameAlreadyExists" } },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("appeared between the read and the write");
    expect(resultText(result)).toContain("call again");
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("reports an overwrite answered 412 as a file that changed between the read and the write, with no journal entry", async () => {
    const { graph } = createScriptedGraph([
      ...stateScript({ dossier: dossierItem('"e1"', 11) }),
      contentRead(DOSSIER_PATH, new TextEncoder().encode("# probe v1\n")),
      { method: "putBytes", pathIncludes: `${DOSSIER_PATH}:/content`, headersInclude: { "if-match": '"e1"' }, throws: { status: 412, code: "notAllowed" } },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("changed between the read and the write");
    expect(resultText(result)).toContain("nothing was replaced");
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("reports a read back whose hash differs, keeps the journal entry for the write, and does not advance the state", async () => {
    const other = new TextEncoder().encode("# something else\n");
    const { graph, calls } = createScriptedGraph([
      ...stateScript(),
      { method: "putBytes", pathIncludes: `${DOSSIER_PATH}:/content?@microsoft.graph.conflictBehavior=fail`, response: dossierItem('"e1"', BYTES.byteLength) },
      itemRead(DOSSIER_PATH, fileItem("Acme Corp_Research_Dossier.md", '"e1"', other.byteLength)),
      contentRead(DOSSIER_PATH, other),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("read back with a different hash");
    expect(resultText(result)).toContain(sha256Hex(other));
    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal.map((entry) => entry.operation)).toEqual(["file_created"]);
    expect(journal[0]!.contentHash).toBe(sha256Hex(BYTES));
    expect(calls.filter((call) => call.method === "patch")).toEqual([]);
  });
});
