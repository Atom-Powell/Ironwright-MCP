import { describe, expect, it } from "vitest";
import { runOpenAssessment } from "../../../src/tools/assessment/open.js";
import { RESOLVE_DRIVE_SCRIPT, assessmentToolContext, createScriptedGraph, listItem, resultText } from "./fake-graph.js";
import { assessmentFields, assessmentsQuery, firstOpenScript, folderCreates, idWriteBack, readBacks, workspaceReads, vendorsQuery } from "./open-script.js";

const PROFILE = "vendor-assessments";
const INPUT = { profileId: PROFILE, vendor: "Acme Corp", scope: "Security" };

describe("open_assessment", () => {
  it("creates the vendor, the assessment, its id and the workspace on first open, journaling each confirmed write", async () => {
    const { graph, calls } = createScriptedGraph(firstOpenScript());
    const context = assessmentToolContext(graph);

    const result = await runOpenAssessment(INPUT, context);

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as Record<string, unknown>;
    expect(output.assessmentId).toBe("ASM-2026-00002");
    expect(output.workspaceRoot).toBe("Assessments/Acme Corp/ASM-2026-00002");
    expect(output.subfolders).toEqual([
      "Assessments/Acme Corp/ASM-2026-00002/Research",
      "Assessments/Acme Corp/ASM-2026-00002/Evidence",
      "Assessments/Acme Corp/ASM-2026-00002/Published",
    ]);
    expect(output.created).toBe(true);
    expect(output.resumed).toBe(false);
    expect(output.graphRequests).toBe(graph.requests());
    const readBackPaths = calls.filter((call) => call.method === "get" && call.path.includes("/drives/drive-1/root:/")).map((call) => decodeURIComponent(call.path).split(":?")[0]);
    expect(readBackPaths).toEqual([
      "/drives/drive-1/root:/Assessments/Acme Corp/ASM-2026-00002",
      "/drives/drive-1/root:/Assessments/Acme Corp/ASM-2026-00002/Research",
      "/drives/drive-1/root:/Assessments/Acme Corp/ASM-2026-00002/Evidence",
      "/drives/drive-1/root:/Assessments/Acme Corp/ASM-2026-00002/Published",
    ]);
    expect(resultText(result)).toBe(
      "Opened ASM-2026-00002 for Acme Corp (Security): item 2 in Assessments, workspace Assessments/Acme Corp/ASM-2026-00002, root and 3 subfolders read back.",
    );

    const assessmentCreate = calls.find((call) => call.method === "post" && call.path.includes("/lists/Assessments/items"));
    const createFields = (assessmentCreate?.body as { fields: Record<string, unknown> }).fields;
    expect(createFields).toMatchObject({ Title: "Acme Corp", Status: "In Progress", State: "ID", VendorFolder: "Acme Corp", Scope: "Security" });
    expect(createFields).not.toHaveProperty("AssessmentId");
    expect(calls.find((call) => call.method === "patch")?.body).toEqual({ AssessmentId: "ASM-2026-00002" });

    // The vendor and the pre-id assessment item are journaled under placeholder keys, because no id exists when they are written.
    const vendorJournal = await context.store.listJournal(PROFILE, "(vendor)");
    const unassignedJournal = await context.store.listJournal(PROFILE, "(unassigned)");
    const keyedJournal = await context.store.listJournal(PROFILE, "ASM-2026-00002");
    expect(vendorJournal.map((entry) => [entry.operation, entry.target])).toEqual([["list_item_created", "Vendors/7"]]);
    expect(unassignedJournal.map((entry) => [entry.operation, entry.target])).toEqual([["list_item_created", "Assessments/2"]]);
    expect(keyedJournal.map((entry) => entry.operation).sort()).toEqual(["list_item_updated", ...Array<string>(6).fill("folder_created")].sort());
    expect(keyedJournal.filter((entry) => entry.operation === "folder_created").map((entry) => entry.target).sort()).toEqual(
      [
        "Assessments",
        "Assessments/Acme Corp",
        "Assessments/Acme Corp/ASM-2026-00002",
        "Assessments/Acme Corp/ASM-2026-00002/Research",
        "Assessments/Acme Corp/ASM-2026-00002/Evidence",
        "Assessments/Acme Corp/ASM-2026-00002/Published",
      ].sort(),
    );
    const correlationIds = new Set([...vendorJournal, ...unassignedJournal, ...keyedJournal].map((entry) => entry.correlationId));
    expect([...correlationIds]).toEqual([output.correlationId]);
  });

  it("returns the assessment already in progress on a second call and writes nothing", async () => {
    const existing = listItem("2", { ...assessmentFields("Acme Corp"), AssessmentId: "ASM-2026-00002" });
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      vendorsQuery([listItem("7", { Title: "Acme Corp", FolderName: "Acme Corp" })]),
      assessmentsQuery("Acme Corp", [existing]),
      // The live state read finds the root present, so no folder is created or even attempted.
      ...workspaceReads("Acme Corp", "ASM-2026-00002"),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runOpenAssessment(INPUT, context);

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as Record<string, unknown>;
    expect(output.created).toBe(false);
    expect(output.resumed).toBe(false);
    expect(output.assessmentId).toBe("ASM-2026-00002");
    expect(output.graphRequests).toBe(graph.requests());
    expect(calls.filter((call) => call.method === "patch")).toEqual([]);
    expect(calls.filter((call) => call.method === "post")).toEqual([]);
    for (const key of ["(vendor)", "(unassigned)", "ASM-2026-00002"]) {
      expect(await context.store.listJournal(PROFILE, key)).toEqual([]);
    }
    expect(resultText(result)).toBe(
      "ASM-2026-00002 for Acme Corp (Security) is already open; nothing was written. Workspace Assessments/Acme Corp/ASM-2026-00002: root and 3 subfolders read as folders.",
    );
  });

  it("resumes an open that died before the id was written", async () => {
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      vendorsQuery([listItem("7", { Title: "Acme Corp", FolderName: "Acme Corp" })]),
      assessmentsQuery("Acme Corp", [listItem("3", assessmentFields("Acme Corp"))]),
      ...idWriteBack("Acme Corp", "3", "ASM-2026-00003"),
      ...folderCreates("Acme Corp", "ASM-2026-00003"),
      ...readBacks("Acme Corp", "ASM-2026-00003"),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runOpenAssessment(INPUT, context);

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as Record<string, unknown>;
    expect(output.assessmentId).toBe("ASM-2026-00003");
    expect(output.created).toBe(false);
    expect(output.resumed).toBe(true);
    expect(output.graphRequests).toBe(graph.requests());
    expect(resultText(result)).toBe(
      "Resumed ASM-2026-00003 for Acme Corp (Security), which was already in progress: this call wrote the assessment id to item 3 and created 6 folders. " +
        "Workspace Assessments/Acme Corp/ASM-2026-00003: root and 3 subfolders read back.",
    );
    expect(calls.filter((call) => call.method === "patch").map((call) => call.body)).toEqual([{ AssessmentId: "ASM-2026-00003" }]);
    expect(calls.filter((call) => call.method === "post" && call.path.includes("/lists/"))).toEqual([]);
    const journal = await context.store.listJournal(PROFILE, "ASM-2026-00003");
    expect(journal.filter((entry) => entry.operation === "folder_created")).toHaveLength(6);
    expect(journal.filter((entry) => entry.operation === "list_item_updated")).toHaveLength(1);
  });

  it("resumes an open that died between the id write and the folders, when the live read finds no root", async () => {
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      vendorsQuery([listItem("7", { Title: "Acme Corp", FolderName: "Acme Corp" })]),
      assessmentsQuery("Acme Corp", [listItem("2", { ...assessmentFields("Acme Corp"), AssessmentId: "ASM-2026-00002" })]),
      ...workspaceReads("Acme Corp", "ASM-2026-00002", "(root)"),
      ...folderCreates("Acme Corp", "ASM-2026-00002", ["Assessments", "Acme Corp"]),
      ...readBacks("Acme Corp", "ASM-2026-00002"),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runOpenAssessment(INPUT, context);

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as Record<string, unknown>;
    expect(output.created).toBe(false);
    expect(output.resumed).toBe(true);
    expect(calls.filter((call) => call.method === "patch")).toEqual([]);
    expect(resultText(result)).toBe(
      "Resumed ASM-2026-00002 for Acme Corp (Security), which was already in progress: this call created 4 folders. " +
        "Workspace Assessments/Acme Corp/ASM-2026-00002: root and 3 subfolders read back.",
    );
    expect((await context.store.listJournal(PROFILE, "ASM-2026-00002")).map((entry) => entry.operation)).toEqual(Array<string>(4).fill("folder_created"));
  });

  it("resumes an open that died after the root was created but before a subfolder was", async () => {
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      vendorsQuery([listItem("7", { Title: "Acme Corp", FolderName: "Acme Corp" })]),
      assessmentsQuery("Acme Corp", [listItem("2", { ...assessmentFields("Acme Corp"), AssessmentId: "ASM-2026-00002" })]),
      ...workspaceReads("Acme Corp", "ASM-2026-00002", "Evidence"),
      ...folderCreates("Acme Corp", "ASM-2026-00002", ["Assessments", "Acme Corp", "ASM-2026-00002", "Research", "Published"]),
      ...readBacks("Acme Corp", "ASM-2026-00002"),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runOpenAssessment(INPUT, context);

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as Record<string, unknown>;
    expect(output.created).toBe(false);
    expect(output.resumed).toBe(true);
    expect(calls.filter((call) => call.method === "post")).toHaveLength(6);
    expect(resultText(result)).toBe(
      "Resumed ASM-2026-00002 for Acme Corp (Security), which was already in progress: this call created 1 folder. " +
        "Workspace Assessments/Acme Corp/ASM-2026-00002: root and 3 subfolders read back.",
    );
    expect((await context.store.listJournal(PROFILE, "ASM-2026-00002")).map((entry) => [entry.operation, entry.target])).toEqual([
      ["folder_created", "Assessments/Acme Corp/ASM-2026-00002/Evidence"],
    ]);
  });

  it("reports a folder that already exists as satisfied and journals only what it created", async () => {
    const { graph } = createScriptedGraph(firstOpenScript(["Assessments"]));
    const context = assessmentToolContext(graph);

    const result = await runOpenAssessment(INPUT, context);

    expect(result.isError).toBeUndefined();
    const folders = (await context.store.listJournal(PROFILE, "ASM-2026-00002")).filter((entry) => entry.operation === "folder_created");
    expect(folders.map((entry) => entry.target)).not.toContain("Assessments");
    expect(folders).toHaveLength(5);
  });

  it("uses the vendor's stored folder name over the one it would compute", async () => {
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      vendorsQuery([listItem("7", { Title: "Acme Corp", FolderName: "ACME" })]),
      assessmentsQuery("ACME", []),
      { method: "post", pathIncludes: "/lists/Assessments/items", response: listItem("2", assessmentFields("ACME")) },
      ...idWriteBack("ACME", "2", "ASM-2026-00002"),
      ...folderCreates("ACME", "ASM-2026-00002"),
      ...readBacks("ACME", "ASM-2026-00002"),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runOpenAssessment(INPUT, context);

    expect(result.isError).toBeUndefined();
    const create = calls.find((call) => call.method === "post" && call.path.includes("/lists/Assessments/items"));
    expect((create?.body as { fields: Record<string, unknown> }).fields.VendorFolder).toBe("ACME");
    expect((result.structuredContent as Record<string, unknown>).workspaceRoot).toBe("Assessments/ACME/ASM-2026-00002");
    expect(calls.some((call) => call.method === "post" && call.path.includes("/lists/Vendors/"))).toBe(false);
  });
});
