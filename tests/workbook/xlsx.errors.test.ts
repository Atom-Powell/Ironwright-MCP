import { describe, expect, it } from "vitest";
import { parseWorkbookGrid } from "../../src/workbook/xlsx.js";
import { buildWorkbook } from "./xlsx-fixture.js";

describe("parseWorkbookGrid failures", () => {
  it("fails the whole read when fullCalcOnLoad is set and the range holds a formula", () => {
    const bytes = buildWorkbook({
      fullCalcOnLoad: true,
      sheet: '<row r="1"><c r="A1"><f>NOW()</f><v>1</v></c></row>',
    });

    expect(() => parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" })).toThrow(
      /instructs Excel to recalculate every formula when it opens/,
    );
  });

  it("ignores fullCalcOnLoad when no cell in the range is a formula", () => {
    const bytes = buildWorkbook({
      fullCalcOnLoad: true,
      sheet: '<row r="1"><c r="A1" t="inlineStr"><is><t>Client</t></is></c></row>',
    });

    expect(parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" }).grid).toEqual([["Client"]]);
  });

  it("refuses a worksheet name that is not in the workbook's sheet list", () => {
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
    });

    expect(() => parseWorkbookGrid(bytes, { kind: "worksheet", name: "NoSuchSheet" })).toThrow(
      /No worksheet named "NoSuchSheet" was found/,
    );
  });

  it("refuses a table name that is not in the workbook", () => {
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
      tables: [{ name: "RealTable", ref: "A1:A1", sheetIndex: 0 }],
    });

    expect(() => parseWorkbookGrid(bytes, { kind: "table", name: "NoSuchTable" })).toThrow(
      /No table named "NoSuchTable" was found/,
    );
  });

  it("refuses a workbook missing a part its own resolution needs", () => {
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
      omitParts: ["xl/_rels/workbook.xml.rels"],
    });

    expect(() => parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" })).toThrow(
      /xl\/_rels\/workbook\.xml\.rels/,
    );
  });
});
