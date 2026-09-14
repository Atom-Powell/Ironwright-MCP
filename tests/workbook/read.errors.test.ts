import { describe, expect, it } from "vitest";
import { readWorkbookGrid, WorkbookMappingError } from "../../src/workbook/read.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import { readFileSync } from "node:fs";

const EXAMPLE_JSON = readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8");

const PROFILE = loadProfile(JSON.parse(EXAMPLE_JSON));

/**
 * The example profile with respectEffectiveFrom turned off, built as a variant
 * rather than by editing the shared fixture: every other case in this file
 * depends on the flag being on, since that is what makes a malformed effective
 * date worth rejecting a row over.
 */
const PROFILE_IGNORING_EFFECTIVE_FROM = loadProfile({
  ...JSON.parse(EXAMPLE_JSON),
  window: { mode: "rolling", months: 12, respectEffectiveFrom: false },
});

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

  it("numbers a rejected row within the range that was read, not within the sheet", () => {
    const result = readWorkbookGrid(
      [HEADER, ["CLIENTA", true, false, 45231], ["CLIENTB", true, false, "nonsense"]],
      PROFILE,
    );

    // headerRow 1, one good row, so the bad one is row 3 of the range. The
    // sheet may number it differently: a table's range starts where the table
    // does, and nothing here reads that offset from Graph.
    expect(result.rejectedRows).toHaveLength(1);
    expect(result.rejectedRows[0]?.row).toBe(3);
  });

  it("rejects a row whose client cell holds a value that is not text, rather than skipping it", () => {
    // Excel hands back a numeric client code as a number, so a workbook using
    // them would otherwise take the trailing-empty-row path and vanish.
    const result = readWorkbookGrid(
      [HEADER, ["CLIENTA", true, false, 45231], [4021, true, false, 45231]],
      PROFILE,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.client).toBe("CLIENTA");
    expect(result.rejectedRows).toHaveLength(1);
    expect(result.rejectedRows[0]?.row).toBe(3);
    expect(result.rejectedRows[0]?.reason).toMatch(/4021/);
  });

  it("leaves the client off a rejection it could not read, rather than inventing one", () => {
    const result = readWorkbookGrid([HEADER, [4021, true, false, 45231]], PROFILE);

    // Asserted before the two below, which would both hold vacuously against an
    // empty list and so would pass against the very behavior this pins.
    expect(result.rejectedRows).toHaveLength(1);
    expect(result.rejectedRows[0]?.client).toBeUndefined();
    expect(Object.hasOwn(result.rejectedRows[0] ?? {}, "client")).toBe(false);
  });

  it("still skips a row whose client cell is null or absent, which is a trailing empty row", () => {
    const result = readWorkbookGrid(
      [HEADER, ["CLIENTA", true, false, 45231], [null, null, null, null], []],
      PROFILE,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rejectedRows).toEqual([]);
  });

  it("rejects an effectiveFrom whose month cannot exist, rather than passing it to the engine", () => {
    // "2026-13-01" satisfies the shape of an ISO date and names a thirteenth
    // month. The reader used to pass it through on shape alone, and the engine
    // then threw on it partway through deriving expectations, which aborted
    // the report for every client rather than rejecting the one row.
    const result = readWorkbookGrid(
      [HEADER, ["CLIENTA", true, false, 45231], ["CLIENTB", true, false, "2026-13-01"]],
      PROFILE,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rejectedRows).toHaveLength(1);
    expect(result.rejectedRows[0]?.client).toBe("CLIENTB");
    expect(result.rejectedRows[0]?.reason).toMatch(/2026-13-01/);
  });

  it("rejects an effectiveFrom whose day cannot exist, rather than passing it to the engine", () => {
    const result = readWorkbookGrid(
      [HEADER, ["CLIENTA", true, false, 45231], ["CLIENTB", true, false, "2026-06-45"]],
      PROFILE,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rejectedRows).toHaveLength(1);
    expect(result.rejectedRows[0]?.client).toBe("CLIENTB");
    expect(result.rejectedRows[0]?.reason).toMatch(/2026-06-45/);
  });

  it("rejects an effectiveFrom serial that lands past the years the engine can read", () => {
    // 45231000 converts to "+125738-04": past 9999 the ISO form switches to an
    // expanded year, and the first ten characters of it are not a date. The
    // numeric branch used to hand that string straight to the engine, which
    // then threw on it and aborted the report for every client. It is the same
    // abort the string branch was screened to close, reached through the other
    // half of the same function.
    const result = readWorkbookGrid(
      [HEADER, ["CLIENTA", true, false, 45231], ["CLIENTB", true, false, 45231000]],
      PROFILE,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.client).toBe("CLIENTA");
    expect(result.rejectedRows).toHaveLength(1);
    expect(result.rejectedRows[0]?.client).toBe("CLIENTB");
    expect(result.rejectedRows[0]?.reason).toMatch(/45231000/);
  });

  it("keeps a row with a malformed effectiveFrom when the profile does not respect that column", () => {
    // With respectEffectiveFrom off the engine never reads the field, so
    // rejecting the row would drop a client out of a compliance report over a
    // cell nothing consults.
    const result = readWorkbookGrid(
      [HEADER, ["CLIENTA", true, false, 45231], ["CLIENTB", true, false, "15/08/2026"]],
      PROFILE_IGNORING_EFFECTIVE_FROM,
    );

    expect(result.rejectedRows).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]?.client).toBe("CLIENTB");
    expect(result.rows[1]?.effectiveFrom).toBeUndefined();
  });

  it("refuses a mapped header the sheet carries twice, rather than taking one of the columns", () => {
    // Two columns headed "Client" answer to one mapping entry and can hold
    // different values. Silently taking the rightmost is the failure that
    // produces an empty, confident report.
    const call = (): unknown =>
      readWorkbookGrid(
        [
          ["Client", "Monthly Training", "Quarterly Phishing", "Onboarded", "Client"],
          ["CLIENTA", true, false, 45231, "CLIENTZ"],
        ],
        PROFILE,
      );

    expect(call).toThrow(WorkbookMappingError);
    expect(call).toThrow(/more than one column headed "Client"/);
  });

  it("ignores a duplicated column the mapping does not name, which is not ambiguous", () => {
    const result = readWorkbookGrid(
      [
        [...HEADER, "Notes", "Notes"],
        ["CLIENTA", true, false, 45231, "first", "second"],
      ],
      PROFILE,
    );

    expect(result.rejectedRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
  });

  it("reads as a whole sentence when exactly one header is missing", () => {
    const call = (): unknown =>
      readWorkbookGrid([["Client", "Monthly Training", "Quarterly Phishing"], ["CLIENTA", true, false]], PROFILE);

    expect(call).toThrow(
      'The workbook has no column headed "Onboarded" on row 1 of the range that was read. ' +
        "The profile's workbookMapping names it, so either that column was renamed in the workbook " +
        "or the mapping was written against a different sheet.",
    );
  });

  it("reads as a whole sentence when several headers are missing", () => {
    const call = (): unknown => readWorkbookGrid([["Client"], ["CLIENTA"]], PROFILE);

    expect(call).toThrow(
      'The workbook has no columns headed "Monthly Training", "Quarterly Phishing", "Onboarded" on row 1 ' +
        "of the range that was read. The profile's workbookMapping names them, so either those columns " +
        "were renamed in the workbook or the mapping was written against a different sheet.",
    );
  });

});
