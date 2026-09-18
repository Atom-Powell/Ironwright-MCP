import { attribute } from "./cells.js";
import type { SheetBounds } from "./sheet.js";
import {
  findOwningWorksheetPart,
  findTables,
  parseRangeRef,
  parseRelationships,
  requirePart,
  resolveRelativeTarget,
  SHEET_ENTRY_PATTERN,
} from "./xlsx.js";
import { readZipParts } from "./zip.js";

export interface SheetSummary {
  name: string;
  usedRange?: string;
  rows: number;
  columns: number;
}

export interface TableSummary {
  name: string;
  sheet: string;
  ref: string;
  rows: number;
  columns: number;
  hasHeaderRow: boolean;
}

/**
 * A sheet the workbook's own sheet list declared, or a table findTables
 * found, whose owning part or owning sheet could not be resolved. Carried
 * here rather than silently left out of `sheets` or `tables`, the same
 * reason `read.ts` carries a row it could not turn into a `ClientRecord`
 * into `rejectedRows` instead of just skipping it: a thing that was
 * observed to exist and then could not be read must be surfaced, never
 * swallowed, or a caller cannot tell a workbook that truly has two tables
 * from one that has three where one could not be resolved.
 */
export interface UnresolvedInventoryEntry {
  /** What kind of thing this was. */
  kind: "sheet" | "table";
  /** The name the workbook itself gives it. */
  name: string;
  /** Why it could not be resolved, in terms an operator can act on. */
  reason: string;
}

export interface WorkbookInventory {
  sheets: SheetSummary[];
  tables: TableSummary[];
  unresolved: UnresolvedInventoryEntry[];
}

const DIMENSION_PATTERN = /<dimension\b[^>]*\/>|<dimension\b[^>]*>/;

interface SheetEntry {
  name: string;
  partName: string;
}

/**
 * Walks the <sheets> section of xl/workbook.xml and resolves each entry's
 * r:id to the worksheet part it names, the same resolution
 * findSheetRelationshipId and resolveWorksheet in xlsx.ts do one name at a
 * time. Done once, for every declared sheet, because both the sheet listing
 * below and the table-to-sheet-name lookup need it and neither should walk
 * it separately.
 */
function listSheetEntries(parts: Map<string, string>, workbookXml: string, workbookRelsXml: string): SheetEntry[] {
  const relationships = parseRelationships(workbookRelsXml);
  const sheetsSection = /<sheets>([\s\S]*?)<\/sheets>/.exec(workbookXml)?.[1] ?? "";

  const entries: SheetEntry[] = [];
  for (const match of sheetsSection.matchAll(SHEET_ENTRY_PATTERN)) {
    const tag = match[0];
    const name = attribute(tag, "name");
    const rId = attribute(tag, "r:id");
    if (name === undefined || rId === undefined) continue;

    const target = relationships.get(rId);
    if (target === undefined) continue;

    entries.push({ name, partName: resolveRelativeTarget("xl/workbook.xml", target) });
  }
  return entries;
}

/**
 * A worksheet part's size comes from its own <dimension ref="..."> element,
 * never from building a grid to measure one: a grid built per sheet just to
 * learn its size is the cost inventory mode exists to avoid, on a workbook
 * that can hold many large sheets. A part with no <dimension> element, or
 * one this function cannot read a ref out of, reports no used range and
 * zero size rather than a guess, the same as an unreadable mapped cell
 * surfaces as a rejection rather than a substituted value.
 */
function describeUsedRange(sheetXml: string, subject: string): { usedRange?: string; rows: number; columns: number } {
  const dimensionTag = DIMENSION_PATTERN.exec(sheetXml)?.[0];
  const ref = dimensionTag === undefined ? undefined : attribute(dimensionTag, "ref");
  if (ref === undefined) return { rows: 0, columns: 0 };

  // A dimension naming exactly one used cell, such as ref="A1", is a single
  // reference rather than an "A1:D10" range; parseRangeRef only accepts the
  // range shape, so a single-cell dimension is normalized to a one cell
  // range before parsing rather than taught to parseRangeRef as a second
  // shape it must accept.
  const rangeRef = ref.includes(":") ? ref : `${ref}:${ref}`;
  const bounds: SheetBounds = parseRangeRef(rangeRef, subject);

  return {
    usedRange: ref,
    rows: bounds.lastRow - bounds.firstRow + 1,
    columns: bounds.lastColumn - bounds.firstColumn + 1,
  };
}

/**
 * Enumerates a workbook's worksheets and tables, with their bounds, without
 * materializing a cell grid for any of them. Sizes come entirely from each
 * worksheet part's own declared <dimension> and each table part's own
 * declared ref, the same parts parseWorkbookGrid reads to resolve a mapped
 * range, read here for their shape rather than their cell contents.
 *
 * A sheet or table whose own internal wiring cannot be resolved is never
 * silently left out of `sheets` or `tables`; it is reported in `unresolved`
 * instead, so this survey never returns a shorter, confident-looking list
 * with no trace of what it could not read.
 */
export function readWorkbookInventory(bytes: Uint8Array): WorkbookInventory {
  const parts = readZipParts(
    bytes,
    (name) =>
      name === "xl/workbook.xml" ||
      name === "xl/_rels/workbook.xml.rels" ||
      name.startsWith("xl/worksheets/") ||
      name.startsWith("xl/tables/"),
  );

  const workbookXml = requirePart(parts, "xl/workbook.xml", "resolving any sheet or table by name", "unreadable");
  const workbookRelsXml = requirePart(
    parts,
    "xl/_rels/workbook.xml.rels",
    "mapping a sheet's r:id to the worksheet part that holds it",
    "fileError",
  );

  const sheetEntries = listSheetEntries(parts, workbookXml, workbookRelsXml);

  const sheets: SheetSummary[] = [];
  const unresolved: UnresolvedInventoryEntry[] = [];

  for (const entry of sheetEntries) {
    const sheetXml = parts.get(entry.partName);
    if (sheetXml === undefined) {
      // The workbook's own sheet list names a part parseWorkbookGrid would
      // also fail to find, the same broken-wiring condition resolveWorksheet
      // in xlsx.ts raises for a mapped worksheet read. Recorded as unresolved
      // rather than reported as a zero-size sheet: a sheet that genuinely
      // has no cells and a sheet whose part cannot be found are different
      // facts, and { rows: 0, columns: 0 } for both is the exact conflation
      // the rejection precedent this function follows exists to prevent.
      unresolved.push({
        kind: "sheet",
        name: entry.name,
        reason: `resolves to ${entry.partName}, which is missing from the archive`,
      });
      continue;
    }

    sheets.push({ name: entry.name, ...describeUsedRange(sheetXml, `The worksheet "${entry.name}"`) });
  }

  const sheetNameByPart = new Map(sheetEntries.map((entry) => [entry.partName, entry.name]));

  const tables: TableSummary[] = [];
  for (const table of findTables(parts)) {
    const owningWorksheetPart = findOwningWorksheetPart(parts, table.partName);
    const sheetName = owningWorksheetPart === undefined ? undefined : sheetNameByPart.get(owningWorksheetPart);

    if (sheetName === undefined) {
      // findTables already observed this table exists, so it is recorded as
      // unresolved rather than left out of `tables` with no trace: dropping
      // it silently is exactly what would make a workbook with three tables,
      // one of them broken, indistinguishable from one that only ever had
      // two. Two different broken-wiring conditions land here, the same way
      // read.ts's own rejectedRows carries several distinct causes under one
      // reason field: no worksheet's relationships point at the table part
      // at all, or they do but that worksheet is not among the workbook's
      // own declared sheets.
      unresolved.push({
        kind: "table",
        name: table.name,
        reason:
          owningWorksheetPart === undefined
            ? `is defined in ${table.partName}, but no worksheet's relationships point at that part, so which ` +
              "worksheet holds it cannot be determined"
            : `belongs to worksheet part ${owningWorksheetPart}, which is not among the workbook's declared ` +
              "sheets, so its sheet name cannot be determined",
      });
      continue;
    }

    const bounds = parseRangeRef(table.ref, `The table "${table.name}"`);
    tables.push({
      name: table.name,
      sheet: sheetName,
      ref: table.ref,
      rows: bounds.lastRow - bounds.firstRow + 1,
      columns: bounds.lastColumn - bounds.firstColumn + 1,
      // Absent headerRowCount means 1, the OOXML default: a table with no
      // opinion stated still has a header row, so absence must read as
      // "true" rather than as "unknown".
      hasHeaderRow: table.headerRowCount !== "0",
    });
  }

  return { sheets, tables, unresolved };
}
