import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOpenAssessment } from "../../../src/tools/assessment/open.js";
import { RESOLVE_DRIVE_SCRIPT, assessmentToolContext, createScriptedGraph, fileItem, listItem, resultText } from "./fake-graph.js";
import { assessmentFields, assessmentsQuery, folderCreates, idWriteBack, readBacks, vendorsQuery, workspaceReads } from "./open-script.js";

const PROFILE = "vendor-assessments";
const INPUT = { profileId: PROFILE, vendor: "Acme Corp", scope: "Security" };

describe("open_assessment failures", () => {
  // The handler logs a failure before describing it; silenced so the run's output stays clean.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a vendor name with no character a folder name allows, before any Graph request", async () => {
    const { graph } = createScriptedGraph([]);
    const vendor = '"*:<>?/\\|';

    const result = await runOpenAssessment({ ...INPUT, vendor }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(vendor);
    expect(graph.requests()).toBe(0);
  });

  it("refuses a library profile before any Graph request", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runOpenAssessment({ ...INPUT, profileId: "shared-docs" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("assessment profile");
    expect(graph.requests()).toBe(0);
  });

  it("reports a profile id the registry does not know through describeToolFailure", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runOpenAssessment({ ...INPUT, profileId: "no-such-profile" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('No profile named "no-such-profile" is configured.');
    expect(graph.requests()).toBe(0);
  });

  it("stops before any folder when the id write does not read back, and the journal holds what did happen", async () => {
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      vendorsQuery([listItem("7", { Title: "Acme Corp", FolderName: "Acme Corp" })]),
      assessmentsQuery("Acme Corp", []),
      { method: "post", pathIncludes: "/lists/Assessments/items", response: listItem("2", assessmentFields("Acme Corp")) },
      ...idWriteBack("Acme Corp", "2", "ASM-2026-00002", "ASM-2026-99999"),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runOpenAssessment(INPUT, context);

    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain('"ASM-2026-00002" was written');
    expect(text).toContain('read back as "ASM-2026-99999"');
    expect(text).toContain("No folder was created.");
    expect(calls.some((call) => call.path.endsWith("/children"))).toBe(false);
    expect((await context.store.listJournal(PROFILE, "(unassigned)")).map((entry) => entry.operation)).toEqual(["list_item_created"]);
    expect((await context.store.listJournal(PROFILE, "ASM-2026-00002")).map((entry) => entry.operation)).toEqual(["list_item_updated"]);
  });

  it("names the root path when the root does not read back after the creates", async () => {
    const { graph } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      vendorsQuery([listItem("7", { Title: "Acme Corp", FolderName: "Acme Corp" })]),
      assessmentsQuery("Acme Corp", [listItem("2", { ...assessmentFields("Acme Corp"), AssessmentId: "ASM-2026-00002" })]),
      // The live workspace read finds no root, so the folder pass runs; the root then still does not read back.
      { method: "get", pathIncludes: "/drives/drive-1/root:/Assessments/Acme Corp/ASM-2026-00002:?", throws: { status: 404, code: "itemNotFound" } },
      ...folderCreates("Acme Corp", "ASM-2026-00002"),
      { method: "get", pathIncludes: "/drives/drive-1/root:/Assessments/Acme Corp/ASM-2026-00002:?", throws: { status: 404, code: "itemNotFound" } },
    ]);

    const result = await runOpenAssessment(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      "Assessments/Acme Corp/ASM-2026-00002 was expected to be a folder; reading it back answered 404. The journal records what this call created.",
    );
  });

  it("refuses a retry whose subfolder name is held by a file, though every create answered 409", async () => {
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      vendorsQuery([listItem("7", { Title: "Acme Corp", FolderName: "Acme Corp" })]),
      assessmentsQuery("Acme Corp", [listItem("2", { ...assessmentFields("Acme Corp"), AssessmentId: "ASM-2026-00002" })]),
      // The live read finds a file where Evidence belongs, so the folder pass runs; every name is taken.
      ...workspaceReads("Acme Corp", "ASM-2026-00002").slice(0, 2),
      { method: "get", pathIncludes: "/drives/drive-1/root:/Assessments/Acme Corp/ASM-2026-00002/Evidence:?", response: fileItem("Evidence", '"file-1"', 5) },
      ...folderCreates("Acme Corp", "ASM-2026-00002", ["Assessments", "Acme Corp", "ASM-2026-00002", "Research", "Evidence", "Published"]),
      ...readBacks("Acme Corp", "ASM-2026-00002", { Evidence: "file" }),
    ]);
    const context = assessmentToolContext(graph);

    const result = await runOpenAssessment(INPUT, context);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(
      "Assessments/Acme Corp/ASM-2026-00002/Evidence was expected to be a folder; reading it back answered a file. The journal records what this call created.",
    );
    expect(resultText(result)).not.toContain("already open");
    expect(calls.filter((call) => call.method === "patch")).toEqual([]);
    expect(calls.some((call) => call.path.includes("/Published:?") && call.method === "get")).toBe(false);
    expect(await context.store.listJournal(PROFILE, "ASM-2026-00002")).toEqual([]);
  });

  it("describes a 403 from the first list query without guessing a cause", async () => {
    const { graph } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      { method: "get", pathIncludes: "/lists/Vendors/items?", throws: { status: 403, code: "accessDenied" } },
    ]);

    const result = await runOpenAssessment(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("Microsoft Graph refused GET");
    expect(text).toContain("with 403 (accessDenied)");
    expect(text).toContain('while serving open_assessment for profile "vendor-assessments"');
    expect(text).toContain("This server does not infer a cause from the status.");
  });
});
