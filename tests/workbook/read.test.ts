import { describe, expect, it } from "vitest";
import { excelSerialToIsoDate, readWorkbookGrid } from "../../src/workbook/read.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import { readFileSync } from "node:fs";

const PROFILE = loadProfile(
  JSON.parse(readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8")),
);

// headerRow in the example profile is 1, so the header is the first row of the
// grid and every row after it is data.
const HEADER = ["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"];

describe("readWorkbookGrid", () => {
  it("maps each row by profile field name, not by spreadsheet header", () => {
    const result = readWorkbookGrid([HEADER, ["CLIENTA", true, false, 45231]], PROFILE);

    expect(result.rejectedRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.client).toBe("CLIENTA");
    expect(result.rows[0]?.fields.monthlyTraining).toBe(true);
    expect(result.rows[0]?.fields.quarterlyPhishing).toBe(false);
  });

  it("skips a row whose client cell is blank, because trailing empty rows are normal", () => {
    const result = readWorkbookGrid([HEADER, ["CLIENTA", true, false, 45231], ["", "", "", ""]], PROFILE);

    expect(result.rows).toHaveLength(1);
    expect(result.rejectedRows).toEqual([]);
  });

  it("ignores columns the mapping does not name", () => {
    const result = readWorkbookGrid(
      [[...HEADER, "Notes"], ["CLIENTA", true, false, 45231, "ignore me"]],
      PROFILE,
    );

    expect(result.rows[0]?.fields.Notes).toBeUndefined();
  });

  it("puts effectiveFrom on its own field rather than into fields", () => {
    const result = readWorkbookGrid([HEADER, ["CLIENTA", true, false, 45231]], PROFILE);

    expect(result.rows[0]?.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.rows[0]?.fields.effectiveFrom).toBeUndefined();
  });

  it("accepts an effectiveFrom that is already an ISO date string", () => {
    const result = readWorkbookGrid([HEADER, ["CLIENTA", true, false, "2026-08-15"]], PROFILE);

    expect(result.rows[0]?.effectiveFrom).toBe("2026-08-15");
    expect(result.rejectedRows).toEqual([]);
  });

  it("accepts a bare year and month, which is what the engine's own rule allows", () => {
    // Cadences resolve to a month, so the engine reads "2026-06" and discards
    // a day it is given. The reader used to refuse it as "not a date", which
    // dropped the client out of the report over a value that would have read
    // correctly one module later.
    const result = readWorkbookGrid([HEADER, ["CLIENTA", true, false, "2026-06"]], PROFILE);

    expect(result.rejectedRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.effectiveFrom).toBe("2026-06");
  });

  it("produces a record with no effectiveFrom when that cell is blank, which is not a rejection", () => {
    const result = readWorkbookGrid([HEADER, ["CLIENTA", true, false, ""]], PROFILE);

    expect(result.rejectedRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.effectiveFrom).toBeUndefined();
    expect(result.rows[0]?.fields.monthlyTraining).toBe(true);
  });
});

describe("excelSerialToIsoDate", () => {
  it("converts the serial that is the Unix epoch", () => {
    // 25569 is the Excel serial for 1970-01-01, which is the anchor the
    // conversion is written around.
    expect(excelSerialToIsoDate(25569)).toBe("1970-01-01");
  });

  it("converts a modern serial", () => {
    expect(excelSerialToIsoDate(25570)).toBe("1970-01-02");
  });

  it("refuses a serial in Excel's 1900 range, where its phantom leap day makes the mapping ambiguous", () => {
    expect(excelSerialToIsoDate(59)).toBeUndefined();
    expect(excelSerialToIsoDate(60)).toBeUndefined();
  });

  it("accepts serial 61, the first date past the ambiguous range and the boundary itself", () => {
    // 60 is Excel's phantom 29 February 1900, so 61 is the first serial whose
    // mapping is unambiguous. Pinned because a boundary written as < or <= is a
    // one-character edit that no other case in this file would catch.
    expect(excelSerialToIsoDate(61)).toBe("1900-03-01");
  });

  it("accepts serial 2958465, the last day of year 9999 and the upper boundary itself", () => {
    expect(excelSerialToIsoDate(2958465)).toBe("9999-12-31");
  });

  it("refuses a serial past year 9999, where the ISO form is no longer a ten-character date", () => {
    // One past the boundary, and a serial far beyond it. `toISOString` switches
    // to an expanded year up there, so the first ten characters of it come back
    // as "+010000-01" and "+125738-04", which are not dates. Returning one of
    // those from a function named for an ISO date is the assertion this bound
    // exists to refuse.
    expect(excelSerialToIsoDate(2958466)).toBeUndefined();
    expect(excelSerialToIsoDate(45231000)).toBeUndefined();
  });
});
