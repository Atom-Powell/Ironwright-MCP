import { describe, expect, it } from "vitest";
import { readWorkbookGrid, WorkbookMappingError } from "../../src/workbook/read.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import { readFileSync } from "node:fs";

const PROFILE = loadProfile(
  JSON.parse(readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8")),
);

const HEADER = ["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"];

describe("readWorkbookGrid failures", () => {
  it("fails the whole read when a mapped header is absent, because every row would be wrong", () => {
    const call = (): unknown => readWorkbookGrid([["Client", "Monthly Training"], ["CLIENTA", true]], PROFILE);

    expect(call).toThrow(WorkbookMappingError);
    expect(call).toThrow(/Quarterly Phishing/);
    expect(call).toThrow(/workbookMapping/);
  });

  it("names every missing header at once rather than one per run", () => {
    const call = (): unknown => readWorkbookGrid([["Client"], ["CLIENTA"]], PROFILE);

    expect(call).toThrow(/Monthly Training/);
    expect(call).toThrow(/Quarterly Phishing/);
  });

  it("fails the whole read when the grid has no header row at all", () => {
    expect(() => readWorkbookGrid([], PROFILE)).toThrow(WorkbookMappingError);
  });

  it("rejects one row for a malformed effectiveFrom and keeps the rest", () => {
    const result = readWorkbookGrid(
      [HEADER, ["CLIENTA", true, false, 45231], ["CLIENTB", true, false, "15/08/2026"]],
      PROFILE,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.client).toBe("CLIENTA");
    expect(result.rejectedRows).toHaveLength(1);
    expect(result.rejectedRows[0]?.client).toBe("CLIENTB");
    expect(result.rejectedRows[0]?.reason).toMatch(/15\/08\/2026/);
  });

  it("numbers a rejected row as the sheet numbers it, so an operator can find the cell", () => {
    const result = readWorkbookGrid(
      [HEADER, ["CLIENTA", true, false, 45231], ["CLIENTB", true, false, "nonsense"]],
      PROFILE,
    );

    // headerRow 1, one good row, so the bad one is sheet row 3.
    expect(result.rejectedRows[0]?.row).toBe(3);
  });
});
