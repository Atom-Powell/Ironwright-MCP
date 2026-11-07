import { describe, expect, it } from "vitest";
import { runOpenAssessment } from "../../../src/tools/assessment/open.js";
import { RESOLVE_DRIVE_SCRIPT, assessmentToolContext, createScriptedGraph, listItem, resultText } from "./fake-graph.js";
import { assessmentFields, assessmentsQuery, firstOpenScript, folderCreates, idWriteBack, retryStateReads, rootRead, vendorsQuery } from "./open-script.js";

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
    expect(output.graphRequests).toBe(graph.requests());

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
      // The folder pass runs on a retry too, so a workspace an earlier call left half built is completed; present folders answer 409.
      ...folderCreates("Acme Corp", "ASM-2026-00002", ["Assessments", "Acme Corp", "ASM-2026-00002", "Research", "Evidence", "Published"]),
      rootRead("Acme Corp", "ASM-2026-00002"),
      ...retryStateReads("Acme Corp", "ASM-2026-00002"),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runOpenAssessment(INPUT, context);

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as Record<string, unknown>;
    expect(output.created).toBe(false);
    expect(output.assessmentId).toBe("ASM-2026-00002");
    expect(output.graphRequests).toBe(graph.requests());
    expect(calls.filter((call) => call.method === "patch")).toEqual([]);
    expect(calls.filter((call) => call.method === "post" && !call.path.endsWith("/children"))).toEqual([]);
    for (const key of ["(vendor)", "(unassigned)", "ASM-2026-00002"]) {
      expect(await context.store.listJournal(PROFILE, key)).toEqual([]);
    }
    expect(resultText(result)).toContain("already open");
  });

  it("resumes an open that died before the id was written", async () => {
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      vendorsQuery([listItem("7", { Title: "Acme Corp", FolderName: "Acme Corp" })]),
      assessmentsQuery("Acme Corp", [listItem("3", assessmentFields("Acme Corp"))]),
      ...idWriteBack("Acme Corp", "3", "ASM-2026-00003"),
      ...folderCreates("Acme Corp", "ASM-2026-00003"),
      rootRead("Acme Corp", "ASM-2026-00003"),
      ...retryStateReads("Acme Corp", "ASM-2026-00003"),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runOpenAssessment(INPUT, context);

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as Record<string, unknown>).assessmentId).toBe("ASM-2026-00003");
    expect(calls.filter((call) => call.method === "patch").map((call) => call.body)).toEqual([{ AssessmentId: "ASM-2026-00003" }]);
    expect(calls.filter((call) => call.method === "post" && call.path.includes("/lists/"))).toEqual([]);
    const journal = await context.store.listJournal(PROFILE, "ASM-2026-00003");
    expect(journal.filter((entry) => entry.operation === "folder_created")).toHaveLength(6);
    expect(journal.filter((entry) => entry.operation === "list_item_updated")).toHaveLength(1);
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
      rootRead("ACME", "ASM-2026-00002"),
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
