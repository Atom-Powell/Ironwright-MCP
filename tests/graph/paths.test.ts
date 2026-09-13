import { describe, expect, it } from "vitest";
import { driveItemPath, libraryRelativePath } from "../../src/graph/paths.js";

describe("driveItemPath", () => {
  it("builds the colon form and encodes each segment", () => {
    expect(driveItemPath("d1", "2026/CLIENT A/report.xlsx")).toBe("/drives/d1/root:/2026/CLIENT%20A/report.xlsx:");
  });

  it("encodes a hash and a question mark, which would otherwise truncate the URL", () => {
    expect(driveItemPath("d1", "Q1 #2/what?.xlsx")).toBe("/drives/d1/root:/Q1%20%232/what%3F.xlsx:");
  });

  it("addresses the root without a colon form", () => {
    expect(driveItemPath("d1", "")).toBe("/drives/d1/root");
  });

  it("tolerates a leading slash rather than producing an empty first segment", () => {
    expect(driveItemPath("d1", "/2026/a.xlsx")).toBe("/drives/d1/root:/2026/a.xlsx:");
  });
});

describe("libraryRelativePath", () => {
  it("strips the drive prefix and returns a library-relative path with no leading slash", () => {
    expect(libraryRelativePath("/drives/d1/root:/2026/CLIENTA", "report.xlsx")).toBe("2026/CLIENTA/report.xlsx");
  });

  it("returns a bare name for an item sitting in the library root", () => {
    expect(libraryRelativePath("/drives/d1/root:", "report.xlsx")).toBe("report.xlsx");
  });

  it("decodes percent-encoded segments, since Graph returns the path encoded", () => {
    expect(libraryRelativePath("/drives/d1/root:/2026/CLIENT%20A", "a%20b.xlsx")).toBe("2026/CLIENT A/a%20b.xlsx");
  });

  it("accepts the singular drive form some responses use", () => {
    expect(libraryRelativePath("/drive/root:/2026", "a.xlsx")).toBe("2026/a.xlsx");
  });
});
