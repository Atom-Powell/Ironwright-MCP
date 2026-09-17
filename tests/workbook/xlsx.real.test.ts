import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNEVALUABLE } from "../../src/workbook/cells.js";
import { parseWorkbookGrid } from "../../src/workbook/xlsx.js";

/**
 * Every other fixture in this suite is hand written XML produced by this
 * repository, so those tests prove the reader agrees with what this
 * repository believes Excel emits, and nothing more. The bytes here came
 * from Excel itself: a workbook with a table named ClientRoster starting
 * away from A1, a header routed through Excel's own shared string table,
 * a formula column with a cached value, and cells Excel itself stored as
 * #N/A. A failure in this file is a real finding about Excel's output, not
 * a test to adjust until it agrees with the reader.
 */
describe("a workbook Excel actually wrote", () => {
  const bytes = new Uint8Array(readFileSync(new URL("./fixtures/real-excel.xlsx", import.meta.url)));

  it("resolves the ClientRoster table to its own range, not to A1", () => {
    const { rowOffset } = parseWorkbookGrid(bytes, { kind: "table", name: "ClientRoster" });
    // Excel placed this table at sheet row 5. A bound of "greater than 1"
    // alone would also pass for a table sitting at A1, which is exactly the
    // wrong assumption this fixture exists to catch, so the exact row is
    // stated as well.
    expect(rowOffset).toBeGreaterThan(1);
    expect(rowOffset).toBe(5);
  });

  it("reads the header row through Excel's own shared string table", () => {
    const { grid } = parseWorkbookGrid(bytes, { kind: "table", name: "ClientRoster" });
    // None of the hand written fixtures route header text through
    // xl/sharedStrings.xml; Excel did here, so this is the assertion that
    // proves shared strings work against Excel's real output, not only
    // against this repository's own writer.
    expect(grid[0]).toEqual(["Client", "Onboarded", "Sessions", "Status", "Check"]);
  });

  it("refuses the two cells Excel itself stored as #N/A, at their own positions", () => {
    const { grid } = parseWorkbookGrid(bytes, { kind: "table", name: "ClientRoster" });
    expect(grid[1]?.[4]).toBe(UNEVALUABLE);
    expect(grid[2]?.[4]).toBe(UNEVALUABLE);
  });

  it("trusts the two formula cells' cached values rather than rejecting them", () => {
    const { grid } = parseWorkbookGrid(bytes, { kind: "table", name: "ClientRoster" });
    // The Status column holds an IF() formula; Excel cached "ok" and "low"
    // for these two rows, and a formula carrying a cached result is trusted
    // rather than treated as unevaluable.
    expect(grid[1]?.[3]).toBe("ok");
    expect(grid[2]?.[3]).toBe("low");
  });

  it("reads the full grid shape, so a missing or extra row or column would fail rather than pass unnoticed", () => {
    const { grid } = parseWorkbookGrid(bytes, { kind: "table", name: "ClientRoster" });
    expect(grid).toEqual([
      ["Client", "Onboarded", "Sessions", "Status", "Check"],
      ["CLIENTA", "2026-01-15", 12, "ok", UNEVALUABLE],
      ["CLIENTB", "2026-03-02", 8, "low", UNEVALUABLE],
    ]);
  });

  it("leaves the Onboarded column as text rather than an Excel date serial", () => {
    const { grid } = parseWorkbookGrid(bytes, { kind: "table", name: "ClientRoster" });
    // The operator's date values stayed text in this fixture, so this is a
    // known gap: nothing here exercises the date serial branch. That branch
    // is covered only by excelSerialToIsoDate's own unit tests, not by this
    // file, and this assertion says so rather than leaving the gap silent.
    expect(typeof grid[1]?.[1]).toBe("string");
    expect(typeof grid[2]?.[1]).toBe("string");
  });
});
