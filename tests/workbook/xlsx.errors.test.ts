import { describe, expect, it } from "vitest";
import { parseWorkbookGrid } from "../../src/workbook/xlsx.js";
import { buildWorkbook } from "./xlsx-fixture.js";

describe("parseWorkbookGrid failures", () => {
  it("fails the whole read when fullCalcOnLoad is set and the range holds a formula", () => {
    const bytes = buildWorkbook({
      fullCalcOnLoad: "1",
      sheet: '<row r="1"><c r="A1"><f>NOW()</f><v>1</v></c></row>',
    });

    expect(() => parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" })).toThrow(
      /instructs Excel to recalculate every formula when it opens/,
    );
  });

  // "1" is the spelling Excel itself writes, and the case above already
  // covers it. A workbook produced by a non-Excel tool is both more likely to
  // spell the same instruction "true" and more likely to be the one whose
  // cached values genuinely are stale, so the other legal spelling gets its
  // own case rather than riding along on "1".
  it("fails the whole read when fullCalcOnLoad is spelled \"true\" and the range holds a formula", () => {
    const bytes = buildWorkbook({
      fullCalcOnLoad: "true",
      sheet: '<row r="1"><c r="A1"><f>NOW()</f><v>1</v></c></row>',
    });

    expect(() => parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" })).toThrow(
      /instructs Excel to recalculate every formula when it opens/,
    );
  });

  it("treats fullCalcOnLoad=\"0\" as not set, even with a formula in range", () => {
    const bytes = buildWorkbook({
      fullCalcOnLoad: "0",
      sheet: '<row r="1"><c r="A1"><f>NOW()</f><v>1</v></c></row>',
    });

    expect(parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" }).grid).toEqual([[1]]);
  });

  it("treats fullCalcOnLoad=\"false\" as not set, even with a formula in range", () => {
    const bytes = buildWorkbook({
      fullCalcOnLoad: "false",
      sheet: '<row r="1"><c r="A1"><f>NOW()</f><v>1</v></c></row>',
    });

    expect(parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" }).grid).toEqual([[1]]);
  });

  it("ignores fullCalcOnLoad when no cell in the range is a formula", () => {
    const bytes = buildWorkbook({
      fullCalcOnLoad: "1",
      sheet: '<row r="1"><c r="A1" t="inlineStr"><is><t>Client</t></is></c></row>',
    });

    expect(parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" }).grid).toEqual([["Client"]]);
  });

  // fullCalcOnLoad's other tests above all read an unbounded worksheet, where
  // "in range" and "on the sheet" are the same thing, so none of them can
  // catch hadFormula being computed before a bounds filter is applied rather
  // than after. A bounded table is the one shape where those two scopes
  // differ, so this is the only case that actually exercises the scoping.
  it("ignores a formula outside a table's own range even though the sheet is marked fullCalcOnLoad", () => {
    const bytes = buildWorkbook({
      fullCalcOnLoad: "1",
      sheets: [
        {
          name: "Sheet1",
          rowsXml:
            '<row r="1"><c r="A1"><f>NOW()</f><v>1</v></c><c r="B1" t="inlineStr"><is><t>Client</t></is></c></row>' +
            '<row r="2"><c r="B2" t="inlineStr"><is><t>CLIENTA</t></is></c></row>',
        },
      ],
      tables: [{ name: "ClientsOnly", ref: "B1:B2", sheetIndex: 0 }],
    });

    expect(parseWorkbookGrid(bytes, { kind: "table", name: "ClientsOnly" }).grid).toEqual([["Client"], ["CLIENTA"]]);
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

  it("refuses a workbook with no xl/workbook.xml at all", () => {
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
      omitParts: ["xl/workbook.xml"],
    });

    expect(() => parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" })).toThrow(/xl\/workbook\.xml/);
  });
});
