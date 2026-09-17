import { describe, expect, it } from "vitest";
import { UNEVALUABLE } from "../../src/workbook/cells.js";
import { parseWorkbookGrid } from "../../src/workbook/xlsx.js";
import { buildWorkbook } from "./xlsx-fixture.js";

describe("parseWorkbookGrid, resolving a range", () => {
  it("resolves a table by name at a sheet row offset and reports rowOffset", () => {
    const bytes = buildWorkbook({
      sheets: [
        {
          name: "Tracker",
          rowsXml:
            '<row r="10"><c r="B10" t="inlineStr"><is><t>Client</t></is></c></row>' +
            '<row r="11"><c r="B11" t="inlineStr"><is><t>CLIENTA</t></is></c></row>',
        },
      ],
      tables: [{ name: "ClientTable", ref: "B10:B11", sheetIndex: 0 }],
    });

    const result = parseWorkbookGrid(bytes, { kind: "table", name: "ClientTable" });

    expect(result.grid).toEqual([["Client"], ["CLIENTA"]]);
    expect(result.rowOffset).toBe(10);
  });

  it("resolves a worksheet by name over its whole used range", () => {
    const bytes = buildWorkbook({
      sheets: [
        {
          name: "Sheet1",
          rowsXml:
            '<row r="1"><c r="A1" t="inlineStr"><is><t>Client</t></is></c></row>' +
            '<row r="2"><c r="A2" t="inlineStr"><is><t>CLIENTA</t></is></c></row>',
        },
      ],
    });

    const result = parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" });

    expect(result.grid).toEqual([["Client"], ["CLIENTA"]]);
    expect(result.rowOffset).toBe(1);
  });

  it("matches a worksheet name without regard to case", () => {
    const bytes = buildWorkbook({
      sheets: [{ name: "Tracker", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
    });

    const result = parseWorkbookGrid(bytes, { kind: "worksheet", name: "TRACKER" });

    expect(result.grid).toEqual([[1]]);
  });

  it("matches a table name without regard to case", () => {
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
      tables: [{ name: "ClientTable", ref: "A1:A1", sheetIndex: 0 }],
    });

    const result = parseWorkbookGrid(bytes, { kind: "table", name: "clienttable" });

    expect(result.grid).toEqual([[1]]);
  });

  it("carries an UNEVALUABLE cell through into the returned grid rather than substituting a value", () => {
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1" t="e"><v>#N/A</v></c></row>' }],
    });

    const result = parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" });

    expect(result.grid).toEqual([[UNEVALUABLE]]);
  });

  it("reads every column a table's ref spans, not just its first", () => {
    const bytes = buildWorkbook({
      sheets: [
        {
          name: "Sheet1",
          rowsXml:
            '<row r="1">' +
            '<c r="A1" t="inlineStr"><is><t>Client</t></is></c>' +
            '<c r="B1" t="inlineStr"><is><t>Monthly</t></is></c>' +
            '<c r="C1" t="inlineStr"><is><t>Notes</t></is></c>' +
            "</row>",
        },
      ],
      tables: [{ name: "Wide", ref: "A1:C1", sheetIndex: 0 }],
    });

    const result = parseWorkbookGrid(bytes, { kind: "table", name: "Wide" });

    expect(result.grid).toEqual([["Client", "Monthly", "Notes"]]);
  });

  it("reads shared strings referenced from the resolved sheet", () => {
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' }],
      sharedStrings: ["CLIENTA"],
    });

    const result = parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" });

    expect(result.grid).toEqual([["CLIENTA"]]);
  });
});
