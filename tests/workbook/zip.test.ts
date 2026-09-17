import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { readZipParts } from "../../src/workbook/zip.js";

describe("readZipParts", () => {
  it("returns only the parts the filter wants, as text", () => {
    const bytes = zipSync({
      "xl/workbook.xml": strToU8("<workbook/>"),
      "xl/sharedStrings.xml": strToU8("<sst/>"),
      "docProps/app.xml": strToU8("<Properties/>"),
    });

    const parts = readZipParts(bytes, (name) => name.startsWith("xl/"));

    expect([...parts.keys()].sort()).toEqual(["xl/sharedStrings.xml", "xl/workbook.xml"]);
    expect(parts.get("xl/workbook.xml")).toBe("<workbook/>");
  });
});
