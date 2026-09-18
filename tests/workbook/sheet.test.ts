import { describe, expect, it } from "vitest";
import { columnIndexToLabel, columnLabelToIndex, sheetToGrid } from "../../src/workbook/sheet.js";
import { UNEVALUABLE } from "../../src/workbook/cells.js";

const SHEET = `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>CLIENTA</t></is></c><c r="B2"><v>1</v></c></row>
</sheetData></worksheet>`;

describe("sheetToGrid", () => {
  it("builds a grid from the cells present, filling gaps with null", () => {
    const result = sheetToGrid(SHEET, ["Client", "Monthly"]);
    expect(result.grid).toEqual([
      ["Client", "Monthly"],
      ["CLIENTA", 1],
    ]);
    expect(result.firstRow).toBe(1);
    expect(result.hadFormula).toBe(false);
  });

  it("extracts a bounded range and offsets it to the bounds origin", () => {
    const sheet = `<worksheet><sheetData>
<row r="11"><c r="A11" t="inlineStr"><is><t>ignored</t></is></c></row>
<row r="12"><c r="B12" t="inlineStr"><is><t>Client</t></is></c></row>
<row r="13"><c r="B13" t="inlineStr"><is><t>CLIENTA</t></is></c></row>
</sheetData></worksheet>`;

    const result = sheetToGrid(sheet, [], { firstRow: 12, lastRow: 13, firstColumn: 2, lastColumn: 2 });

    expect(result.grid).toEqual([["Client"], ["CLIENTA"]]);
    expect(result.firstRow).toBe(12);
  });

  it("reports a formula inside the range, and ignores one outside it", () => {
    const sheet = `<worksheet><sheetData>
<row r="1"><c r="A1"><f>NOW()</f><v>1</v></c></row>
<row r="2"><c r="B2" t="inlineStr"><is><t>Client</t></is></c></row>
</sheetData></worksheet>`;

    expect(sheetToGrid(sheet, []).hadFormula).toBe(true);
    expect(sheetToGrid(sheet, [], { firstRow: 2, lastRow: 2, firstColumn: 2, lastColumn: 2 }).hadFormula).toBe(false);
  });

  it("places cells by their own r attribute, not by their order in a sparse row", () => {
    // The row carries only A and C: a reader that assigned values by position
    // rather than by reference would put C's value into column B instead.
    const sheet = '<worksheet><sheetData><row r="1">' +
      '<c r="A1" t="inlineStr"><is><t>first</t></is></c>' +
      '<c r="C1" t="inlineStr"><is><t>third</t></is></c>' +
      "</row></sheetData></worksheet>";

    const result = sheetToGrid(sheet, []);

    expect(result.grid).toEqual([["first", null, "third"]]);
  });

  it("fills entirely absent rows with null when row numbers skip", () => {
    const sheet = '<worksheet><sheetData>' +
      '<row r="1"><c r="A1"><v>1</v></c></row>' +
      '<row r="5"><c r="A5"><v>5</v></c></row>' +
      "</sheetData></worksheet>";

    const result = sheetToGrid(sheet, []);

    expect(result.grid).toEqual([[1], [null], [null], [null], [5]]);
    expect(result.firstRow).toBe(1);
  });

  it("fills a bounded range with null when the sheet has no cells there at all", () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';

    const result = sheetToGrid(sheet, [], { firstRow: 20, lastRow: 21, firstColumn: 5, lastColumn: 6 });

    expect(result.grid).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(result.firstRow).toBe(20);
  });

  it("carries an unevaluable cell into the grid rather than flattening it", () => {
    const sheet = '<worksheet><sheetData><row r="1">' +
      '<c r="A1"><f>VLOOKUP(A2,Z:Z,1,0)</f></c>' +
      "</row></sheetData></worksheet>";

    const result = sheetToGrid(sheet, []);

    expect(result.grid[0]?.[0]).toBe(UNEVALUABLE);
  });

  it("ignores cols, mergeCells and dimension siblings of sheetData, and ignores the declared dimension", () => {
    // <col>, <cols>, <conditionalFormatting> and <dimension> all start with
    // the same "c" as a cell element, or sit right alongside one that does.
    // The word boundary in CELL_PATTERN is what keeps those from being read
    // as cells; this is the test proving it, not just the regex asserting
    // it. <dimension ref="A1:Z100"/> claims a 26 by 100 sheet the part does
    // not actually carry data for, which is what proves the grid's shape
    // comes from the cells present rather than from that declared range.
    const sheet = '<worksheet>' +
      '<dimension ref="A1:Z100"/>' +
      '<cols><col min="1" max="3" width="12"/></cols>' +
      '<sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Client</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>CLIENTA</t></is></c></row>' +
      '</sheetData>' +
      '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>' +
      '</worksheet>';

    const result = sheetToGrid(sheet, []);

    expect(result.grid).toEqual([["Client"], ["CLIENTA"]]);
    expect(result.firstRow).toBe(1);
  });

  it("places a self-closing cell by its own r attribute, not by falling through the whole tag", () => {
    // decodeCell's own open-tag pattern and this one must agree on where a
    // self-closing cell's open tag ends; this pins that readCells still
    // finds the r attribute correctly for the self-closing form, not just
    // the open/close form every other case here uses.
    const sheet =
      '<worksheet><sheetData><row r="2"><c r="A2"/><c r="B2" t="inlineStr"><is><t>Client</t></is></c></row>' +
      "</sheetData></worksheet>";

    const result = sheetToGrid(sheet, []);

    expect(result.grid).toEqual([[null, "Client"]]);
  });

  it("reads an empty worksheet as an empty grid", () => {
    const result = sheetToGrid("<worksheet><sheetData></sheetData></worksheet>", []);

    expect(result.grid).toEqual([]);
    expect(result.firstRow).toBe(1);
    expect(result.hadFormula).toBe(false);
  });
});

describe("columnLabelToIndex", () => {
  it("reads single and multi letter labels", () => {
    expect(columnLabelToIndex("A")).toBe(1);
    expect(columnLabelToIndex("Z")).toBe(26);
    expect(columnLabelToIndex("AA")).toBe(27);
  });
});

describe("columnIndexToLabel", () => {
  it("turns a one-based column index into its spreadsheet label", () => {
    expect(columnIndexToLabel(1)).toBe("A");
    expect(columnIndexToLabel(26)).toBe("Z");
    expect(columnIndexToLabel(27)).toBe("AA");
    expect(columnIndexToLabel(52)).toBe("AZ");
    expect(columnIndexToLabel(703)).toBe("AAA");
  });

  it("round trips against columnLabelToIndex", () => {
    for (const label of ["A", "Q", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]) {
      expect(columnIndexToLabel(columnLabelToIndex(label))).toBe(label);
    }
  });
});
