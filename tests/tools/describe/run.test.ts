import { describe, expect, it } from "vitest";
import { resolveSourceOrExplain, runDescribeWorkbook } from "../../../src/tools/describe/run.js";
import { createFakeToolContext, createFakeWorkbookGraphClient } from "../../tools/fake-context.js";
import { buildWorkbook } from "../../workbook/xlsx-fixture.js";
import type { ToolContext } from "../../../src/tools/context.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DescribeToolOutput } from "../../../src/tools/describe/output.js";

/**
 * The text block's whole sentence, narrowed out of the content union rather
 * than read through JSON.stringify: a whole-sentence assertion against an
 * escaped JSON string is fragile in a way this project's own message-audit
 * discipline warns against, since a reader has to mentally unescape it to
 * check the assertion is testing what it claims to.
 */
function firstText(result: CallToolResult): string {
  const block = result.content[0];
  return block !== undefined && "text" in block ? block.text : "";
}

/**
 * "Tracking" holds a two-column table, ClientTable, whose default
 * headerRowCount (absent, meaning 1) makes its header row determinate, and a
 * second sheet "Notes" with no table, so inventory mode has two sheets and
 * one table to report. Document order, Tracking then Notes, matters: it is
 * what inventory mode is expected to preserve rather than re-sort.
 */
function bookWorkbook(): Uint8Array {
  return buildWorkbook({
    sheets: [
      {
        name: "Tracking",
        dimension: "A1:B3",
        rowsXml:
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>3</v></c></row>' +
          '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>1</v></c></row>',
      },
      { name: "Notes", dimension: "A1:A1", rowsXml: "" },
    ],
    sharedStrings: ["Client", "Owed", "CLIENTA", "CLIENTB"],
    tables: [{ name: "ClientTable", ref: "A1:B3", sheetIndex: 0 }],
  });
}

/**
 * A single worksheet, "Tracking", whose used range starts at A1 and holds a
 * formula in A2. The workbook is marked fullCalcOnLoad, so this range's
 * cached values are exactly the condition describe_workbook must not throw
 * on, unlike parseWorkbookGrid on the compliance path.
 */
function staleWorkbook(): Uint8Array {
  return buildWorkbook({
    fullCalcOnLoad: "1",
    sheets: [
      {
        name: "Tracking",
        dimension: "A1:B2",
        rowsXml:
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2"><f>1+1</f><v>2</v></c><c r="B2"><v>3</v></c></row>',
      },
    ],
    sharedStrings: ["Client", "Owed"],
  });
}

function makeContext(): ToolContext {
  return createFakeToolContext({
    graph: createFakeWorkbookGraphClient({
      library: "Documents",
      workbooksByPath: {
        "Trackers/Book.xlsx": bookWorkbook(),
        "Trackers/Stale.xlsx": staleWorkbook(),
      },
    }),
  });
}

describe("runDescribeWorkbook", () => {
  it("lists what the workbook contains when no source is given", async () => {
    const result = await runDescribeWorkbook({ library: "Documents", workbookPath: "Trackers/Book.xlsx" }, makeContext());

    const output = result.structuredContent as unknown as DescribeToolOutput;
    expect(result.isError).toBeFalsy();
    expect(output.mode).toBe("inventory");
    expect(output.sheets?.map((sheet) => sheet.name)).toEqual(["Tracking", "Notes"]);
    expect(output.tables?.map((table) => table.name)).toEqual(["ClientTable"]);
    expect(output.unresolved).toEqual([]);
    expect(output.columns).toBeUndefined();
  });

  it("reports the granted site and the moment it read, neither of which the caller supplies", async () => {
    // The tool takes no site argument, so the response is the only place a
    // caller learns which site this answer came from, and the workbook is
    // read live rather than out of a stored inventory, so the response is
    // also the only place the age of the answer exists at all.
    const result = await runDescribeWorkbook({ library: "Documents", workbookPath: "Trackers/Book.xlsx" }, makeContext());

    const output = result.structuredContent as unknown as DescribeToolOutput;
    expect(output.siteUrl).toBe("https://contoso.sharepoint.com/sites/Example");
    expect(output.readAt).toBe("2026-09-14T12:00:00.000Z");
  });

  it("describes one source when given", async () => {
    const result = await runDescribeWorkbook(
      { library: "Documents", workbookPath: "Trackers/Book.xlsx", source: { kind: "table", name: "ClientTable" } },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as unknown as DescribeToolOutput;
    expect(output.mode).toBe("source");
    expect(output.headerRow?.proposed).toBe(1);
    expect(output.columns?.[0]?.header).toBe("Client");
    expect(output.columns?.[1]?.header).toBe("Owed");
    expect(output.samplesWithheld).toBe(false);
    expect(output.columns?.[0]?.samples).toEqual(["CLIENTA", "CLIENTB"]);
  });

  it("declines a header row for a table that declares headerRowCount=\"0\", rather than guessing", async () => {
    const bytes = buildWorkbook({
      sheets: [
        {
          name: "Tracking",
          dimension: "A1:B2",
          rowsXml:
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>3</v></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1</v></c></row>',
        },
      ],
      sharedStrings: ["CLIENTA", "CLIENTB"],
      tables: [{ name: "HeaderlessTable", ref: "A1:B2", sheetIndex: 0, headerRowCount: "0" }],
    });

    const context = createFakeToolContext({
      graph: createFakeWorkbookGraphClient({ library: "Documents", workbooksByPath: { "Trackers/Headerless.xlsx": bytes } }),
    });

    const result = await runDescribeWorkbook(
      { library: "Documents", workbookPath: "Trackers/Headerless.xlsx", source: { kind: "table", name: "HeaderlessTable" } },
      context,
    );

    const output = result.structuredContent as unknown as DescribeToolOutput;
    expect(output.headerRow?.proposed).toBeUndefined();
    expect(output.headerRow?.declinedReason).toContain('headerRowCount="0"');
  });

  it("fails a source the workbook does not contain by listing what it does", async () => {
    const result = await runDescribeWorkbook(
      { library: "Documents", workbookPath: "Trackers/Book.xlsx", source: { kind: "table", name: "Nope" } },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    const text = firstText(result);
    // The whole message, not a substring check: the inner "no such name"
    // sentence plus available names, then describeToolFailure's own
    // no-profile attribution appended after it. Before this fix the inner
    // sentence was resolveWorkbookGrid's own profile-oriented one, prefixed
    // rather than replaced, so this same call produced a message that
    // argued with itself: "your profile's workbookMapping names this"
    // immediately followed by "not from a profile".
    expect(text).toBe(
      'No table named "Nope" was found in the workbook. The workbook contains worksheets "Tracking", "Notes" ' +
        "and tables \"ClientTable\". This came from the source named in this call's own arguments, not from a " +
        "profile.",
    );
    // The old message this replaced, gone entirely rather than merely
    // prefixed: both halves of the self-contradiction, not just the second.
    expect(text).not.toContain("renamed or removed");
    expect(text).not.toContain("workbookMapping");
  });

  it("replaces resolveWorkbookGrid's profile-oriented message rather than prefixing it, and mentions no profile at all", () => {
    // Unit level, bypassing describeToolFailure entirely: this is the one
    // sentence that must never mention a profile, since describeToolFailure's
    // own attribution sentence, appended afterward in the full pipeline, is
    // where the (correct) mention of "profile" belongs instead.
    let thrown: unknown;
    try {
      resolveSourceOrExplain(bookWorkbook(), { kind: "table", name: "Nope" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe(
      'No table named "Nope" was found in the workbook. The workbook contains worksheets "Tracking", "Notes" ' +
        'and tables "ClientTable".',
    );
    expect(message).not.toContain("profile");
  });

  it("degrades to the plain not-found message when the workbook has some other, unrelated problem readWorkbookInventory cannot read past", () => {
    // The workbook's only table has a malformed ref, unrelated to "Nope":
    // resolveTable fails to find "Nope" first (throwing the ordinary
    // WorkbookMappingError this catch handles), and then readWorkbookInventory,
    // called to build the correction, throws its own WorkbookFileError trying
    // to survey that same malformed table. The correction must give up rather
    // than lose the original "no such name" message under a second, unrelated
    // failure that never mentions "Nope" at all.
    const bytes = buildWorkbook({
      sheets: [{ name: "Tracking", dimension: "A1:B3", rowsXml: "" }],
      tables: [{ name: "Broken", ref: "not-a-range", sheetIndex: 0 }],
    });

    let thrown: unknown;
    try {
      resolveSourceOrExplain(bytes, { kind: "table", name: "Nope" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('No table named "Nope" was found in the workbook.');
  });

  it("withholds samples when the workbook says its formulas are stale", async () => {
    const result = await runDescribeWorkbook(
      { library: "Documents", workbookPath: "Trackers/Stale.xlsx", source: { kind: "worksheet", name: "Tracking" } },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as unknown as DescribeToolOutput;
    expect(output.samplesWithheld).toBe(true);
    expect(output.columns?.every((column) => column.samples.length === 0)).toBe(true);
    // Structure survives even though samples do not: this is the whole point
    // of withholding rather than refusing outright.
    expect(output.columns?.[0]?.header).toBe("Client");
  });

  it("reports the Graph cost it actually paid: one site lookup, one drive listing, one content download that costs two requests", async () => {
    const context = makeContext();
    const result = await runDescribeWorkbook({ library: "Documents", workbookPath: "Trackers/Book.xlsx" }, context);

    const output = result.structuredContent as unknown as DescribeToolOutput;
    // Pinned to the absolute figure this fake actually costs, not merely
    // compared against context.graph.requests(): a comparison against the
    // same counter the implementation itself reads moves both sides together
    // and would still pass if graphRequests reported the raw, unbracketed
    // counter instead of this call's own delta. Four, not three: the site
    // lookup and the drive listing are one request each, and the content
    // download is two, because the real client's getBytes counts both the
    // Graph request that answers with a redirect and the follow-up request to
    // the redirect target.
    expect(output.graphRequests).toBe(4);
    expect(context.graph.requests()).toBe(4);
  });

  it("reports this call's own cost on a context already used by an earlier call, not the process-lifetime total", async () => {
    // context.graph is built once per process and shared across every
    // per-request server, so its requests() counter accumulates for the
    // process's whole life. graphRequests must still report only what this
    // one call paid: a second call on the same context reporting the
    // cumulative total (8, not 4) is exactly the defect this test exists to
    // catch, and every other test in this file builds a fresh context per
    // call, so none of them could have caught it.
    const context = makeContext();
    await runDescribeWorkbook({ library: "Documents", workbookPath: "Trackers/Book.xlsx" }, context);
    const second = await runDescribeWorkbook({ library: "Documents", workbookPath: "Trackers/Book.xlsx" }, context);

    const output = second.structuredContent as unknown as DescribeToolOutput;
    expect(output.graphRequests).toBe(4);
    expect(context.graph.requests()).toBe(8);
  });

  it("does not claim total resolution when a table part carries a ref but no name, which findTables silently skips", async () => {
    // findTables in xlsx.ts requires both a name and a ref to report a table
    // part at all; a part with only a ref reaches neither the resolved
    // table list nor unresolved. That gap is recorded in
    // docs/OPEN-ITEMS.md and is not fixed here, deliberately: findTables is
    // on the compliance path too, and changing its return type is its own
    // change. What this test pins is that the prose stops claiming
    // otherwise: it must not say the workbook's whole declared set resolved
    // when a table this tool never even tracked is missing from both lists.
    const bytes = buildWorkbook({
      sheets: [{ name: "Tracking", dimension: "A1:C5", rowsXml: "" }],
      tables: [{ name: "Ghost", ref: "A1:C5", sheetIndex: 0, omitName: true }],
    });

    const context = createFakeToolContext({
      graph: createFakeWorkbookGraphClient({ library: "Documents", workbooksByPath: { "Trackers/Ghost.xlsx": bytes } }),
    });

    const result = await runDescribeWorkbook({ library: "Documents", workbookPath: "Trackers/Ghost.xlsx" }, context);

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as unknown as DescribeToolOutput;
    // The nameless table is genuinely invisible to this tool: neither
    // resolved nor reported as unresolved. That is the known gap.
    expect(output.tables).toEqual([]);
    expect(output.unresolved).toEqual([]);

    const text = firstText(result);
    expect(text).toContain(
      "Every worksheet and table this tool tracked resolved cleanly; none is reported as unresolved.",
    );
    expect(text).not.toContain("this workbook declares resolved cleanly");
  });

  it("returns isError with a library failure naming this call's own arguments rather than a profile", async () => {
    const context = createFakeToolContext({
      graph: createFakeWorkbookGraphClient({ library: "Documents", workbooksByPath: {} }),
    });

    const result = await runDescribeWorkbook({ library: "No Such Library", workbookPath: "Trackers/Book.xlsx" }, context);

    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain("No Such Library");
    expect(text).not.toContain("profile \"undefined\"");
  });
});
