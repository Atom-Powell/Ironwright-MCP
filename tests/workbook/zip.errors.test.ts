import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { readZipParts, MAX_INFLATED_BYTES, ArchiveSizeExceededError } from "../../src/workbook/zip.js";
import { WorkbookUnreadableError } from "../../src/workbook/errors.js";

describe("readZipParts failures", () => {
  it("refuses bytes that are not a zip, as neither a mapping nor a file failure, since it cannot tell which applies", () => {
    // A profile's own workbookPath naming a file that was never a workbook
    // and a workbook download truncated in transit both produce exactly this
    // symptom, and this function has no way to tell them apart from the
    // bytes alone.
    const call = (): unknown => readZipParts(new Uint8Array([1, 2, 3, 4]), () => true);

    expect(call).toThrow(WorkbookUnreadableError);
    expect(call).toThrow(/is not a zip archive, so it is not an xlsx workbook/);
  });

  it("refuses an archive whose declared inflated size exceeds the cap", () => {
    const bytes = zipSync({ "xl/workbook.xml": strToU8("<workbook/>") });
    expect(() => readZipParts(bytes, () => true, { maxInflatedBytes: 4 })).toThrow(
      /declares .* bytes of uncompressed content/,
    );
    expect(MAX_INFLATED_BYTES).toBe(200 * 1024 * 1024);
  });

  it("throws ArchiveSizeExceededError when the cap is exceeded", () => {
    const bytes = zipSync({ "xl/workbook.xml": strToU8("<workbook/>") });
    expect(() => readZipParts(bytes, () => true, { maxInflatedBytes: 4 })).toThrow(
      ArchiveSizeExceededError,
    );
  });

  it("refuses when multiple entries sum over the cap", () => {
    const bytes = zipSync({
      "entry1.xml": strToU8("<a/>"),
      "entry2.xml": strToU8("<b/>"),
      "entry3.xml": strToU8("<c/>"),
    });
    expect(() => readZipParts(bytes, () => true, { maxInflatedBytes: 8 })).toThrow(
      ArchiveSizeExceededError,
    );
  });
});
