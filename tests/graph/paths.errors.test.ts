import { describe, expect, it } from "vitest";
import { libraryRelativePath, ParentPathError } from "../../src/graph/paths.js";

describe("libraryRelativePath failures", () => {
  it("refuses a parent path with no root marker, naming the value it was given", () => {
    expect(() => libraryRelativePath("/sites/s1/lists/l1", "a.xlsx")).toThrow(ParentPathError);
    expect(() => libraryRelativePath("/sites/s1/lists/l1", "a.xlsx")).toThrow(/\/sites\/s1\/lists\/l1/);
  });

  it("refuses an empty parent path rather than returning a bare name", () => {
    expect(() => libraryRelativePath("", "a.xlsx")).toThrow(ParentPathError);
  });
});
