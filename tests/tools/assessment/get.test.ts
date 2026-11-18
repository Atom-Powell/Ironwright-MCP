import { describe, expect, it } from "vitest";
import { NON_INDEXED_QUERY_HEADER } from "../../../src/graph/lists.js";
import { GET_INPUT_CONSTRAINTS, runGetAssessment } from "../../../src/tools/assessment/get.js";
import { L1_ITEMS_PAGE } from "../../graph/fixtures/assessment-probe.js";
import { vendorsQuery } from "./open-script.js";
import { RESOLVE_DRIVE_SCRIPT, assessmentToolContext, createScriptedGraph, fileItem, folderItem, listItem, page, resultText, type ScriptEntry } from "./fake-graph.js";

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

  it("reports a publication whose name differs from the canonical one only by case as not present", async () => {
    const { graph } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      { method: "get", pathIncludes: ["/lists/Assessments/items?", `AssessmentId eq '${ID}'`], headersInclude: NON_INDEXED_QUERY_HEADER, response: page([listItem("2", PROBE_FIELDS)]) },
      { method: "get", pathIncludes: `/drives/drive-1/root:/${ROOT}:?`, response: folderItem(ID) },
      { method: "get", pathIncludes: "_Research_Dossier.md", throws: { status: 404, code: "itemNotFound" } },
      { method: "get", pathIncludes: "_Executive_Summary.md", throws: { status: 404, code: "itemNotFound" } },
      // SharePoint answers the path case insensitively, so the item comes back under its own name.
      { method: "get", pathIncludes: "_Risk_Assessment.docx", response: fileItem("acme corp_asm-2026-00002_risk_assessment.docx", '"p1"', 52) },
    ]);

    const result = await runGetAssessment({ profileId: PROFILE, assessmentId: ID }, assessmentToolContext(graph));

    const artifacts = (result.structuredContent as { artifacts: Array<{ kind: string; present: boolean }> }).artifacts;
    expect(artifacts.find((artifact) => artifact.kind === "publication")?.present).toBe(false);
  });

  it("says why the root path could not be computed, and reads nothing from the drive, for an item with no Title", async () => {
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      { method: "get", pathIncludes: ["/lists/Assessments/items?", `AssessmentId eq '${ID}'`], headersInclude: NON_INDEXED_QUERY_HEADER, response: page([listItem("2", { ...PROBE_FIELDS, Title: "" })]) },
    ]);

    const result = await runGetAssessment({ profileId: PROFILE, assessmentId: ID }, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("The workspace root path could not be computed: item 2 has no Title, so the drive was not read.");
    expect(text).not.toContain("not found");
    expect(text).not.toContain("Artifacts present");
    expect(calls.filter((call) => call.path.includes("/drives/drive-1/root:"))).toEqual([]);
  });

  it("lists a vendor's assessments by its folder name without reading the drive", async () => {
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      vendorsQuery([listItem("7", { Title: "Acme Corp", FolderName: "Acme Corp" })]),
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

  it("filters on the vendor's stored folder name when it differs from the sanitized one", async () => {
    const { graph } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      vendorsQuery([listItem("7", { Title: "Acme Corp", FolderName: "ACME" })]),
      {
        method: "get",
        pathIncludes: ["/lists/Assessments/items?", "VendorFolder eq 'ACME'"],
        headersInclude: NON_INDEXED_QUERY_HEADER,
        response: page([listItem("2", { ...PROBE_FIELDS, VendorFolder: "ACME" })]),
      },
    ]);

    const result = await runGetAssessment({ profileId: PROFILE, vendor: "Acme Corp" }, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as { found: boolean; assessments: Array<Record<string, unknown>> };
    expect(output.found).toBe(true);
    expect(output.assessments.map((summary) => summary.vendorFolder)).toEqual(["ACME"]);
  });

  it("falls back to the sanitized name when the vendor has no record", async () => {
    const { graph } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      { method: "get", pathIncludes: ["/lists/Vendors/items?", "Title eq 'Acme: Corp'"], response: page([]) },
      { method: "get", pathIncludes: ["/lists/Assessments/items?", "VendorFolder eq 'Acme Corp'"], response: page([]) },
    ]);

    const result = await runGetAssessment({ profileId: PROFILE, vendor: "Acme: Corp" }, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { found: boolean }).found).toBe(false);
    expect(resultText(result)).toBe('No item in list "Assessments" has VendorFolder "Acme Corp".');
  });

  it("refuses a vendor name with no character a folder name allows, before any Graph request", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runGetAssessment({ profileId: PROFILE, vendor: '"*:<>?/\\|' }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("no characters SharePoint allows in a folder name");
    expect(graph.requests()).toBe(0);
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
    ["none of the three selectors", { profileId: PROFILE }],
    ["an id beside a vendor", { profileId: PROFILE, assessmentId: ID, vendor: "Acme Corp" }],
    ["an id beside a status", { profileId: PROFILE, assessmentId: ID, status: "in_progress" }],
    ["a vendor beside a status", { profileId: PROFILE, vendor: "Acme Corp", status: "completed" }],
    ["include on a vendor listing", { profileId: PROFILE, vendor: "Acme Corp", include: ["findings"] }],
    ["include on a status listing", { profileId: PROFILE, status: "in_progress", include: ["journal"] }],
  ])("refuses %s before any Graph request", async (_label, input) => {
    const { graph } = createScriptedGraph([]);

    const result = await runGetAssessment(input, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(GET_INPUT_CONSTRAINTS);
    expect(graph.requests()).toBe(0);
  });

  it("carries no ETag or size for a path that holds a file under another name, as the output schema says of an absent file", async () => {
    const { graph } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      { method: "get", pathIncludes: ["/lists/Assessments/items?", `AssessmentId eq '${ID}'`], headersInclude: NON_INDEXED_QUERY_HEADER, response: page([listItem("2", PROBE_FIELDS)]) },
      { method: "get", pathIncludes: `/drives/drive-1/root:/${ROOT}:?`, response: folderItem(ID) },
      { method: "get", pathIncludes: "_Research_Dossier.md", throws: { status: 404, code: "itemNotFound" } },
      { method: "get", pathIncludes: "_Executive_Summary.md", throws: { status: 404, code: "itemNotFound" } },
      { method: "get", pathIncludes: "_Risk_Assessment.docx", response: fileItem("acme corp_asm-2026-00002_risk_assessment.docx", '"p1"', 52) },
    ]);

    const result = await runGetAssessment({ profileId: PROFILE, assessmentId: ID }, assessmentToolContext(graph));

    const artifacts = (result.structuredContent as { artifacts: Array<{ kind: string; present: boolean; eTag?: string; size?: number }> }).artifacts;
    const publication = artifacts.find((artifact) => artifact.kind === "publication")!;
    expect(publication).toMatchObject({ present: false });
    expect(publication.eTag).toBeUndefined();
    expect(publication.size).toBeUndefined();
  });

  it("reads the journal under the stored assessment id when the caller's spelling differs by case", async () => {
    const typed = ID.toLowerCase();
    const { graph } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      { method: "get", pathIncludes: ["/lists/Assessments/items?", `AssessmentId eq '${typed}'`], headersInclude: NON_INDEXED_QUERY_HEADER, response: page([listItem("2", PROBE_FIELDS)]) },
      { method: "get", pathIncludes: `/drives/drive-1/root:/${ROOT}:?`, response: folderItem(ID) },
      { method: "get", pathIncludes: "_Research_Dossier.md", throws: { status: 404, code: "itemNotFound" } },
      { method: "get", pathIncludes: "_Executive_Summary.md", throws: { status: 404, code: "itemNotFound" } },
      { method: "get", pathIncludes: "_Risk_Assessment.docx", throws: { status: 404, code: "itemNotFound" } },
    ]);
    const context = assessmentToolContext(graph);
    await context.store.appendJournalEntry(PROFILE, ID, { at: "2026-11-07T10:00:00.000Z", correlationId: "c-1", stage: "ID", operation: "folder_created", target: ROOT });

    const result = await runGetAssessment({ profileId: PROFILE, assessmentId: typed }, context);

    expect((result.structuredContent as { journal: { entries: number } }).journal.entries).toBe(1);
    expect(resultText(result)).toContain(`${ID}: item 2`);
  });

  /** The id lookup and the drive reads for an assessment whose dossier is saved and nothing else. */
  function dossierOnly(): ScriptEntry[] {
    return [
      ...RESOLVE_DRIVE_SCRIPT,
      { method: "get", pathIncludes: ["/lists/Assessments/items?", `AssessmentId eq '${ID}'`], headersInclude: NON_INDEXED_QUERY_HEADER, response: page([listItem("2", { ...PROBE_FIELDS, Summary: "Two findings, one high." })]) },
      { method: "get", pathIncludes: `/drives/drive-1/root:/${ROOT}:?`, response: folderItem(ID) },
      { method: "get", pathIncludes: `${ROOT}/Research/Acme Corp_Research_Dossier.md:?`, response: fileItem("Acme Corp_Research_Dossier.md", '"dossier-1"', 16) },
      { method: "get", pathIncludes: "_Executive_Summary.md", throws: { status: 404, code: "itemNotFound" } },
      { method: "get", pathIncludes: "_Risk_Assessment.docx", throws: { status: 404, code: "itemNotFound" } },
    ];
  }

  it("reports what each lifecycle tool would find on the state it read, with the evidence of each refusal", async () => {
    const { graph } = createScriptedGraph(dossierOnly());

    const result = await runGetAssessment({ profileId: PROFILE, assessmentId: ID }, assessmentToolContext(graph));

    const output = result.structuredContent as { readiness: Array<Record<string, unknown>> };
    expect(output.readiness).toEqual([
      { tool: "save_assessment_artifact", ready: true },
      { tool: "record_findings", ready: true },
      { tool: "transition_assessment", target: "provisional", ready: true },
      {
        tool: "transition_assessment",
        target: "completed",
        ready: false,
        expected: "the publication present at its canonical path",
        observed: "not present",
        evidence: [{ source: "drive", target: `${ROOT}/Published/Acme Corp_${ID}_Risk_Assessment.docx`, found: "not found" }],
      },
    ]);
    expect(resultText(result)).toContain(
      "On what this call read: save_assessment_artifact, record_findings and transition_assessment to provisional would proceed; " +
        "transition_assessment to completed would be refused (expected the publication present at its canonical path, observed not present).",
    );
  });

  // Two reasons since 2026-11-17, not one: completion is reached from provisional as well as
  // from in progress, so that tool expects something the other three do not.
  it("says why nothing would proceed for an assessment that is completed, grouping the tools by what each expected", async () => {
    const script = dossierOnly();
    script[2] = { method: "get", pathIncludes: ["/lists/Assessments/items?", `AssessmentId eq '${ID}'`], headersInclude: NON_INDEXED_QUERY_HEADER, response: page([listItem("2", { ...PROBE_FIELDS, Status: "Completed" })]) };
    const { graph } = createScriptedGraph(script);

    const result = await runGetAssessment({ profileId: PROFILE, assessmentId: ID }, assessmentToolContext(graph));

    expect((result.structuredContent as { readiness: Array<{ ready: boolean }> }).readiness.every((entry) => !entry.ready)).toBe(true);
    expect(resultText(result)).toContain(
      "On what this call read: no lifecycle tool would proceed; " +
        'save_assessment_artifact, record_findings and transition_assessment to provisional would be refused (expected status "In Progress", observed status "Completed"); ' +
        'transition_assessment to completed would be refused (expected status "In Progress" or "Provisional", observed status "Completed").',
    );
  });

  it("reports a provisional assessment as ready to complete once its publication is present, and for nothing else", async () => {
    const script = dossierOnly();
    script[2] = { method: "get", pathIncludes: ["/lists/Assessments/items?", `AssessmentId eq '${ID}'`], headersInclude: NON_INDEXED_QUERY_HEADER, response: page([listItem("2", { ...PROBE_FIELDS, Status: "Provisional" })]) };
    script[6] = { method: "get", pathIncludes: "_Risk_Assessment.docx", response: fileItem("Acme Corp_ASM-2026-00002_Risk_Assessment.docx", '"p1"', 52) };
    const { graph } = createScriptedGraph(script);

    const result = await runGetAssessment({ profileId: PROFILE, assessmentId: ID }, assessmentToolContext(graph));

    expect((result.structuredContent as { readiness: Array<{ target?: string; ready: boolean }> }).readiness.map((entry) => [entry.target, entry.ready])).toEqual([
      [undefined, false],
      [undefined, false],
      ["provisional", false],
      ["completed", true],
    ]);
    expect(resultText(result)).toContain("transition_assessment to completed would proceed");
  });

  it("names what holds an artifact's path when it is not the artifact", async () => {
    const script = dossierOnly();
    script[6] = { method: "get", pathIncludes: "_Risk_Assessment.docx", response: fileItem("acme corp_asm-2026-00002_risk_assessment.docx", '"p1"', 52) };
    const { graph } = createScriptedGraph(script);

    const result = await runGetAssessment({ profileId: PROFILE, assessmentId: ID }, assessmentToolContext(graph));

    const artifacts = (result.structuredContent as { artifacts: Array<Record<string, unknown>> }).artifacts;
    expect(artifacts.find((artifact) => artifact.kind === "publication")).toMatchObject({ present: false, occupant: { name: "acme corp_asm-2026-00002_risk_assessment.docx", isFolder: false } });
    expect(artifacts.find((artifact) => artifact.kind === "dossier")).not.toHaveProperty("occupant");
    expect(resultText(result)).toContain('the path answered a file named "acme corp_asm-2026-00002_risk_assessment.docx"');
  });

  it("reads the findings and the summary back when asked, and sends no Findings request when not", async () => {
    const findings = { method: "get" as const, pathIncludes: ["/lists/Findings/items?", `AssessmentId eq '${ID}'`], headersInclude: NON_INDEXED_QUERY_HEADER, response: page([
      listItem("11", { Title: "F-1", AssessmentId: ID, FindingKey: "F-1", Observation: "SOC 2 covers the subsidiary only.", Risk: "High", Recommendation: "Request the parent report." }),
      listItem("12", { Title: "F-2", AssessmentId: ID, FindingKey: "F-2", Observation: "No penetration test.", Risk: "Medium", Recommendation: "Request a summary." }),
    ]) };
    const asked = createScriptedGraph([...dossierOnly(), findings]);

    const result = await runGetAssessment({ profileId: PROFILE, assessmentId: ID, include: ["findings"] }, assessmentToolContext(asked.graph));

    const output = result.structuredContent as { summary?: string; findings?: Array<Record<string, unknown>>; graphRequests: number };
    expect(output.summary).toBe("Two findings, one high.");
    expect(output.findings).toEqual([
      { key: "F-1", itemId: "11", risk: "High", observation: "SOC 2 covers the subsidiary only.", recommendation: "Request the parent report." },
      { key: "F-2", itemId: "12", risk: "Medium", observation: "No penetration test.", recommendation: "Request a summary." },
    ]);
    expect(output.graphRequests).toBe(asked.graph.requests());
    expect(resultText(result)).toContain('Summary: "Two findings, one high." Findings recorded: 2. F-1 (High): SOC 2 covers the subsidiary only. Recommendation: Request the parent report. F-2 (Medium): No penetration test. Recommendation: Request a summary.');

    const plain = createScriptedGraph(dossierOnly());
    const without = await runGetAssessment({ profileId: PROFILE, assessmentId: ID }, assessmentToolContext(plain.graph));
    expect(without.structuredContent).not.toHaveProperty("findings");
    expect(without.structuredContent).not.toHaveProperty("summary");
    expect(plain.calls.filter((call) => call.path.includes("/lists/Findings/"))).toEqual([]);
  });

  it("returns the journal's entries in order when asked, and only its summary when not", async () => {
    const { graph } = createScriptedGraph(dossierOnly());
    const context = assessmentToolContext(graph);
    const first = { at: "2026-11-07T10:00:00.000Z", correlationId: "c-1", stage: "ID", operation: "folder_created" as const, target: ROOT, etagAfter: '"f1"' };
    const second = { at: "2026-11-07T10:00:05.000Z", correlationId: "c-2", stage: "DOSSIER", operation: "file_created" as const, target: `${ROOT}/Research/Acme Corp_Research_Dossier.md`, contentHash: "abc123" };
    await context.store.appendJournalEntry(PROFILE, ID, second);
    await context.store.appendJournalEntry(PROFILE, ID, first);

    const result = await runGetAssessment({ profileId: PROFILE, assessmentId: ID, include: ["journal"] }, context);

    const output = result.structuredContent as { journal: { entries: number }; journalEntries?: unknown[] };
    expect(output.journal.entries).toBe(2);
    expect(output.journalEntries).toEqual([first, second]);
    expect(resultText(result)).toContain(`Journal, oldest first: 2026-11-07T10:00:00.000Z ID folder_created ${ROOT}; 2026-11-07T10:00:05.000Z DOSSIER file_created ${ROOT}/Research/Acme Corp_Research_Dossier.md.`);
  });

  it("lists every assessment holding a status, across vendors, without reading the drive", async () => {
    const { graph, calls } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      {
        method: "get",
        pathIncludes: ["/lists/Assessments/items?", "Status eq 'In Progress'"],
        headersInclude: NON_INDEXED_QUERY_HEADER,
        response: page([listItem("2", PROBE_FIELDS), listItem("9", { ...PROBE_FIELDS, Title: "Globex", VendorFolder: "Globex", AssessmentId: "ASM-2026-00009" })]),
      },
    ]);

    const result = await runGetAssessment({ profileId: PROFILE, status: "in_progress" }, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as { found: boolean; assessments: Array<Record<string, unknown>>; graphRequests: number };
    expect(output.found).toBe(true);
    expect(output.assessments.map((summary) => [summary.assessmentId, summary.vendor])).toEqual([
      ["ASM-2026-00002", "Acme Corp"],
      ["ASM-2026-00009", "Globex"],
    ]);
    expect(resultText(result)).toBe('2 assessments in Assessments with Status "In Progress": ASM-2026-00002 for Acme Corp (Security), ASM-2026-00009 for Globex (Security).');
    expect(calls.filter((call) => call.path.includes("/drives/drive-1/"))).toEqual([]);
    expect(calls.filter((call) => call.path.includes("/lists/Vendors/"))).toEqual([]);
  });

  it("reports a status no assessment holds as not found, naming the label it asked for", async () => {
    const { graph } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      { method: "get", pathIncludes: ["/lists/Assessments/items?", "Status eq 'Provisional'"], headersInclude: NON_INDEXED_QUERY_HEADER, response: page([]) },
    ]);

    const result = await runGetAssessment({ profileId: PROFILE, status: "provisional" }, assessmentToolContext(graph));

    expect((result.structuredContent as { found: boolean }).found).toBe(false);
    expect(resultText(result)).toBe('No item in list "Assessments" has Status "Provisional".');
  });

  it("stops a status listing at 200 assessments and says more exist, rather than paging until it fails", async () => {
    const items = (from: number): unknown[] =>
      Array.from({ length: 50 }, (_unused, index) => listItem(String(from + index), { ...PROBE_FIELDS, Status: "Completed", AssessmentId: `ASM-2026-${String(from + index).padStart(5, "0")}` }));
    const pageOf = (from: number, next: boolean): ScriptEntry => ({
      method: "get",
      pathIncludes: from === 1 ? ["/lists/Assessments/items?", "Status eq 'Completed'"] : `next-${from}`,
      headersInclude: NON_INDEXED_QUERY_HEADER,
      response: { value: items(from), ...(next ? { "@odata.nextLink": `https://graph.microsoft.com/v1.0/next-${from + 50}` } : {}) },
    });
    const { graph, calls } = createScriptedGraph([...RESOLVE_DRIVE_SCRIPT, pageOf(1, true), pageOf(51, true), pageOf(101, true), pageOf(151, true), pageOf(201, true)]);

    const result = await runGetAssessment({ profileId: PROFILE, status: "completed" }, assessmentToolContext(graph));

    const output = result.structuredContent as { assessments: unknown[]; truncated?: boolean };
    expect(output.assessments).toHaveLength(200);
    expect(output.truncated).toBe(true);
    expect(calls.filter((call) => call.path.includes("next-201"))).toEqual([]);
    expect(resultText(result)).toContain("The first 200 assessments in Assessments with Status \"Completed\", and more exist that were not read:");
  });

  it("does not call a listing that fit truncated", async () => {
    const { graph } = createScriptedGraph([
      ...RESOLVE_DRIVE_SCRIPT,
      { method: "get", pathIncludes: ["/lists/Assessments/items?", "Status eq 'Completed'"], headersInclude: NON_INDEXED_QUERY_HEADER, response: page([listItem("2", { ...PROBE_FIELDS, Status: "Completed" })]) },
    ]);

    const result = await runGetAssessment({ profileId: PROFILE, status: "completed" }, assessmentToolContext(graph));

    expect(result.structuredContent).not.toHaveProperty("truncated");
  });
});
