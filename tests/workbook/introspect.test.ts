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

function workbookWithBrokenSheet(): Uint8Array {
  // The sheet list declares "Broken" and the workbook rels resolve it to
  // sheet0.xml as usual; omitting that part is what breaks the archive,
  // the same missing-part condition parseWorkbookGrid's resolveWorksheet
  // raises for a mapped read.
  return buildWorkbook({
    sheets: [{ name: "Broken", rowsXml: "" }],
    omitParts: ["xl/worksheets/sheet0.xml"],
  });
}

function workbookWithUnresolvableTable(): Uint8Array {
  // The table part itself is present, so findTables still finds "Orphan";
  // omitting the owning worksheet's own rels part is what breaks the
  // reverse link findOwningWorksheetPart depends on.
  return buildWorkbook({
    sheets: [{ name: "Tracking", rowsXml: "", dimension: "A1:D12" }],
    tables: [{ name: "Orphan", ref: "A1:D12", sheetIndex: 0 }],
    omitParts: ["xl/worksheets/_rels/sheet0.xml.rels"],
  });
}

function workbookWithDanglingSheetRelationship(): Uint8Array {
  // Both sheets are declared and both worksheet parts are written; only
  // "Detached"'s own <Relationship> is left out of the workbook rels, so its
  // r:id dangles. This is the shape resolveWorksheet in xlsx.ts raises a
  // WorkbookFileError for on the compliance path.
  return buildWorkbook({
    sheets: [
      { name: "Tracking", rowsXml: "", dimension: "A1:D12" },
      { name: "Detached", rowsXml: "", dimension: "A1:B5", rId: "rIdMissing", omitRelationship: true },
    ],
  });
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

  it("normalizes a single-cell dimension ref, which carries no colon, into a one cell range", () => {
    const bytes = buildWorkbook({ sheets: [{ name: "OneCell", rowsXml: "", dimension: "B7" }] });

    const inventory = readWorkbookInventory(bytes);

    expect(inventory.sheets).toEqual([{ name: "OneCell", usedRange: "B7", rows: 1, columns: 1 }]);
  });

  it("records a table whose owning sheet cannot be resolved as unresolved rather than dropping it silently", () => {
    const inventory = readWorkbookInventory(workbookWithUnresolvableTable());

    expect(inventory.tables).toEqual([]);
    expect(inventory.unresolved).toEqual([
      {
        kind: "table",
        name: "Orphan",
        reason: expect.stringContaining("worksheet holds it cannot be determined") as string,
      },
    ]);
  });

  it("does not conflate a sheet whose part is missing with one that legitimately has no cells", () => {
    const emptyInventory = readWorkbookInventory(workbookWithEmptySheet());
    const brokenInventory = readWorkbookInventory(workbookWithBrokenSheet());

    expect(emptyInventory.sheets).toEqual([{ name: "Blank", rows: 0, columns: 0 }]);
    expect(emptyInventory.unresolved).toEqual([]);

    expect(brokenInventory.sheets).toEqual([]);
    expect(brokenInventory.unresolved).toEqual([
      { kind: "sheet", name: "Broken", reason: expect.stringContaining("missing from the archive") as string },
    ]);

    // The assertion the finding says would have caught this: an empty sheet
    // and a broken one must not compare equal, which a shared
    // { rows: 0, columns: 0 } shape for both would have let slip past every
    // other assertion above.
    expect(emptyInventory).not.toEqual(brokenInventory);
  });

  it("reports a declared sheet whose r:id the rels part does not define, naming the undefined id", () => {
    // The defect this covers: the entry reached neither `sheets` nor
    // `unresolved`, so the workbook came back one sheet shorter and the
    // prose layer then said every declared sheet had resolved cleanly.
    const inventory = readWorkbookInventory(workbookWithDanglingSheetRelationship());

    expect(inventory.sheets).toEqual([{ name: "Tracking", usedRange: "A1:D12", rows: 12, columns: 4 }]);
    expect(inventory.unresolved).toEqual([
      {
        kind: "sheet",
        name: "Detached",
        reason: 'points at relationship "rIdMissing", which xl/_rels/workbook.xml.rels does not define',
      },
    ]);
  });

  it("reports a sheet entry carrying no name under its position in the sheet list", () => {
    const inventory = readWorkbookInventory(
      buildWorkbook({
        sheets: [
          { name: "Tracking", rowsXml: "", dimension: "A1:D12" },
          { name: "Ignored", rowsXml: "", dimension: "A1:B5", omitName: true },
        ],
      }),
    );

    expect(inventory.sheets).toEqual([{ name: "Tracking", usedRange: "A1:D12", rows: 12, columns: 4 }]);
    expect(inventory.unresolved).toEqual([
      {
        kind: "sheet",
        name: "position 2 in the workbook's sheet list",
        reason: "carries no name attribute, so the workbook itself does not name it and nothing can address it by name",
      },
    ]);
  });

  it("reports a sheet entry carrying no r:id", () => {
    const inventory = readWorkbookInventory(
      buildWorkbook({
        sheets: [
          { name: "Tracking", rowsXml: "", dimension: "A1:D12" },
          { name: "Unlinked", rowsXml: "", dimension: "A1:B5", omitRelationshipId: true },
        ],
      }),
    );

    expect(inventory.sheets).toEqual([{ name: "Tracking", usedRange: "A1:D12", rows: 12, columns: 4 }]);
    expect(inventory.unresolved).toEqual([
      {
        kind: "sheet",
        name: "Unlinked",
        reason: "carries no r:id attribute, so the workbook states no link from it to the worksheet part that holds it",
      },
    ]);
  });

  it("does not tell a table that its declared owning sheet is undeclared", () => {
    // The second-order defect: sheetNameByPart was built from the truncated
    // sheet list, so a table owned by a sheet the workbook does declare was
    // told that sheet is not declared at all. That is correct about the
    // lookup and false about the file.
    const inventory = readWorkbookInventory(
      buildWorkbook({
        sheets: [
          { name: "Tracking", rowsXml: "", dimension: "A1:D12" },
          { name: "Detached", rowsXml: "", dimension: "A1:B5", rId: "rIdMissing", omitRelationship: true },
        ],
        tables: [{ name: "ClientTable", ref: "A1:B5", sheetIndex: 1 }],
      }),
    );

    expect(inventory.tables).toEqual([]);
    expect(inventory.unresolved).toEqual([
      {
        kind: "sheet",
        name: "Detached",
        reason: 'points at relationship "rIdMissing", which xl/_rels/workbook.xml.rels does not define',
      },
      {
        kind: "table",
        name: "ClientTable",
        reason:
          "belongs to worksheet part xl/worksheets/sheet1.xml, which none of the sheets this tool resolved " +
          "claims. The workbook declares 1 sheet entry this tool could not resolve, also reported here, so " +
          "whether that part is one of those or is claimed by no sheet entry at all cannot be determined until " +
          "they are fixed",
      },
    ]);
  });

  it("still says a table's owning part is undeclared when every declared sheet did resolve", () => {
    // Guards the branch above from swallowing the case it was split out of.
    // Here the worksheet part and its table rels exist but no <sheet> entry
    // names that part, so nothing was left unresolved and "not among the
    // workbook's declared sheets" is the true answer.
    const inventory = readWorkbookInventory(
      buildWorkbook({
        sheets: [
          { name: "Tracking", rowsXml: "", dimension: "A1:D12" },
          { name: "Hidden", rowsXml: "", dimension: "A1:B5", omitSheetListEntry: true },
        ],
        tables: [{ name: "ClientTable", ref: "A1:B5", sheetIndex: 1 }],
      }),
    );

    expect(inventory.tables).toEqual([]);
    expect(inventory.unresolved).toEqual([
      {
        kind: "table",
        name: "ClientTable",
        reason:
          "belongs to worksheet part xl/worksheets/sheet1.xml, which is not among the workbook's declared " +
          "sheets, so its sheet name cannot be determined",
      },
    ]);
  });
});
