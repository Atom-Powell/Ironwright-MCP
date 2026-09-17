import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_GRID_CELLS, sheetToGrid } from "../../src/workbook/sheet.js";
import { WorkbookFileError } from "../../src/workbook/errors.js";

describe("sheet bounds", () => {
  // A restore here rather than only at the end of each area-cap test below,
  // so a spy set up by a failing assertion in one test cannot leak into the
  // next one and change what it measures.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a cell reference past Excel's own sheet maximum", () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="XFE1"><v>1</v></c></row></sheetData></worksheet>';
    const call = (): unknown => sheetToGrid(sheet, []);
    expect(call).toThrow(WorkbookFileError);
    expect(call).toThrow(/past the 16384 columns a worksheet can have/);
  });

  it("refuses a cell reference past Excel's own row maximum", () => {
    const sheet = '<worksheet><sheetData><row r="1048577"><c r="A1048577"><v>1</v></c></row></sheetData></worksheet>';
    const call = (): unknown => sheetToGrid(sheet, []);
    expect(call).toThrow(WorkbookFileError);
    expect(call).toThrow(/past the 1048576 rows a worksheet can have/);
  });

  it("refuses a cell with no r attribute, rather than guessing its position", () => {
    const sheet = "<worksheet><sheetData><row r=\"1\"><c><v>1</v></c></row></sheetData></worksheet>";
    const call = (): unknown => sheetToGrid(sheet, []);
    expect(call).toThrow(WorkbookFileError);
    expect(call).toThrow(/has no r attribute/);
  });

  it("refuses a requested range whose last row or column comes before its first", () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';
    const call = (): unknown => sheetToGrid(sheet, [], { firstRow: 5, lastRow: 1, firstColumn: 1, lastColumn: 1 });
    expect(call).toThrow(WorkbookFileError);
    expect(call).toThrow(/names no rectangle to read/);
  });

  it("refuses a requested range whose last row is past the sheet maximum", () => {
    // Reached through bounds itself, not through a cell reference: a caller
    // can ask for a range past the sheet maximum even when nothing on the
    // sheet does.
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';
    const call = (): unknown =>
      sheetToGrid(sheet, [], { firstRow: 1, lastRow: 1_048_577, firstColumn: 1, lastColumn: 1 });
    expect(call).toThrow(WorkbookFileError);
    expect(call).toThrow(/1048576 rows/);
  });

  it("refuses a requested range whose last column is past the sheet maximum", () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';
    const call = (): unknown =>
      sheetToGrid(sheet, [], { firstRow: 1, lastRow: 1, firstColumn: 1, lastColumn: 16_385 });
    expect(call).toThrow(WorkbookFileError);
    expect(call).toThrow(/16384 columns/);
  });

  describe("the area cap", () => {
    it("refuses a bounding box over the cap before allocating it, proven by never reaching Array.from", () => {
      // The exact reported failure mode: a cell at A1 and another at the real
      // corner XFD1048576. Each axis is individually within Excel's own max,
      // so neither per-axis cap above fires; only the product of the two,
      // 1,048,576 by 16,384, is what must be refused. Array.from is spied on
      // without a mock implementation, so if the cap did not fire first, the
      // real allocation this test exists to prevent would run.
      const spy = vi.spyOn(Array, "from");
      const sheet =
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1"><v>1</v></c></row>' +
        '<row r="1048576"><c r="XFD1048576"><v>2</v></c></row>' +
        "</sheetData></worksheet>";

      const call = (): unknown => sheetToGrid(sheet, []);

      expect(call).toThrow(WorkbookFileError);
      expect(call).toThrow(/1048576 rows by 16384 columns, 17179869184 cells/);
      expect(call).toThrow(new RegExp(`past the ${String(MAX_GRID_CELLS)} cell limit`));
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("refuses a bounded range over the cap before allocating it", () => {
      // The bounded path a table's declared ref reaches: bounds are trusted
      // on their face by the caller (src/workbook/xlsx.ts's parseTableRange),
      // so a ref claiming the same corner-to-corner box must be refused here
      // too, not only when the box comes from cells actually on the sheet.
      const spy = vi.spyOn(Array, "from");
      const sheet = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';

      const call = (): unknown =>
        sheetToGrid(sheet, [], { firstRow: 1, lastRow: 1_048_576, firstColumn: 1, lastColumn: 16_384 });

      expect(call).toThrow(WorkbookFileError);
      expect(call).toThrow(/past the/);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("allows a rectangle at exactly the cap", () => {
      // Pins the boundary as inclusive of the cap rather than exclusive: a
      // workbook whose range is exactly MAX_GRID_CELLS must still read, not
      // just one cell under it. 1,000,000 rows by 4 columns stays within
      // both per-axis sheet maximums while still landing exactly on
      // MAX_GRID_CELLS.
      const sheet = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';

      const result = sheetToGrid(sheet, [], { firstRow: 1, lastRow: 1_000_000, firstColumn: 1, lastColumn: 4 });

      expect(result.grid).toHaveLength(1_000_000);
    });
  });
});
