import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWorkbookGrid } from "../../src/workbook/xlsx.js";
import { WorkbookFileError, WorkbookMappingError } from "../../src/workbook/errors.js";
import { buildWorkbook } from "./xlsx-fixture.js";

describe("parseWorkbookGrid failures", () => {
  it("fails the whole read when fullCalcOnLoad is set and the range holds a formula", () => {
    const bytes = buildWorkbook({
      fullCalcOnLoad: "1",
      sheet: '<row r="1"><c r="A1"><f>NOW()</f><v>1</v></c></row>',
    });

    const call = (): unknown => parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" });
    expect(call).toThrow(WorkbookMappingError);
    expect(call).toThrow(/instructs Excel to recalculate every formula when it opens/);
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

  it("refuses a worksheet name that is not in the workbook's sheet list, as a mapping failure", () => {
    // The archive itself is fine; the profile's workbookMapping names a
    // worksheet that is not there, which is squarely a mismatch between the
    // profile and an otherwise readable workbook.
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
    });

    const call = (): unknown => parseWorkbookGrid(bytes, { kind: "worksheet", name: "NoSuchSheet" });
    expect(call).toThrow(WorkbookMappingError);
    expect(call).toThrow(/No worksheet named "NoSuchSheet" was found/);
  });

  it("refuses a table name that is not in the workbook, as a mapping failure", () => {
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
      tables: [{ name: "RealTable", ref: "A1:A1", sheetIndex: 0 }],
    });

    const call = (): unknown => parseWorkbookGrid(bytes, { kind: "table", name: "NoSuchTable" });
    expect(call).toThrow(WorkbookMappingError);
    expect(call).toThrow(/No table named "NoSuchTable" was found/);
  });

  it("refuses a workbook missing a part its own resolution needs, as a file failure", () => {
    // No profile setting names xl/_rels/workbook.xml.rels; its absence is the
    // archive being incomplete, independent of what the profile asked for.
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
      omitParts: ["xl/_rels/workbook.xml.rels"],
    });

    const call = (): unknown => parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" });
    expect(call).toThrow(WorkbookFileError);
    expect(call).toThrow(/xl\/_rels\/workbook\.xml\.rels/);
  });

  it("refuses a workbook with no xl/workbook.xml at all, as a file failure", () => {
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
      omitParts: ["xl/workbook.xml"],
    });

    const call = (): unknown => parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" });
    expect(call).toThrow(WorkbookFileError);
    expect(call).toThrow(/xl\/workbook\.xml/);
  });

  it("refuses a worksheet whose relationship names a part the archive does not contain, as a file failure", () => {
    // The sheet is found by name, and its relationship id resolves, so the
    // profile's workbookMapping named exactly the right worksheet. What is
    // missing is the part that relationship points at, which is the
    // archive's own internal wiring rather than anything the profile chose.
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
      omitParts: ["xl/worksheets/sheet0.xml"],
    });

    const call = (): unknown => parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" });
    expect(call).toThrow(WorkbookFileError);
    expect(call).toThrow(/resolves to xl\/worksheets\/sheet0\.xml, which is missing from the archive/);
  });

  it("refuses a table whose declared ref is not an A1:D10 style range, as a file failure", () => {
    // The table is found by the name the mapping gave; what is broken is the
    // table's own ref attribute, which no profile setting writes.
    const bytes = buildWorkbook({
      sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
      tables: [{ name: "RealTable", ref: "NOTARANGE", sheetIndex: 0 }],
    });

    const call = (): unknown => parseWorkbookGrid(bytes, { kind: "table", name: "RealTable" });
    expect(call).toThrow(WorkbookFileError);
    expect(call).toThrow(/is not an "A1:D10" style range/);
  });

  describe("a table ref claiming an oversized range", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // The finding this covers: a table's declared ref is trusted on its
    // face, so "<table ref=\"A1:XFD1048576\"/>" in a workbook of a few
    // kilobytes must be refused the same way an actual corner-to-corner
    // sheet is, before anything sized to that ref is allocated. The fixture
    // workbook here carries one real cell; only the table's own ref claims
    // the huge range.
    it("is refused before the grid is allocated, not discovered by allocating it", () => {
      const spy = vi.spyOn(Array, "from");
      const bytes = buildWorkbook({
        sheets: [{ name: "Sheet1", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
        tables: [{ name: "Huge", ref: "A1:XFD1048576", sheetIndex: 0 }],
      });

      const call = (): unknown => parseWorkbookGrid(bytes, { kind: "table", name: "Huge" });

      expect(call).toThrow(WorkbookFileError);
      expect(call).toThrow(/1048576 rows by 16384 columns, 17179869184 cells/);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
