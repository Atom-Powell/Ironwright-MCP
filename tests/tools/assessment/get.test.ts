import { describe, expect, it } from "vitest";
import { NON_INDEXED_QUERY_HEADER } from "../../../src/graph/lists.js";
import { GET_INPUT_CONSTRAINTS, runGetAssessment } from "../../../src/tools/assessment/get.js";
import { L1_ITEMS_PAGE } from "../../graph/fixtures/assessment-probe.js";
import { RESOLVE_DRIVE_SCRIPT, assessmentToolContext, createScriptedGraph, fileItem, folderItem, listItem, page, resultText } from "./fake-graph.js";

const PROFILE = "vendor-assessments";
const ID = "ASM-2026-00002";
const ROOT = "Assessments/Acme Corp/ASM-2026-00002";

/** The probe's own fields, relabeled to this profile's vendor and id. */
const PROBE_FIELDS = { ...L1_ITEMS_PAGE.value[0].fields, Title: "Acme Corp", AssessmentId: ID, VendorFolder: "Acme Corp", Scope: "Security", Status: "In Progress", State: "DOSSIER" };

describe("get_assessment", () => {
  it("reads one assessment by id with its artifacts and a journal summary", async () => {
    const { graph } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      { method: "get", pathIncludes: ["/lists/Assessments/items?", `AssessmentId eq '${ID}'`], headersInclude: NON_INDEXED_QUERY_HEADER, response: page([listItem("2", PROBE_FIELDS)]) },
      { method: "get", pathIncludes: `/drives/drive-1/root:/${ROOT}:?`, response: folderItem(ID) },
      { method: "get", pathIncludes: `${ROOT}/Research/Acme Corp_Research_Dossier.md:?`, response: fileItem("Acme Corp_Research_Dossier.md", '"dossier-1"', 16) },
      { method: "get", pathIncludes: "_Executive_Summary.md", throws: { status: 404, code: "itemNotFound" } },
      { method: "get", pathIncludes: "_Risk_Assessment.docx", throws: { status: 404, code: "itemNotFound" } },
    ]);
    const context = assessmentToolContext(graph);
    const base = { at: "2026-11-07T10:00:00.000Z", correlationId: "c-1", stage: "ID" };
    await context.store.appendJournalEntry(PROFILE, ID, { ...base, operation: "list_item_updated", target: "Assessments/2" });
    await context.store.appendJournalEntry(PROFILE, ID, { ...base, at: "2026-11-07T10:00:01.000Z", operation: "folder_created", target: ROOT });

    const result = await runGetAssessment({ profileId: PROFILE, assessmentId: ID }, context);

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as {
      found: boolean;
      assessment: Record<string, unknown>;
      artifacts: Array<{ kind: string; present: boolean; size?: number }>;
      journal: { entries: number; lastAt?: string; byOperation: Record<string, number> };
      graphRequests: number;
    };
    expect(output.found).toBe(true);
    expect(output.assessment).toMatchObject({ assessmentId: ID, itemId: "2", vendor: "Acme Corp", vendorFolder: "Acme Corp", scope: "Security", status: "In Progress", state: "DOSSIER" });
    expect(output.artifacts.map((artifact) => [artifact.kind, artifact.present])).toEqual([
      ["dossier", true],
      ["executive_summary", false],
      ["publication", false],
    ]);
    expect(output.artifacts[0]!.size).toBe(16);
    expect(output.journal.entries).toBe(2);
    expect(output.journal.lastAt).toBe("2026-11-07T10:00:01.000Z");
    expect(output.journal.byOperation.folder_created).toBe(1);
    expect(output.journal.byOperation.list_item_updated).toBe(1);
    expect(output.graphRequests).toBe(graph.requests());
  });

  it("lists a vendor's assessments by its folder name without reading the drive", async () => {
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      {
        method: "get",
        pathIncludes: ["/lists/Assessments/items?", "VendorFolder eq 'Acme Corp'"],
        headersInclude: NON_INDEXED_QUERY_HEADER,
        response: page([listItem("2", PROBE_FIELDS), listItem("5", { ...PROBE_FIELDS, AssessmentId: "ASM-2026-00005", Status: "Completed" })]),
      },
    ]);

    const result = await runGetAssessment({ profileId: PROFILE, vendor: "Acme Corp" }, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as { found: boolean; assessments: Array<Record<string, unknown>>; graphRequests: number };
    expect(output.found).toBe(true);
    expect(output.assessments.map((summary) => [summary.assessmentId, summary.status])).toEqual([
      ["ASM-2026-00002", "In Progress"],
      ["ASM-2026-00005", "Completed"],
    ]);
    expect(calls.filter((call) => call.path.includes("/drives/drive-1/"))).toEqual([]);
    expect(output.graphRequests).toBe(graph.requests());
  });

  it("reports an id no assessment carries as not found rather than as an error", async () => {
    const { graph } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      { method: "get", pathIncludes: ["/lists/Assessments/items?", "AssessmentId eq 'ASM-2026-04040'"], response: page([]) },
    ]);

    const result = await runGetAssessment({ profileId: PROFILE, assessmentId: "ASM-2026-04040" }, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { found: boolean }).found).toBe(false);
    expect(resultText(result)).toContain('No item in list "Assessments" carries the assessment id "ASM-2026-04040".');
  });

  it.each([
    ["neither", { profileId: PROFILE }],
    ["both", { profileId: PROFILE, assessmentId: ID, vendor: "Acme Corp" }],
  ])("refuses %s of assessmentId and vendor before any Graph request", async (_label, input) => {
    const { graph } = createScriptedGraph([]);

    const result = await runGetAssessment(input, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(GET_INPUT_CONSTRAINTS);
    expect(graph.requests()).toBe(0);
  });
});
