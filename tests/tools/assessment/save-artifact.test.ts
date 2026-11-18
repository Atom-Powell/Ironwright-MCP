import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProfileRegistry } from "../../../src/profiles/registry.js";
import { runSaveAssessmentArtifact } from "../../../src/tools/assessment/save-artifact.js";
import { sha256Hex } from "../../../src/tools/assessment/hash.js";
import type { GraphClient } from "../../../src/graph/client.js";
import type { ToolContext } from "../../../src/tools/context.js";
import { createFakeToolContext } from "../fake-context.js";
import { RESOLVE_DRIVE_SCRIPT, SITE_URL, assessmentToolContext, createScriptedGraph, fileItem, folderItem, listItem, resultText, type ScriptEntry } from "./fake-graph.js";
import { DOSSIER_PATH, ID, NOT_FOUND, PROFILE, PUBLICATION_PATH, ROOT, SUMMARY_PATH, assessmentByIdQuery, contentRead, dossierItem, itemRead, stateFields, stateScript } from "./state-script.js";

const CONTENT = "# Acme Corp research dossier\n\nFindings follow.\n";
const BYTES = new TextEncoder().encode(CONTENT);

function fieldsPatch(state: string): ScriptEntry {
  return { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", response: { "@odata.etag": '"item-2,2"', ...stateFields(), State: state } };
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

  it("reports identical content on a present dossier as unchanged, writing nothing when State already reads DOSSIER", async () => {
    const { graph, calls } = createScriptedGraph([
      ...stateScript({ fields: { State: "DOSSIER" }, dossier: dossierItem('"e1"', BYTES.byteLength) }),
      contentRead(DOSSIER_PATH, BYTES),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: ID, kind: "dossier", content: CONTENT }, context);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      operation: "unchanged",
      stage: "DOSSIER",
      path: DOSSIER_PATH,
      bytes: BYTES.byteLength,
      sha256: sha256Hex(BYTES),
      eTag: '"e1"',
      graphRequests: graph.requests(),
    });
    expect(resultText(result)).toContain("already read DOSSIER. Nothing was written.");
    expect(calls.filter((call) => call.method === "putBytes" || call.method === "patch")).toEqual([]);
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  // Ruled 2026-11-17: a save that writes no file records no stage. It used to set State to the
  // kind's own stage whenever State read anything else, so a harmless retry of the dossier erased
  // the CORRECTION that said it had been corrected, and moved FINDINGS back to DOSSIER.
  it.each(["CORRECTION", "FINDINGS", "ID"])("reports identical content as unchanged and leaves State reading %s", async (held) => {
    const { graph, calls } = createScriptedGraph([
      ...stateScript({ fields: { State: held }, dossier: dossierItem('"e1"', BYTES.byteLength) }),
      contentRead(DOSSIER_PATH, BYTES),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: ID, kind: "dossier", content: CONTENT }, context);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ operation: "unchanged", stage: "DOSSIER", sha256: sha256Hex(BYTES) });
    expect(resultText(result)).toContain(`State on Assessments item 2 reads "${held}" and was left as it is: a save that writes no file records no stage. Nothing was written.`);
    expect(calls.filter((call) => call.method === "putBytes" || call.method === "patch")).toEqual([]);
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("sends the State update under the eTag the item was read with, and journals the eTag it answered", async () => {
    const { graph, calls } = createScriptedGraph([...stateScript(), ...createScript(DOSSIER_PATH, "Acme Corp_Research_Dossier.md", BYTES, "DOSSIER")]);
    const context = assessmentToolContext(graph);

    await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: ID, kind: "dossier", content: CONTENT }, context);

    expect(calls.find((call) => call.method === "patch")!.headers).toEqual({ "if-match": '"item-2,1"' });
    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal[1]).toMatchObject({ operation: "list_item_updated", etagBefore: '"item-2,1"', etagAfter: '"item-2,2"' });
  });

  // Measured 2026-11-09 (campaign s1): a content PUT under a folder that is gone recreates the
  // folder and says nothing about it. Ruled 2026-11-17: the save stands, and the journal says so.
  // The folder is created by its own request, not left to the content PUT to bring back, so
  // the journal entry rests on a 201 this call received and not on an absence and a presence
  // someone else could have produced in between.
  it("creates a missing folder above the file itself, journals it before the file, and says so", async () => {
    const { graph, calls } = createScriptedGraph([
      ...stateScript({ publishedPresent: false }),
      { method: "post", pathIncludes: `/drives/drive-1/root:/${ROOT}:/children`, response: folderItem("Published", '"f9"') },
      ...createScript(SUMMARY_PATH, `${ID}_Executive_Summary.md`, BYTES, "EXECUTIVE_SUMMARY"),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: ID, kind: "executive_summary", content: CONTENT }, context);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ operation: "created", foldersCreated: [`${ROOT}/Published`], graphRequests: graph.requests() });
    expect(resultText(result)).toContain(`The folder ${ROOT}/Published was not there, so this call created it before writing the file; the journal records it.`);
    expect(calls.find((call) => call.method === "post")!.body).toEqual({ name: "Published", folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
    const journal = await context.store.listJournal(PROFILE, ID);
    expect(journal.map((entry) => [entry.operation, entry.target])).toEqual([
      ["folder_created", `${ROOT}/Published`],
      ["file_created", SUMMARY_PATH],
      ["list_item_updated", "Assessments/2"],
    ]);
    expect(journal[0]).toMatchObject({ stage: "EXECUTIVE_SUMMARY", etagAfter: '"f9"' });
  });

  it("journals no folder when someone else put it back between the look and the create", async () => {
    const { graph } = createScriptedGraph([
      ...stateScript({ publishedPresent: false }),
      { method: "post", pathIncludes: `/drives/drive-1/root:/${ROOT}:/children`, throws: { status: 409, code: "nameAlreadyExists" } },
      ...createScript(SUMMARY_PATH, `${ID}_Executive_Summary.md`, BYTES, "EXECUTIVE_SUMMARY"),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: ID, kind: "executive_summary", content: CONTENT }, context);

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as Record<string, unknown>).foldersCreated).toBeUndefined();
    expect(resultText(result)).not.toContain("was not there");
    expect((await context.store.listJournal(PROFILE, ID)).map((entry) => entry.operation)).toEqual(["file_created", "list_item_updated"]);
  });

  it("reports unchanged for an item read without an eTag, since nothing is written that would need one", async () => {
    const bare = { ...listItem("2", stateFields({ State: "DOSSIER" })), eTag: undefined, "@odata.etag": undefined };
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      assessmentByIdQuery([bare]),
      itemRead(ROOT, folderItem(ID)),
      itemRead(DOSSIER_PATH, dossierItem('"e1"', BYTES.byteLength)),
      itemRead(SUMMARY_PATH, undefined),
      itemRead(PUBLICATION_PATH, undefined),
      contentRead(DOSSIER_PATH, BYTES),
    ]);

    const result = await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: ID, kind: "dossier", content: CONTENT }, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ operation: "unchanged" });
    expect(calls.filter((call) => call.method === "putBytes" || call.method === "patch")).toEqual([]);
  });

  it("names no folder when the folders above the file were there", async () => {
    const { graph } = createScriptedGraph([...stateScript(), ...createScript(SUMMARY_PATH, `${ID}_Executive_Summary.md`, BYTES, "EXECUTIVE_SUMMARY")]);

    const result = await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: ID, kind: "executive_summary", content: CONTENT }, assessmentToolContext(graph));

    expect((result.structuredContent as Record<string, unknown>).foldersCreated).toBeUndefined();
    expect(resultText(result)).not.toContain("was not there");
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

  it("journals and reports under the stored assessment id when the caller's spelling differs by case", async () => {
    const typed = ID.toLowerCase();
    const { graph } = createScriptedGraph([...stateScript({ typedId: typed }), ...createScript(DOSSIER_PATH, "Acme Corp_Research_Dossier.md", BYTES, "DOSSIER")]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact({ profileId: PROFILE, assessmentId: typed, kind: "dossier", content: CONTENT }, context);

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as Record<string, unknown>).assessmentId).toBe(ID);
    expect((await context.store.listJournal(PROFILE, ID)).map((entry) => entry.operation)).toEqual(["file_created", "list_item_updated"]);
    expect(await context.store.listJournal(PROFILE, typed)).toEqual([]);
  });
});
