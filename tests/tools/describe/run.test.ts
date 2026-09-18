import { describe, expect, it } from "vitest";
import { runDescribeWorkbook } from "../../../src/tools/describe/run.js";
import { createFakeToolContext, createFakeWorkbookGraphClient } from "../../tools/fake-context.js";
import { buildWorkbook } from "../../workbook/xlsx-fixture.js";
import type { ToolContext } from "../../../src/tools/context.js";
import type { DescribeToolOutput } from "../../../src/tools/describe/output.js";

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
    const text = JSON.stringify(result.content);
    expect(text).toContain("Nope");
    expect(text).toContain("ClientTable");
    expect(text).toContain("Tracking");
    expect(text).toContain("Notes");
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

  it("reports the Graph cost it actually paid", async () => {
    const context = makeContext();
    const result = await runDescribeWorkbook({ library: "Documents", workbookPath: "Trackers/Book.xlsx" }, context);

    expect((result.structuredContent as unknown as DescribeToolOutput).graphRequests).toBe(context.graph.requests());
    expect(context.graph.requests()).toBeGreaterThan(0);
  });

  it("returns isError with a library failure naming this call's own arguments rather than a profile", async () => {
    const context = createFakeToolContext({
      graph: createFakeWorkbookGraphClient({ library: "Documents", workbooksByPath: {} }),
    });

    const result = await runDescribeWorkbook({ library: "No Such Library", workbookPath: "Trackers/Book.xlsx" }, context);

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("No Such Library");
    expect(text).not.toContain("profile \"undefined\"");
  });
});
