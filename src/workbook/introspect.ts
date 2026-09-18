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
 * The declared sheets this walk could resolve to a worksheet part, and the
 * declared sheets it could not, returned together.
 *
 * Together rather than as a resolved list alone, because the entries this
 * walk cannot resolve are the ones a survey most needs to report. A sheet
 * dropped here reached neither `sheets` nor `unresolved`, so the inventory
 * came back one sheet shorter with nothing said, and the prose layer then
 * stated that every declared sheet had resolved cleanly: a sentence correct
 * about the list it was handed and false about the workbook.
 */
interface SheetEntryScan {
  entries: SheetEntry[];
  unresolved: UnresolvedInventoryEntry[];
}

/**
 * Walks the <sheets> section of xl/workbook.xml and resolves each entry's
 * r:id to the worksheet part it names, the same resolution
 * findSheetRelationshipId and resolveWorksheet in xlsx.ts do one name at a
 * time. Done once, for every declared sheet, because both the sheet listing
 * below and the table-to-sheet-name lookup need it and neither should walk
 * it separately.
 *
 * Each of the three ways an entry fails to resolve is reported as its own
 * rejection with its own reason, rather than collapsed into one, because
 * they send an operator to different places: a missing name is a malformed
 * sheet entry, a missing r:id is a sheet entry that states no link at all,
 * and an r:id the rels part does not define is a broken cross-reference
 * between two parts that are each individually well formed. The last is the
 * same defect resolveWorksheet in xlsx.ts raises as a first-class
 * WorkbookFileError when a mapped read hits it, so a survey that swallowed
 * it would disagree with the compliance path about the same workbook.
 */
function listSheetEntries(workbookXml: string, workbookRelsXml: string): SheetEntryScan {
  const relationships = parseRelationships(workbookRelsXml);
  const sheetsSection = /<sheets>([\s\S]*?)<\/sheets>/.exec(workbookXml)?.[1] ?? "";

  const entries: SheetEntry[] = [];
  const unresolved: UnresolvedInventoryEntry[] = [];
  let position = 0;

  for (const match of sheetsSection.matchAll(SHEET_ENTRY_PATTERN)) {
    const tag = match[0];
    position += 1;
    const name = attribute(tag, "name");
    const rId = attribute(tag, "r:id");

    if (name === undefined) {
      // There is no name to report it under, so it is reported under the
      // only identifier the file gives it: where it sits in the sheet list.
      // Position is counted over every <sheet> entry seen, resolvable or
      // not, so it matches what an operator counts down the same XML.
      unresolved.push({
        kind: "sheet",
        name: `position ${String(position)} in the workbook's sheet list`,
        reason: "carries no name attribute, so the workbook itself does not name it and nothing can address it by name",
      });
      continue;
    }

    if (rId === undefined) {
      unresolved.push({
        kind: "sheet",
        name,
        reason: "carries no r:id attribute, so the workbook states no link from it to the worksheet part that holds it",
      });
      continue;
    }

    const target = relationships.get(rId);
    if (target === undefined) {
      unresolved.push({
        kind: "sheet",
        name,
        // The undefined id is named rather than described, because it is the
        // string an operator searches both parts for to find the break.
        reason: `points at relationship "${rId}", which xl/_rels/workbook.xml.rels does not define`,
      });
      continue;
    }

    entries.push({ name, partName: resolveRelativeTarget("xl/workbook.xml", target) });
  }

  return { entries, unresolved };
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
 * Why a table's owning worksheet could not be named, in terms of what was
 * actually observed rather than of one blanket explanation.
 *
 * The middle branch is the one that has to exist. When a declared sheet's
 * own r:id does not resolve, that sheet never gets a part name, so it is
 * absent from the part-to-name lookup a table's owner is found in, and the
 * "not among the workbook's declared sheets" reason would then be stated
 * about a sheet the workbook plainly does declare. That sentence is correct
 * about the lookup and false about the file, which is the defect this
 * module's rejection shape exists to prevent, and the two send an operator
 * to different places: one to a broken relationship between two parts, the
 * other to a worksheet part nothing in the workbook claims.
 *
 * `unresolvedSheetEntries` counts only sheet-list entries that never reached
 * a part name. A declared sheet whose part is merely missing from the
 * archive still resolves to a part name, so it is still in the lookup and
 * still names any table it owns.
 */
function unownedTableReason(
  tablePartName: string,
  owningWorksheetPart: string | undefined,
  unresolvedSheetEntries: number,
): string {
  if (owningWorksheetPart === undefined) {
    return (
      `is defined in ${tablePartName}, but no worksheet's relationships point at that part, so which ` +
      "worksheet holds it cannot be determined"
    );
  }

  if (unresolvedSheetEntries > 0) {
    return (
      `belongs to worksheet part ${owningWorksheetPart}, which none of the sheets this tool resolved claims. ` +
      `The workbook declares ${String(unresolvedSheetEntries)} sheet ` +
      `${unresolvedSheetEntries === 1 ? "entry" : "entries"} this tool could not resolve, also reported here, so ` +
      "whether that part is one of those or is claimed by no sheet entry at all cannot be determined until they " +
      "are fixed"
    );
  }

  return (
    `belongs to worksheet part ${owningWorksheetPart}, which is not among the workbook's declared ` +
    "sheets, so its sheet name cannot be determined"
  );
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

  const sheetScan = listSheetEntries(workbookXml, workbookRelsXml);
  const sheetEntries = sheetScan.entries;

  const sheets: SheetSummary[] = [];
  // Seeded with what the sheet-list walk itself could not resolve, so those
  // entries are carried onto the report in declaration order ahead of
  // anything found below rather than being left behind in the walk.
  const unresolved: UnresolvedInventoryEntry[] = [...sheetScan.unresolved];

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
      // two. Three different broken-wiring conditions land here, the same way
      // read.ts's own rejectedRows carries several distinct causes under one
      // reason field, and they are kept apart because they send an operator
      // to three different places.
      unresolved.push({
        kind: "table",
        name: table.name,
        reason: unownedTableReason(table.partName, owningWorksheetPart, sheetScan.unresolved.length),
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
