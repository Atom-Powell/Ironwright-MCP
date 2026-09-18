import { describe, expect, it } from "vitest";
import { readWorkbookInventory } from "../../src/workbook/introspect.js";
import { buildWorkbook } from "./xlsx-fixture.js";

function workbookWithTwoSheets(): Uint8Array {
  return buildWorkbook({
    sheets: [
      { name: "Tracking", rowsXml: "", dimension: "A1:D12" },
      { name: "Notes", rowsXml: "", dimension: "A1:A3" },
    ],
  });
}

function workbookWithTable(): Uint8Array {
  return buildWorkbook({
    sheets: [{ name: "Tracking", rowsXml: "", dimension: "A1:D12" }],
    tables: [{ name: "ClientTable", ref: "A1:D12", sheetIndex: 0 }],
  });
}

function workbookWithHeaderlessTable(): Uint8Array {
  return buildWorkbook({
    sheets: [{ name: "Tracking", rowsXml: "", dimension: "A1:D12" }],
    tables: [{ name: "ClientTable", ref: "A1:D12", sheetIndex: 0, headerRowCount: "0" }],
  });
}

function workbookWithEmptySheet(): Uint8Array {
  return buildWorkbook({ sheets: [{ name: "Blank", rowsXml: "" }] });
}

describe("readWorkbookInventory", () => {
  it("lists every worksheet with its used range and size", () => {
    const inventory = readWorkbookInventory(workbookWithTwoSheets());

    expect(inventory.sheets).toEqual([
      { name: "Tracking", usedRange: "A1:D12", rows: 12, columns: 4 },
      { name: "Notes", usedRange: "A1:A3", rows: 3, columns: 1 },
    ]);
  });

  it("lists every table with its owning sheet, bounds and whether it declares a header row", () => {
    const inventory = readWorkbookInventory(workbookWithTable());

    expect(inventory.tables).toEqual([
      { name: "ClientTable", sheet: "Tracking", ref: "A1:D12", rows: 12, columns: 4, hasHeaderRow: true },
    ]);
  });

  it("reports a table declaring no header row as such rather than assuming one", () => {
    expect(readWorkbookInventory(workbookWithHeaderlessTable()).tables[0]?.hasHeaderRow).toBe(false);
  });

  it("reports a sheet with no cells as empty rather than failing", () => {
    expect(readWorkbookInventory(workbookWithEmptySheet()).sheets[0]).toEqual({ name: "Blank", rows: 0, columns: 0 });
  });

  it("builds no grid: a dimension far larger than any cell present does not throw the grid cell cap", () => {
    // sheetToGrid refuses to materialize a rectangle over MAX_GRID_CELLS.
    // A dimension this large would trip that cap if introspection built a
    // grid to measure the sheet; it does not, because the size here comes
    // straight from the declared ref.
    const bytes = buildWorkbook({
      sheets: [{ name: "Huge", rowsXml: "", dimension: "A1:XFD1048576" }],
    });

    const inventory = readWorkbookInventory(bytes);

    expect(inventory.sheets).toEqual([{ name: "Huge", usedRange: "A1:XFD1048576", rows: 1_048_576, columns: 16_384 }]);
  });
});
