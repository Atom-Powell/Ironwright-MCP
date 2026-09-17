import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { readZipParts, MAX_INFLATED_BYTES } from "../../src/workbook/zip.js";

describe("readZipParts failures", () => {
  it("refuses bytes that are not a zip", () => {
    expect(() => readZipParts(new Uint8Array([1, 2, 3, 4]), () => true)).toThrow(
      /is not a zip archive, so it is not an xlsx workbook/,
    );
  });

  it("refuses an archive whose declared inflated size exceeds the cap", () => {
    const bytes = zipSync({ "xl/workbook.xml": strToU8("<workbook/>") });
    expect(() => readZipParts(bytes, () => true, { maxInflatedBytes: 4 })).toThrow(
      /declares .* bytes of uncompressed content/,
    );
    expect(MAX_INFLATED_BYTES).toBe(200 * 1024 * 1024);
  });
});
