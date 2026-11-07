import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProfileRegistry } from "../../../src/profiles/registry.js";
import { runSaveAssessmentArtifact } from "../../../src/tools/assessment/save-artifact.js";
import { sha256Hex } from "../../../src/tools/assessment/hash.js";
import type { GraphClient } from "../../../src/graph/client.js";
import type { ToolContext } from "../../../src/tools/context.js";
import { createFakeToolContext } from "../fake-context.js";
import { SITE_URL, assessmentToolContext, createScriptedGraph, fileItem, type ScriptEntry } from "./fake-graph.js";
import { DOSSIER_PATH, ID, NOT_FOUND, PROFILE, ROOT, SUMMARY_PATH, contentRead, dossierItem, itemRead, stateFields, stateScript } from "./state-script.js";

const CONTENT = "# Acme Corp research dossier\n\nFindings follow.\n";
const BYTES = new TextEncoder().encode(CONTENT);

function fieldsPatch(state: string): ScriptEntry {
  return { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", response: { ...stateFields(), State: state } };
}

/** The create, its read back and the state write, for the file at `path`. */
function createScript(path: string, name: string, bytes: Uint8Array, state: string): ScriptEntry[] {
  return [
    { method: "putBytes", pathIncludes: `/drives/drive-1/root:/${path}:/content?@microsoft.graph.conflictBehavior=fail`, response: fileItem(name, '"e1"', bytes.byteLength) },
    itemRead(path, fileItem(name, '"e1"', bytes.byteLength)),
    contentRead(path, bytes),
    fieldsPatch(state),
  ];
}

describe("save_assessment_artifact", () => {
  it("creates the dossier, reads it back, journals the write and advances the state", async () => {
    const { graph, calls } = createScriptedGraph([...stateScript(), ...createScript(DOSSIER_PATH, "Acme Corp_Research_Dossier.md", BYTES, "DOSSIER")]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: ID, kind: "dossier", content: CONTENT }, context);

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as Record<string, unknown>;
    expect(output).toMatchObject({ assessmentId: ID, kind: "dossier", path: DOSSIER_PATH, operation: "created", stage: "DOSSIER", bytes: BYTES.byteLength, eTag: '"e1"' });
    expect(output.sha256).toBe(sha256Hex(BYTES));
    expect(output.graphRequests).toBe(graph.requests());

    const put = calls.find((call) => call.method === "putBytes")!;
    expect(put.headers).toBeUndefined();
    const patch = calls.find((call) => call.method === "patch")!;
    expect(patch.body).toEqual({ State: "DOSSIER" });

    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal.map((entry) => [entry.operation, entry.stage])).toEqual([
      ["file_created", "DOSSIER"],
      ["list_item_updated", "DOSSIER"],
    ]);
    expect(journal[0]).toMatchObject({ target: DOSSIER_PATH, contentHash: sha256Hex(BYTES), etagAfter: '"e1"', correlationId: output.correlationId });
    expect(journal[0]!.etagBefore).toBeUndefined();
    expect(journal[1]).toMatchObject({ target: "Assessments/2", etagBefore: '"item-2,1"' });
  });

  it("overwrites the dossier under the ETag it read and journals both hashes as a correction", async () => {
    const prior = new TextEncoder().encode("# probe v1\n");
    const { graph, calls } = createScriptedGraph([
      ...stateScript({ dossier: dossierItem('"e1"', prior.byteLength) }),
      contentRead(DOSSIER_PATH, prior),
      { method: "putBytes", pathIncludes: `/drives/drive-1/root:/${DOSSIER_PATH}:/content`, headersInclude: { "if-match": '"e1"' }, response: dossierItem('"e2"', BYTES.byteLength) },
      itemRead(DOSSIER_PATH, dossierItem('"e2"', BYTES.byteLength)),
      contentRead(DOSSIER_PATH, BYTES),
      fieldsPatch("CORRECTION"),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: ID, kind: "dossier", content: CONTENT }, context);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ operation: "overwritten", stage: "CORRECTION", eTag: '"e2"', sha256: sha256Hex(BYTES) });
    const put = calls.find((call) => call.method === "putBytes")!;
    expect(put.path).not.toContain("conflictBehavior");
    expect(calls.find((call) => call.method === "patch")!.body).toEqual({ State: "CORRECTION" });

    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal[0]).toMatchObject({
      operation: "file_overwritten",
      stage: "CORRECTION",
      etagBefore: '"e1"',
      etagAfter: '"e2"',
      contentHash: sha256Hex(BYTES),
      priorContentHash: sha256Hex(prior),
    });
    expect(journal[1]).toMatchObject({ operation: "list_item_updated", stage: "CORRECTION" });
  });

  it("records another kind under its own stage at its own path", async () => {
    const { graph } = createScriptedGraph([...stateScript(), ...createScript(SUMMARY_PATH, `${ID}_Executive_Summary.md`, BYTES, "EXECUTIVE_SUMMARY")]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: ID, kind: "executive_summary", content: CONTENT }, context);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ path: `${ROOT}/Published/ASM-2026-00002_Executive_Summary.md`, operation: "created", stage: "EXECUTIVE_SUMMARY" });
    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal.map((entry) => entry.stage)).toEqual(["EXECUTIVE_SUMMARY", "EXECUTIVE_SUMMARY"]);
  });

  describe("content type", () => {
    /** The example profile plus a kind whose path is not markdown, which no shipped example names. */
    function contextWithNotes(graph: GraphClient): ToolContext {
      const profile = JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8")) as { workspace: { artifacts: Record<string, string> } };
      profile.workspace.artifacts.notes = "Research/{assessmentId}_Notes.txt";
      const profiles = createProfileRegistry([{ source: "assessment-example.json", contents: profile }], SITE_URL);
      return createFakeToolContext({ profiles, graph });
    }

    it("sends a .md path as text/markdown", async () => {
      const { graph, calls } = createScriptedGraph([...stateScript(), ...createScript(DOSSIER_PATH, "Acme Corp_Research_Dossier.md", BYTES, "DOSSIER")]);

      await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: ID, kind: "dossier", content: CONTENT }, assessmentToolContext(graph));

      expect((calls.find((call) => call.method === "putBytes")!.body as { contentType: string }).contentType).toBe("text/markdown");
    });

    it("sends any other path as text/plain", async () => {
      const notesPath = `${ROOT}/Research/${ID}_Notes.txt`;
      const { graph, calls } = createScriptedGraph([
        ...stateScript(),
        { method: "get", pathIncludes: `/drives/drive-1/root:/${notesPath}:?`, throws: NOT_FOUND },
        ...createScript(notesPath, `${ID}_Notes.txt`, BYTES, "NOTES"),
      ]);

      const result = await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: ID, kind: "notes", content: CONTENT }, contextWithNotes(graph));

      expect(result.isError).toBeUndefined();
      expect((calls.find((call) => call.method === "putBytes")!.body as { contentType: string }).contentType).toBe("text/plain");
    });
  });
});
