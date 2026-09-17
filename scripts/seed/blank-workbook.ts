/**
 * The bytes of a workbook this module assembles from scratch: either the
 * empty single-sheet form (blankWorkbookBytes) or, with a grid and a table
 * name, a populated one whose rows and table the production parser
 * (src/workbook/xlsx.ts) can read back (seededWorkbookBytes). scripts/seed/
 * workbook.ts uploads the populated form with one content PUT; there is no
 * range write, table-add, or table-rename call after it, because the Graph
 * Excel API that those calls would have used refuses this server's app-only
 * tokens.
 *
 * Generated rather than committed as a binary so the artifact is reviewable in
 * a diff and testable, and so this repository stays text.
 *
 * Entries are stored rather than deflated: the parts total a few kilobytes, so
 * compression would buy nothing and add a second way to be wrong.
 */
import { crc32 } from "node:zlib";

/**
 * Shared by the blank workbook's own sheet element and by every range and
 * table call in scripts/seed/workbook.ts. One constant rather than a literal
 * in two places, because a disagreement between them would fail only against a
 * live tenant, where it costs a whole sitting to discover.
 */
export const SHEET_NAME = "Sheet1";

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const CONTENT_TYPES =
  `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  "</Types>";

const ROOT_RELS =
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>";

const WORKBOOK =
  `${XML_DECLARATION}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  `<sheets><sheet name="${SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS =
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  "</Relationships>";

const SHEET = `${XML_DECLARATION}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;

/**
 * A minimal style table. A workbook carrying no style table at all is the
 * kind of file most likely to be refused for a reason this project does not
 * own, so this part ships even though nothing written here asks for a
 * non-default style: the Onboarded column is written as ISO text rather than
 * a number carrying a date format, so no cellXfs entry beyond the default is
 * needed (see the comment on the Onboarded column conversion in
 * scripts/seed/workbook.ts). Two fills rather than one: the none/gray125 pair
 * is what every Excel-written file carries, and readers have been known to
 * assume it.
 */
const STYLES =
  `${XML_DECLARATION}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  "</styleSheet>";

interface Part {
  name: string;
  bytes: Uint8Array;
}

function parts(): Part[] {
  const encoder = new TextEncoder();
  return [
    { name: "[Content_Types].xml", bytes: encoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", bytes: encoder.encode(ROOT_RELS) },
    { name: "xl/workbook.xml", bytes: encoder.encode(WORKBOOK) },
    { name: "xl/_rels/workbook.xml.rels", bytes: encoder.encode(WORKBOOK_RELS) },
    { name: "xl/worksheets/sheet1.xml", bytes: encoder.encode(SHEET) },
    { name: "xl/styles.xml", bytes: encoder.encode(STYLES) },
  ];
}

// 1980-01-01 00:00 in DOS format. Fixed rather than read from the clock so the
// same seed produces the same bytes: a workbook whose contents differ run to
// run cannot be compared against anything.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * Assembles a set of parts into zip bytes. Shared by the empty and the
 * populated workbook, because the two differ only in which parts they carry,
 * never in how a part becomes a zip entry.
 */
function zipFromParts(entries: Part[]): Uint8Array {
  const encoder = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];

  for (const part of entries) {
    const name = encoder.encode(part.name);
    const crc = crc32(part.bytes) >>> 0;
    const offset = local.length;

    local.push(
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(0), // method 0: stored
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(part.bytes.length), // compressed size equals uncompressed when stored
      ...u32(part.bytes.length),
      ...u16(name.length),
      ...u16(0), // extra field length
      ...name,
      ...part.bytes,
    );

    central.push(
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0),
      ...u16(0),
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(part.bytes.length),
      ...u32(part.bytes.length),
      ...u16(name.length),
      ...u16(0), // extra
      ...u16(0), // comment
      ...u16(0), // disk number
      ...u16(0), // internal attributes
      ...u32(0), // external attributes
      ...u32(offset),
      ...name,
    );
  }

  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(0), // archive comment length
  ];

  return Uint8Array.from([...local, ...central, ...end]);
}

export function blankWorkbookBytes(): Uint8Array {
  return zipFromParts(parts());
}

// ---------------------------------------------------------------------------
// The populated form: a grid of rows written into xl/worksheets/sheet1.xml, a
// table defined over the grid's own used range in xl/tables/table1.xml, and
// the worksheet relationship and sheetData <tableParts> entry that connect
// the two. This is what scripts/seed/workbook.ts uploads in place of the
// blank form followed by a range write, a table add and a table rename: those
// three calls all went through the Graph Excel API's /workbook/ surface,
// which app-only tokens cannot reach, so the whole table now has to exist in
// the uploaded bytes rather than be built by a sequence of calls against them.
// ---------------------------------------------------------------------------

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";

const TABLE_PART_NAME = "xl/tables/table1.xml";
const WORKSHEET_RELS_PART_NAME = "xl/worksheets/_rels/sheet1.xml.rels";

const POPULATED_SHEET_RELATIONSHIP_ID = "rId1";

/** Escapes the three characters that are not literal inside XML element or attribute content. */
function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A 0 based column index read back as a spreadsheet column letter, so index 0 is "A". */
function columnLetter(index: number): string {
  let remaining = index + 1;
  let label = "";
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    label = String.fromCharCode(65 + digit) + label;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return label;
}

function cellXml(rowNumber: number, columnIndex: number, value: string | number): string {
  const ref = `${columnLetter(columnIndex)}${String(rowNumber)}`;
  // Every value seededWorkbookBytes actually receives is a string: workbook.ts
  // converts the Onboarded column's serial to ISO text before calling here
  // (see the comment there), and every other column is text already. The
  // numeric branch is kept so this function stays honest about the grid type
  // it declares it accepts, rather than silently assuming a caller never
  // passes a number.
  if (typeof value === "number") return `<c r="${ref}"><v>${String(value)}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXmlText(value)}</t></is></c>`;
}

function rowXml(rowNumber: number, cells: (string | number)[]): string {
  const cellsXml = cells.map((cell, columnIndex) => cellXml(rowNumber, columnIndex, cell)).join("");
  return `<row r="${String(rowNumber)}">${cellsXml}</row>`;
}

/** "A1:D14" for a 14 row, 4 column grid: the whole grid is the table's used range. */
function usedRangeRef(grid: (string | number)[][]): string {
  const firstRow = grid[0];
  if (grid.length === 0 || firstRow === undefined || firstRow.length === 0) {
    throw new Error("seededWorkbookBytes requires a grid with at least one header row and one column.");
  }
  return `A1:${columnLetter(firstRow.length - 1)}${String(grid.length)}`;
}

function populatedSheetXml(grid: (string | number)[][]): string {
  const rows = grid.map((cells, index) => rowXml(index + 1, cells)).join("");
  return (
    `${XML_DECLARATION}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheetData>${rows}</sheetData>` +
    `<tableParts count="1"><tablePart r:id="${POPULATED_SHEET_RELATIONSHIP_ID}"/></tableParts></worksheet>`
  );
}

function worksheetRelsXml(): string {
  return (
    `${XML_DECLARATION}<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">` +
    `<Relationship Id="${POPULATED_SHEET_RELATIONSHIP_ID}" Type="${NS_R}/table" Target="../tables/table1.xml"/>` +
    "</Relationships>"
  );
}

/**
 * tableColumns is required for the part to be a well formed table definition,
 * not merely a part the parser this project wrote happens to tolerate: a real
 * copy of Excel opening this file needs one <tableColumn> per header, in
 * order, or it treats the table as damaged. The header row (grid[0]) is that
 * list, because workbookGrid always writes it first.
 */
function tableXml(tableName: string, ref: string, headers: (string | number)[]): string {
  const columns = headers
    .map((header, index) => `<tableColumn id="${String(index + 1)}" name="${escapeXmlText(String(header))}"/>`)
    .join("");
  return (
    `${XML_DECLARATION}<table xmlns="${NS_MAIN}" id="1" name="${tableName}" displayName="${tableName}" ` +
    `ref="${ref}" totalsRowShown="0"><autoFilter ref="${ref}"/>` +
    `<tableColumns count="${String(headers.length)}">${columns}</tableColumns>` +
    '<tableStyleInfo showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>'
  );
}

function contentTypesXmlWithTable(): string {
  return CONTENT_TYPES.replace(
    "</Types>",
    `<Override PartName="/${TABLE_PART_NAME}" ` +
      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>',
  );
}

function populatedParts(grid: (string | number)[][], tableName: string): Part[] {
  const encoder = new TextEncoder();
  const ref = usedRangeRef(grid);
  const headers = grid[0] ?? [];

  return [
    { name: "[Content_Types].xml", bytes: encoder.encode(contentTypesXmlWithTable()) },
    { name: "_rels/.rels", bytes: encoder.encode(ROOT_RELS) },
    { name: "xl/workbook.xml", bytes: encoder.encode(WORKBOOK) },
    { name: "xl/_rels/workbook.xml.rels", bytes: encoder.encode(WORKBOOK_RELS) },
    { name: "xl/worksheets/sheet1.xml", bytes: encoder.encode(populatedSheetXml(grid)) },
    { name: WORKSHEET_RELS_PART_NAME, bytes: encoder.encode(worksheetRelsXml()) },
    { name: TABLE_PART_NAME, bytes: encoder.encode(tableXml(tableName, ref, headers)) },
    { name: "xl/styles.xml", bytes: encoder.encode(STYLES) },
  ];
}

/**
 * A populated, tabled workbook: the grid's rows in xl/worksheets/sheet1.xml,
 * a table named tableName defined over the grid's own used range in
 * xl/tables/table1.xml, and the worksheet relationship and <tableParts>
 * entry that connect the two. Every cell workbook.ts hands here is already
 * text, including the Onboarded column, which workbook.ts converts from an
 * Excel date serial to ISO text before calling in (see the comment there for
 * why).
 */
export function seededWorkbookBytes(grid: (string | number)[][], tableName: string): Uint8Array {
  return zipFromParts(populatedParts(grid, tableName));
}
