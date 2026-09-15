import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { blankWorkbookBytes, SHEET_NAME } from "../../../scripts/seed/blank-workbook.js";

/** Reads the ZIP central directory: entry names, CRCs, and the stored sizes. */
function readCentralDirectory(bytes: Uint8Array): { name: string; crc: number; size: number; offset: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  expect(eocd).toBeGreaterThanOrEqual(0);

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries: { name: string; crc: number; size: number; offset: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.push({ name, crc, size, offset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("blankWorkbookBytes", () => {
  it("carries the six parts an openable single-sheet workbook needs", () => {
    const entries = readCentralDirectory(blankWorkbookBytes());
    expect(entries.map((entry) => entry.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
      "xl/styles.xml",
    ]);
  });

  it("names the worksheet with the constant both halves share", () => {
    const text = new TextDecoder().decode(blankWorkbookBytes());
    expect(text).toContain(`name="${SHEET_NAME}"`);
  });

  it("records a CRC for every entry that matches the bytes stored for it", () => {
    const bytes = blankWorkbookBytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const entry of readCentralDirectory(bytes)) {
      // Local header: 30 fixed bytes, then the name, then the extra field.
      const nameLength = view.getUint16(entry.offset + 26, true);
      const extraLength = view.getUint16(entry.offset + 28, true);
      const start = entry.offset + 30 + nameLength + extraLength;
      const stored = bytes.subarray(start, start + entry.size);
      // Recomputed here rather than trusted: a CRC copied from the same
      // variable that wrote it would agree with itself and prove nothing.
      expect(entry.crc >>> 0).toBe(crc32(stored) >>> 0);
    }
  });

  it("is byte-identical across calls, so a re-seed cannot produce a different file", () => {
    expect(blankWorkbookBytes()).toEqual(blankWorkbookBytes());
  });
});

function crc32(input: Uint8Array): number {
  // node:zlib's own crc32, the same primitive the implementation uses. This is
  // a deliberate reuse: the test is checking that the right bytes were hashed
  // into the right entry, not reimplementing CRC32.
  return zlibCrc32(input);
}
