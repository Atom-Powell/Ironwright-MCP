import { describe, expect, it } from "vitest";
import { shapeDescribeInventory, shapeDescribeSource } from "../../../src/tools/describe/shape.js";
import type { WorkbookInventory } from "../../../src/workbook/introspect.js";
import type { ColumnDescription, HeaderDetection } from "../../../src/workbook/describe.js";
import type { DescribeProvenance } from "../../../src/tools/describe/shape.js";

const PROVENANCE: DescribeProvenance = {
  siteUrl: "https://contoso.sharepoint.com/sites/Example",
  library: "Documents",
  workbookPath: "Trackers/Book.xlsx",
  readAt: "2026-09-18T09:15:00.000Z",
};

const INVENTORY: WorkbookInventory = {
  sheets: [
    { name: "Tracking", usedRange: "A1:D12", rows: 12, columns: 4 },
    { name: "Notes", usedRange: "A1:A3", rows: 3, columns: 1 },
    { name: "Archive", usedRange: "A1:B5", rows: 5, columns: 2 },
  ],
  tables: [
    { name: "ClientTable", sheet: "Tracking", ref: "A1:D12", rows: 12, columns: 4, hasHeaderRow: true },
    { name: "AuditTable", sheet: "Archive", ref: "A1:B5", rows: 5, columns: 2, hasHeaderRow: false },
  ],
  unresolved: [{ kind: "table", name: "Orphan", reason: "no worksheet's relationships point at that part" }],
};

describe("shapeDescribeInventory", () => {
  it("reports exact totals over the complete set before either listing is cut", () => {
    const output = shapeDescribeInventory(PROVENANCE, INVENTORY, 3, {});

    expect(output.mode).toBe("inventory");
    expect(output.siteUrl).toBe("https://contoso.sharepoint.com/sites/Example");
    expect(output.library).toBe("Documents");
    expect(output.workbookPath).toBe("Trackers/Book.xlsx");
    expect(output.readAt).toBe("2026-09-18T09:15:00.000Z");
    expect(output.sheets).toEqual(INVENTORY.sheets);
    expect(output.tables).toEqual(INVENTORY.tables);
    expect(output.sheetsListing).toEqual({ returned: 3, omitted: 0, cap: 200, truncated: false });
    expect(output.tablesListing).toEqual({ returned: 2, omitted: 0, cap: 200, truncated: false });
    expect(output.unresolved).toEqual(INVENTORY.unresolved);
    expect(output.samplesWithheld).toBe(false);
    expect(output.graphRequests).toBe(3);
    expect(output.columns).toBeUndefined();
  });

  it("preserves the workbook's own declared order rather than sorting", () => {
    const output = shapeDescribeInventory(PROVENANCE, INVENTORY, 1, {});

    expect(output.sheets?.map((sheet) => sheet.name)).toEqual(["Tracking", "Notes", "Archive"]);
  });

  it("cuts the sheet listing at the cap, keeping the total exact", () => {
    const output = shapeDescribeInventory(PROVENANCE, INVENTORY, 1, { maxSheets: 2 });

    expect(output.sheets).toHaveLength(2);
    expect(output.sheetsListing).toEqual({ returned: 2, omitted: 1, cap: 2, truncated: true });
    // The table listing is unaffected by the sheet cap: the two truncation
    // rules are independent, matching the caps' own independence.
    expect(output.tablesListing?.truncated).toBe(false);
  });

  it("cuts the table listing at the cap, keeping the total exact", () => {
    const output = shapeDescribeInventory(PROVENANCE, INVENTORY, 1, { maxTables: 1 });

    expect(output.tables).toHaveLength(1);
    expect(output.tablesListing).toEqual({ returned: 1, omitted: 1, cap: 1, truncated: true });
  });

  it("never caps the unresolved list, regardless of the sheet or table caps", () => {
    const output = shapeDescribeInventory(PROVENANCE, INVENTORY, 1, { maxSheets: 1, maxTables: 1 });

    expect(output.unresolved).toEqual(INVENTORY.unresolved);
  });

  it("reports an empty unresolved list rather than omitting the field, when nothing was unresolved", () => {
    const clean: WorkbookInventory = { ...INVENTORY, unresolved: [] };
    const output = shapeDescribeInventory(PROVENANCE, clean, 1, {});

    expect(output.unresolved).toEqual([]);
  });
});

const COLUMNS: ColumnDescription[] = [
  {
    position: 1,
    columnLabel: "A",
    header: "Client",
    headerUnevaluable: false,
    inferredType: "string",
    nonEmptyCount: 2,
    unevaluableCount: 0,
    distinctCount: 2,
    samples: ["CLIENTA", "CLIENTB"],
    samplesOmitted: 0,
  },
  {
    position: 2,
    columnLabel: "B",
    header: "Owed",
    headerUnevaluable: false,
    inferredType: "number",
    nonEmptyCount: 2,
    unevaluableCount: 0,
    distinctCount: 2,
    samples: ["3", "1"],
    samplesOmitted: 0,
  },
  {
    position: 3,
    columnLabel: "C",
    header: "Active",
    headerUnevaluable: false,
    inferredType: "boolean",
    nonEmptyCount: 2,
    unevaluableCount: 0,
    distinctCount: 2,
    samples: ["true", "false"],
    samplesOmitted: 0,
  },
];

const HEADER_ROW: HeaderDetection = { proposed: 1, candidates: [{ row: 1, distinctLabels: 3, reason: "distinct text" }] };

describe("shapeDescribeSource", () => {
  it("reports exact column totals before the listing is cut", () => {
    const output = shapeDescribeSource(
      PROVENANCE,
      { kind: "table", name: "ClientTable" },
      { columns: COLUMNS, headerRow: HEADER_ROW, samplesWithheld: false, sampleCap: 5 },
      4,
      {},
    );

    expect(output.mode).toBe("source");
    // Source mode carries the same provenance inventory mode does: nothing
    // else in a describe response names the site this answer came from.
    expect(output.siteUrl).toBe("https://contoso.sharepoint.com/sites/Example");
    expect(output.readAt).toBe("2026-09-18T09:15:00.000Z");
    expect(output.source).toEqual({ kind: "table", name: "ClientTable" });
    expect(output.headerRow).toEqual(HEADER_ROW);
    expect(output.columns).toEqual(COLUMNS);
    expect(output.columnsListing).toEqual({ returned: 3, omitted: 0, cap: 100, truncated: false });
    expect(output.sampleCap).toBe(5);
    expect(output.samplesWithheld).toBe(false);
    expect(output.graphRequests).toBe(4);
    expect(output.sheets).toBeUndefined();
  });

  it("cuts the column listing at the cap, keeping the total exact", () => {
    const output = shapeDescribeSource(
      PROVENANCE,
      { kind: "table", name: "ClientTable" },
      { columns: COLUMNS, headerRow: HEADER_ROW, samplesWithheld: false, sampleCap: 5 },
      4,
      { maxColumns: 2 },
    );

    expect(output.columns).toHaveLength(2);
    expect(output.columnsListing).toEqual({ returned: 2, omitted: 1, cap: 2, truncated: true });
  });

  it("passes samplesWithheld through unchanged", () => {
    const output = shapeDescribeSource(
      PROVENANCE,
      { kind: "worksheet", name: "Tracking" },
      { columns: COLUMNS, headerRow: HEADER_ROW, samplesWithheld: true, sampleCap: 5 },
      2,
      {},
    );

    expect(output.samplesWithheld).toBe(true);
  });

  it("passes sampleCap through unchanged, whatever describeColumns actually applied", () => {
    const output = shapeDescribeSource(
      PROVENANCE,
      { kind: "table", name: "ClientTable" },
      { columns: COLUMNS, headerRow: HEADER_ROW, samplesWithheld: false, sampleCap: 3 },
      1,
      {},
    );

    expect(output.sampleCap).toBe(3);
  });
});
