import { describe, expect, it } from "vitest";
import { sheetToGrid } from "../../src/workbook/sheet.js";

describe("sheet bounds", () => {
  it("refuses a cell reference past Excel's own sheet maximum", () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="XFE1"><v>1</v></c></row></sheetData></worksheet>';
    expect(() => sheetToGrid(sheet, [])).toThrow(/past the 16384 columns a worksheet can have/);
  });

  it("refuses a cell reference past Excel's own row maximum", () => {
    const sheet = '<worksheet><sheetData><row r="1048577"><c r="A1048577"><v>1</v></c></row></sheetData></worksheet>';
    expect(() => sheetToGrid(sheet, [])).toThrow(/past the 1048576 rows a worksheet can have/);
  });

  it("refuses a cell with no r attribute, rather than guessing its position", () => {
    const sheet = "<worksheet><sheetData><row r=\"1\"><c><v>1</v></c></row></sheetData></worksheet>";
    expect(() => sheetToGrid(sheet, [])).toThrow(/has no r attribute/);
  });

  it("refuses a requested range whose last row or column comes before its first", () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';
    expect(() =>
      sheetToGrid(sheet, [], { firstRow: 5, lastRow: 1, firstColumn: 1, lastColumn: 1 }),
    ).toThrow(/names no rectangle to read/);
  });
});
