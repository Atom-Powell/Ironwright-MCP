import type { CellValue } from "./cells.js";
import { attribute, parseSharedStrings } from "./cells.js";
import type { SheetBounds } from "./sheet.js";
import { columnLabelToIndex, sheetToGrid } from "./sheet.js";
import { readZipParts } from "./zip.js";
import { WorkbookFileError, WorkbookMappingError, WorkbookUnreadableError } from "./errors.js";

/**
 * Names a range the same way a profile's workbookMapping names one: either a
 * named table (which carries its own bounds) or a whole worksheet (read used
 * range to used range). The Graph Excel API this range was once read over is
 * gone; this module reads the same range out of downloaded workbook bytes
 * instead, so a caller describes what it wants the same way regardless of
 * which layer resolves it.
 */
export type WorkbookSource = { kind: "table" | "worksheet"; name: string };

const RELATIONSHIP_PATTERN = /<Relationship\b[^>]*\/>|<Relationship\b[^>]*>[\s\S]*?<\/Relationship>/g;
const SHEET_ENTRY_PATTERN = /<sheet\b[^>]*\/>|<sheet\b[^>]*>[\s\S]*?<\/sheet>/g;
const CALC_PR_PATTERN = /<calcPr\b[^>]*\/>|<calcPr\b[^>]*>/;
const TABLE_ROOT_PATTERN = /<table\b[^>]*>|<table\b[^>]*\/>/;

function describeSource(source: WorkbookSource): string {
  return source.kind === "table" ? `The table "${source.name}"` : `The worksheet "${source.name}"`;
}

/**
 * Neither part this is called for, xl/workbook.xml and
 * xl/_rels/workbook.xml.rels, is named by anything a profile configures, but
 * their absence is not the same kind of failure. xl/workbook.xml is the part
 * that makes an archive an xlsx workbook at all: a zip that lacks it could be
 * a truncated xlsx just as easily as a profile's workbookPath naming a file
 * that was never a workbook -- a .docx is a zip too -- and this code has not
 * opened anything that tells those two apart, so `onMissing: "unreadable"`
 * throws the kind that does not pick one. xl/_rels/workbook.xml.rels is only
 * ever requested after xl/workbook.xml above was already found and parsed,
 * so reaching that check means the archive is confirmed xlsx-shaped; its
 * absence there is the archive's own required parts being incomplete, which
 * is `onMissing: "fileError"`.
 */
function requirePart(
  parts: Map<string, string>,
  partName: string,
  neededFor: string,
  // Required, not defaulted: every call site must state what it knows about
  // the failure. A default reproduces the bug this parameter was added to
  // fix, where a silent classifier was assigned rather than stated. Future
  // callers that should classify a failure as indeterminate will silently
  // get the file-error default by omission, and the defect returns in a new
  // place. Required means the compiler enforces intent.
  onMissing: "fileError" | "unreadable",
): string {
  const part = parts.get(partName);
  if (part === undefined) {
    if (onMissing === "unreadable") {
      throw new WorkbookUnreadableError(`The workbook archive has no ${partName}, so it does not open as a workbook.`);
    }
    throw new WorkbookFileError(
      `The workbook archive has no ${partName}, which is needed for ${neededFor}. Either the file is not a ` +
        "well formed xlsx workbook, or the download was truncated.",
    );
  }
  return part;
}

/**
 * A relationship's Target is relative to the directory of the part that
 * carries the relationship, not to the package root. A workbook-level
 * relationship's target is relative to "xl/", and a worksheet-level one is
 * relative to "xl/worksheets/"; both are expressed here as the owning part's
 * own path, so one function resolves either.
 */
function resolveRelativeTarget(owningPartPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);

  const segments = owningPartPath.split("/");
  segments.pop();
  for (const piece of target.split("/")) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") segments.pop();
    else segments.push(piece);
  }
  return segments.join("/");
}

function parseRelationships(relsXml: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const match of relsXml.matchAll(RELATIONSHIP_PATTERN)) {
    const tag = match[0];
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (id !== undefined && target !== undefined) relationships.set(id, target);
  }
  return relationships;
}

function isFullCalcOnLoad(workbookXml: string): boolean {
  const calcPrTag = CALC_PR_PATTERN.exec(workbookXml)?.[0];
  if (calcPrTag === undefined) return false;
  const value = attribute(calcPrTag, "fullCalcOnLoad");
  return value === "1" || value === "true";
}

function findSheetRelationshipId(workbookXml: string, name: string): string | undefined {
  const sheetsSection = /<sheets>([\s\S]*?)<\/sheets>/.exec(workbookXml)?.[1] ?? "";
  for (const match of sheetsSection.matchAll(SHEET_ENTRY_PATTERN)) {
    const tag = match[0];
    const sheetName = attribute(tag, "name");
    const rId = attribute(tag, "r:id");
    if (sheetName !== undefined && rId !== undefined && sheetName.toLowerCase() === name.toLowerCase()) {
      return rId;
    }
  }
  return undefined;
}

function resolveWorksheet(
  parts: Map<string, string>,
  workbookXml: string,
  workbookRelsXml: string,
  source: WorkbookSource,
): { sheetXml: string; bounds: undefined } {
  const rId = findSheetRelationshipId(workbookXml, source.name);
  if (rId === undefined) {
    throw new WorkbookMappingError(
      `No worksheet named "${source.name}" was found in the workbook's sheet list. Either the profile's ` +
        "workbookMapping names a worksheet that was renamed or removed, or it should name a table instead.",
    );
  }

  const target = parseRelationships(workbookRelsXml).get(rId);
  if (target === undefined) {
    // The worksheet named here is real: it was just found by name in the
    // sheet list. What is broken is the workbook's own cross-reference from
    // that sheet entry to a relationship id, which no profile setting
    // controls.
    throw new WorkbookFileError(
      `The worksheet "${source.name}" points at relationship "${rId}", which xl/_rels/workbook.xml.rels does ` +
        "not define. The workbook's own internal relationships are inconsistent.",
    );
  }

  const partName = resolveRelativeTarget("xl/workbook.xml", target);
  const sheetXml = parts.get(partName);
  if (sheetXml === undefined) {
    throw new WorkbookFileError(
      `The worksheet "${source.name}" resolves to ${partName}, which is missing from the archive. The ` +
        "workbook's own internal relationships name a part the file does not actually contain.",
    );
  }

  return { sheetXml, bounds: undefined };
}

interface TableInfo {
  name: string;
  ref: string;
  partName: string;
}

function findTables(parts: Map<string, string>): TableInfo[] {
  const tables: TableInfo[] = [];
  for (const [partName, xml] of parts) {
    if (!/^xl\/tables\/[^/]+\.xml$/.test(partName)) continue;
    const tag = TABLE_ROOT_PATTERN.exec(xml)?.[0];
    if (tag === undefined) continue;
    const name = attribute(tag, "name");
    const ref = attribute(tag, "ref");
    if (name !== undefined && ref !== undefined) tables.push({ name, ref, partName });
  }
  return tables;
}

/**
 * A table's own part carries no back reference to its worksheet, only the
 * worksheet's rels carry a forward reference to the table. So the owner is
 * found by resolving every worksheet's own relationships and matching the one
 * that points at this table part, rather than by reading anything on the
 * table part itself.
 */
function findOwningWorksheetPart(parts: Map<string, string>, tablePartName: string): string | undefined {
  for (const [partName, xml] of parts) {
    if (!/^xl\/worksheets\/_rels\/[^/]+\.xml\.rels$/.test(partName)) continue;
    const owningWorksheetPart = partName.replace("_rels/", "").replace(/\.rels$/, "");
    for (const target of parseRelationships(xml).values()) {
      if (resolveRelativeTarget(owningWorksheetPart, target) === tablePartName) return owningWorksheetPart;
    }
  }
  return undefined;
}

function parseCellRef(cellRef: string, wholeRef: string, tableName: string): { row: number; column: number } {
  const match = /^([A-Za-z]+)([0-9]+)$/.exec(cellRef);
  if (!match) {
    // The table was found by the name the mapping gave; what is wrong is the
    // shape of its own ref attribute, which the profile never writes.
    throw new WorkbookFileError(
      `The table "${tableName}" has ref "${wholeRef}", which contains "${cellRef}", not a column letter ` +
        "followed by a row number. The table's range cannot be determined.",
    );
  }
  const [, letters, digits] = match;
  return { column: columnLabelToIndex(letters as string), row: Number(digits) };
}

function parseTableRange(ref: string, tableName: string): SheetBounds {
  const [startRef, endRef] = ref.split(":");
  if (startRef === undefined || endRef === undefined) {
    throw new WorkbookFileError(
      `The table "${tableName}" has ref "${ref}", which is not an "A1:D10" style range, so the rows and ` +
        "columns it covers cannot be determined.",
    );
  }
  const start = parseCellRef(startRef, ref, tableName);
  const end = parseCellRef(endRef, ref, tableName);
  return { firstRow: start.row, lastRow: end.row, firstColumn: start.column, lastColumn: end.column };
}

function resolveTable(
  parts: Map<string, string>,
  source: WorkbookSource,
): { sheetXml: string; bounds: SheetBounds } {
  const table = findTables(parts).find((candidate) => candidate.name.toLowerCase() === source.name.toLowerCase());
  if (table === undefined) {
    throw new WorkbookMappingError(
      `No table named "${source.name}" was found in the workbook. Either the profile's workbookMapping names ` +
        "a table that was renamed or removed, or it should name a worksheet instead.",
    );
  }

  const bounds = parseTableRange(table.ref, table.name);

  const owningWorksheetPart = findOwningWorksheetPart(parts, table.partName);
  if (owningWorksheetPart === undefined) {
    // The table itself was found by the name the mapping gave. What is
    // missing is the reverse link from some worksheet's own relationships
    // back to it, which is the archive's own internal wiring.
    throw new WorkbookFileError(
      `The table "${source.name}" is defined in ${table.partName}, but no worksheet's relationships point at ` +
        "that part, so which worksheet holds it cannot be determined.",
    );
  }

  const sheetXml = parts.get(owningWorksheetPart);
  if (sheetXml === undefined) {
    throw new WorkbookFileError(
      `The table "${source.name}" belongs to ${owningWorksheetPart}, which is missing from the archive. The ` +
        "workbook's own internal relationships name a part the file does not actually contain.",
    );
  }

  return { sheetXml, bounds };
}

/**
 * Reads a table's own range, or a worksheet's whole used range, out of xlsx
 * bytes already in memory. A table read passes its ref to sheetToGrid as
 * bounds; a worksheet read passes none, which is why its grid's column 0 is
 * always spreadsheet column A regardless of where data starts (see sheet.ts).
 * That asymmetry is safe here for the same reason it is safe in sheet.ts:
 * nothing in this module or its caller translates a grid column index back to
 * a spreadsheet column.
 */
export function parseWorkbookGrid(
  bytes: Uint8Array,
  source: WorkbookSource,
): { grid: CellValue[][]; rowOffset: number } {
  const parts = readZipParts(
    bytes,
    (name) =>
      name === "xl/workbook.xml" ||
      name === "xl/_rels/workbook.xml.rels" ||
      name === "xl/sharedStrings.xml" ||
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

  // Absent entirely, rather than an empty <sst/>, is ordinary for a workbook
  // whose text is all inline strings, so this is not a missing-part failure.
  const sharedStrings = parseSharedStrings(parts.get("xl/sharedStrings.xml") ?? "");

  const fullCalcOnLoad = isFullCalcOnLoad(workbookXml);

  const { sheetXml, bounds } =
    source.kind === "table"
      ? resolveTable(parts, source)
      : resolveWorksheet(parts, workbookXml, workbookRelsXml, source);

  const { grid, firstRow, hadFormula } = sheetToGrid(sheetXml, sharedStrings, bounds);

  // A workbook-wide condition, not a per-row one: reporting it as fifty
  // rejected rows would bury the fact that none of this range's cached values
  // are trustworthy, which is the same reasoning read.ts applies to a stale
  // mapping.
  if (fullCalcOnLoad && hadFormula) {
    throw new WorkbookMappingError(
      `${describeSource(source)} contains at least one formula, and the workbook is marked fullCalcOnLoad, which ` +
        "instructs Excel to recalculate every formula when it opens. The values saved in the file are therefore " +
        "not authoritative, and reading them would report compliance from numbers the workbook itself does not " +
        "stand behind. Open the workbook in Excel and save it, which writes current values, or point the " +
        "mapping at a range with no formulas.",
    );
  }

  return { grid, rowOffset: firstRow };
}
