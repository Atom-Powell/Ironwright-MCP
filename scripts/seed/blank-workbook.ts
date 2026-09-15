/**
 * The bytes of an empty single-sheet workbook.
 *
 * Generated rather than committed as a binary so the artifact is reviewable in
 * a diff and testable, and so this repository stays text. The Excel API cannot
 * open a zero-byte file, and every call in scripts/seed/workbook.ts after the
 * upload requires Graph to open this as a workbook, so these bytes are the
 * precondition for all of it.
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
 * A minimal style table. Five parts make a workbook that opens; this sixth
 * exists because the Onboarded column is written with a date number format,
 * and a workbook carrying no style table at all is the case most likely to
 * make that call fail for a reason this project does not own. Two fills
 * rather than one: the none/gray125 pair is what every Excel-written file
 * carries, and readers have been known to assume it.
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

export function blankWorkbookBytes(): Uint8Array {
  const encoder = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const entries = parts();

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
