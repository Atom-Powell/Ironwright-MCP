import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSaveAssessmentArtifact } from "../../../src/tools/assessment/save-artifact.js";
import { sha256Hex } from "../../../src/tools/assessment/hash.js";
import { MAX_SMALL_UPLOAD_BYTES } from "../../../src/graph/items.js";
import { RESOLVE_DRIVE_SCRIPT, assessmentToolContext, createScriptedGraph, fileItem, folderItem, listItem, refusalOf, resultText, type ScriptEntry } from "./fake-graph.js";
import { DOSSIER_PATH, ID, PROFILE, PUBLICATION_PATH, ROOT, SUMMARY_PATH, assessmentByIdQuery, contentRead, dossierItem, itemRead, stateFields, stateScript } from "./state-script.js";

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
    expect(refusalOf(result)).toMatchObject({ refused: true, tool: "save_assessment_artifact", stage: "DOSSIER", assessmentId: ID });
    expect((refusalOf(result) as { expected: string }).expected).toContain("assessment item");
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("refuses an assessment that is not in progress", async () => {
    const { graph, calls } = createScriptedGraph(stateScript({ fields: { Status: "Completed" } }));

    const result = await runSaveAssessmentArtifact(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(refusalOf(result)).toMatchObject({ refused: true, stage: "DOSSIER" });
    expect((refusalOf(result) as { observed: string }).observed).toContain("Completed");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("refuses when the workspace root is absent, naming the root path", async () => {
    const { graph, calls } = createScriptedGraph(stateScript({ rootPresent: false }));

    const result = await runSaveAssessmentArtifact(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(refusalOf(result)).toMatchObject({ refused: true, evidence: [{ source: "drive", target: ROOT, found: "not found" }] });
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
  /** The create of the dossier, answering created with ETag "e1". */
  const CREATE: ScriptEntry = {
    method: "putBytes",
    pathIncludes: `${DOSSIER_PATH}:/content?@microsoft.graph.conflictBehavior=fail`,
    response: dossierItem('"e1"', BYTES.byteLength),
  };

  it("reports a folder at the artifact's path without writing", async () => {
    const { graph, calls } = createScriptedGraph(stateScript({ dossier: folderItem("Acme Corp_Research_Dossier.md") }));
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(`A folder, not a file, is at ${DOSSIER_PATH}, where the profile puts the dossier. Nothing was written.`);
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("reports a present file read without an ETag and sends nothing", async () => {
    const { graph, calls } = createScriptedGraph(stateScript({ dossier: { ...dossierItem('"e1"', 11), eTag: undefined } }));
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(`The file at ${DOSSIER_PATH} was read without an ETag, so no If-Match precondition could be sent. Nothing was written.`);
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("reports a read back answering 404 after the write, keeping the write's journal entry and leaving State alone", async () => {
    const { graph, calls } = createScriptedGraph([...stateScript(), CREATE, itemRead(DOSSIER_PATH, undefined)]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(`Graph accepted the write to ${DOSSIER_PATH}, but reading it back answered 404.`);
    expect((await context.store.listJournal(PROFILE, ID)).map((entry) => entry.operation)).toEqual(["file_created"]);
    expect(calls.filter((call) => call.method === "patch")).toEqual([]);
  });

  it("reports a read back answering a folder after the write, keeping the write's journal entry and leaving State alone", async () => {
    const { graph, calls } = createScriptedGraph([...stateScript(), CREATE, itemRead(DOSSIER_PATH, folderItem("Acme Corp_Research_Dossier.md"))]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(`Graph accepted the write to ${DOSSIER_PATH}, but reading it back returned a folder.`);
    expect((await context.store.listJournal(PROFILE, ID)).map((entry) => entry.operation)).toEqual(["file_created"]);
    expect(calls.filter((call) => call.method === "patch")).toEqual([]);
  });

  it("reports a State update whose returned fields disagree, journaling both writes", async () => {
    const { graph } = createScriptedGraph([
      ...stateScript(),
      CREATE,
      itemRead(DOSSIER_PATH, dossierItem('"e1"', BYTES.byteLength)),
      contentRead(DOSSIER_PATH, BYTES),
      { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", response: stateFields({ State: "ID" }) },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('the State update on Assessments item 2 answered "ID", not "DOSSIER". The journal records what was written.');
    expect((await context.store.listJournal(PROFILE, ID)).map((entry) => entry.operation)).toEqual(["file_created", "list_item_updated"]);
  });

  // Measured 2026-11-17 (L4a). The file is already written when the State update is refused, so
  // this is not a refusal that wrote nothing, and the text has to say what stands.
  it("reports a State update refused because the item changed, keeping the file's journal entry and adding none for the item", async () => {
    const { graph } = createScriptedGraph([
      ...stateScript(),
      CREATE,
      itemRead(DOSSIER_PATH, dossierItem('"e1"', BYTES.byteLength)),
      contentRead(DOSSIER_PATH, BYTES),
      { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", throws: { status: 412, code: "resourceModified" } },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      `${DOSSIER_PATH} was saved and read back with sha256 ${sha256Hex(BYTES)}, but State was not recorded: ` +
        'Assessments item 2 changed after this call read it: Graph answered 412 to If-Match "item-2,1". ' +
        "The file and its journal entry stand, and State was left as it is. " +
        "Saving the same content again will not record it: a save that writes no file records no stage.",
    );
    expect((await context.store.listJournal(PROFILE, ID)).map((entry) => entry.operation)).toEqual(["file_created"]);
  });

  it("names the folder it created in a failure that comes after it, since the journal holds that folder", async () => {
    const summary = new TextEncoder().encode("Summary.\n");
    const name = `${ID}_Executive_Summary.md`;
    const { graph } = createScriptedGraph([
      ...stateScript({ publishedPresent: false }),
      { method: "post", pathIncludes: `/drives/drive-1/root:/${ROOT}:/children`, response: folderItem("Published", '"f9"') },
      { method: "putBytes", pathIncludes: `${SUMMARY_PATH}:/content?@microsoft.graph.conflictBehavior=fail`, response: fileItem(name, '"e1"', summary.byteLength) },
      itemRead(SUMMARY_PATH, fileItem(name, '"e1"', summary.byteLength)),
      contentRead(SUMMARY_PATH, summary),
      { method: "patch", pathIncludes: "/lists/Assessments/items/2/fields", throws: { status: 412, code: "resourceModified" } },
    ]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact({ ...INPUT, kind: "executive_summary", content: "Summary.\n" }, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("but State was not recorded");
    expect(resultText(result)).toContain(`The folder ${ROOT}/Published was not there, so this call created it before writing the file; the journal records it.`);
    expect((await context.store.listJournal(PROFILE, ID)).map((entry) => entry.operation)).toEqual(["folder_created", "file_created"]);
  });

  it("refuses, having written nothing, when a file sits where a folder above the artifact belongs", async () => {
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      assessmentByIdQuery([listItem("2", stateFields())]),
      itemRead(ROOT, folderItem(ID)),
      itemRead(DOSSIER_PATH, undefined),
      itemRead(SUMMARY_PATH, undefined),
      itemRead(PUBLICATION_PATH, undefined),
      itemRead(`${ROOT}/Research`, fileItem("Research", '"x1"', 12)),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(`A file, not a folder, is at ${ROOT}/Research, above ${DOSSIER_PATH} where the profile puts the dossier. Nothing was written.`);
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("refuses an item read without an eTag before writing the file", async () => {
    const bare = { ...listItem("2", stateFields()), eTag: undefined, "@odata.etag": undefined };
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      assessmentByIdQuery([bare]),
      itemRead(ROOT, folderItem(ID)),
      itemRead(DOSSIER_PATH, undefined),
      itemRead(SUMMARY_PATH, undefined),
      itemRead(PUBLICATION_PATH, undefined),
    ]);

    const result = await runSaveAssessmentArtifact(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe("Assessments item 2 was read without an ETag, so no If-Match precondition could be sent. Nothing was written.");
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("names a file found under another name at the artifact's path, rather than calling it a folder", async () => {
    // SharePoint answers a path case insensitively, so the lookup returns the file under its own name.
    const { graph, calls } = createScriptedGraph(stateScript({ dossier: fileItem("acme corp_research_dossier.md", '"e1"', 11) }));
    const context = assessmentToolContext(graph);

    const result = await runSaveAssessmentArtifact(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      `The lookup of ${DOSSIER_PATH} answered a file named "acme corp_research_dossier.md", not "Acme Corp_Research_Dossier.md", the name the profile gives the dossier. ` +
        "The server writes only under that exact name. Nothing was written.",
    );
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
    expect(await context.store.listJournal(PROFILE, ID)).toEqual([]);
  });

  it("refuses under the stored assessment id when the caller's spelling differs by case", async () => {
    const typed = ID.toLowerCase();
    const { graph } = createScriptedGraph(stateScript({ typedId: typed, fields: { Status: "Completed" } }));

    const result = await runSaveAssessmentArtifact({ ...INPUT, assessmentId: typed }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect((refusalOf(result) as { assessmentId: string }).assessmentId).toBe(ID);
    expect(resultText(result)).toContain(`for ${ID}:`);
  });
});
