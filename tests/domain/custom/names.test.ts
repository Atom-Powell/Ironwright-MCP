import { describe, expect, it } from "vitest";
import { invalidNameReason, splitName } from "../../../src/domain/custom/names.js";

describe("splitName", () => {
  it("splits at the last dot", () => {
    expect(splitName("report.final.pdf")).toEqual({
      stem: "report.final",
      extension: ".pdf",
    });
  });
  it("treats a name without a dot as all stem", () => {
    expect(splitName("README")).toEqual({ stem: "README", extension: "" });
  });
  it("treats a leading dot as part of the stem, not an extension", () => {
    expect(splitName(".gitignore")).toEqual({
      stem: ".gitignore",
      extension: "",
    });
  });
});

describe("invalidNameReason", () => {
  it("accepts an ordinary name", () => {
    expect(invalidNameReason("2026-05 Client A report.pdf", false)).toBeUndefined();
  });
});
