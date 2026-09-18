import { describe, expect, it } from "vitest";
import type { CellValue } from "../../src/workbook/cells.js";
import { UNEVALUABLE } from "../../src/workbook/cells.js";
import { detectHeaderRow, HEADER_SCAN_ROWS } from "../../src/workbook/describe.js";

describe("detectHeaderRow", () => {
  it("proposes the single unambiguous header row", () => {
    const grid = [
      ["Client", "Owed", "Effective"],
      ["CLIENTA", 3, 45000],
      ["CLIENTB", 1, 45200],
    ];

    const detection = detectHeaderRow(grid);

    expect(detection.proposed).toBe(1);
    expect(detection.candidates).toHaveLength(1);
  });

  it("declines when two rows are equally plausible", () => {
    const grid = [
      ["Client", "Owed", "Effective"],
      ["Name", "Count", "Date"],
      ["CLIENTA", 3, 45000],
    ];

    const detection = detectHeaderRow(grid);

    expect(detection.proposed).toBeUndefined();
    expect(detection.candidates.map((candidate) => candidate.row)).toEqual([1, 2]);
    expect(detection.declinedReason).toContain("equally plausible");
  });

  it("does not treat a row of repeated text as a header", () => {
    const grid = [
      ["Open", "Open", "Open"],
      ["CLIENTA", 3, 45000],
    ];

    expect(detectHeaderRow([...grid]).proposed).toBeUndefined();
  });

  it("scans no further than HEADER_SCAN_ROWS", () => {
    const filler = Array.from({ length: HEADER_SCAN_ROWS }, () => [1, 2, 3]);
    const grid = [...filler, ["Client", "Owed", "Effective"]];

    expect(detectHeaderRow(grid).candidates).toHaveLength(0);
  });

  it("declines on an empty grid rather than proposing row 1", () => {
    expect(detectHeaderRow([]).proposed).toBeUndefined();
  });

  // Edges the brief's own tests do not pin, added because this function's
  // number becomes a profile's headerRow and a wrong one fails silently.

  it("proposes a candidate row even when nothing follows it in the grid", () => {
    // The only row in the grid is the candidate itself, so there is no data
    // row underneath to corroborate it. The rule never asked for one: it
    // scores what is there, not what comes after.
    const grid = [["Client", "Owed", "Effective"]];

    const detection = detectHeaderRow(grid);

    expect(detection.proposed).toBe(1);
    expect(detection.candidates).toHaveLength(1);
  });

  it("declines on a single row grid that does not look like a header", () => {
    const grid = [[1, 2, 3]];

    const detection = detectHeaderRow(grid);

    expect(detection.proposed).toBeUndefined();
    expect(detection.candidates).toHaveLength(0);
    expect(detection.declinedReason).toContain("No row");
  });

  it("proposes the higher scoring row outright when two candidates are not tied", () => {
    // Both rows pass the candidate test, so both appear in candidates, but
    // only the strictly higher score should be proposed: a tie is the only
    // condition this function declines on, not merely having more than one
    // candidate.
    const grid = [
      ["A", "B"],
      ["Client", "Owed", "Effective"],
    ];

    const detection = detectHeaderRow(grid);

    expect(detection.proposed).toBe(2);
    expect(detection.candidates.map((candidate) => candidate.row)).toEqual([1, 2]);
    expect(detection.declinedReason).toBeUndefined();
  });

  it("does not let an unevaluable cell pass as a header label", () => {
    // UNEVALUABLE is filled, since something was written there, but it is
    // not a string, so this row must fail the all-labels test the same way
    // a row mixing text and numbers does. Treating it as blank instead would
    // let the other two labels alone win the row a proposal, which would be
    // proposing a header this function never actually read in full.
    const grid: CellValue[][] = [
      ["Client", UNEVALUABLE, "Effective"],
      ["CLIENTA", 3, 45000],
    ];

    const detection = detectHeaderRow(grid);

    expect(detection.proposed).toBeUndefined();
    expect(detection.candidates).toHaveLength(0);
  });

  it("still proposes a header row that sits at the last scanned index", () => {
    // The scan boundary is Math.min(grid.length, HEADER_SCAN_ROWS), so the
    // row at index HEADER_SCAN_ROWS - 1 (row HEADER_SCAN_ROWS) is the last
    // one included. Off by one here would silently exclude a legitimate
    // header sitting right at the edge of the scan window.
    const filler = Array.from({ length: HEADER_SCAN_ROWS - 1 }, () => [1, 2, 3]);
    const grid = [...filler, ["Client", "Owed", "Effective"]];

    const detection = detectHeaderRow(grid);

    expect(detection.proposed).toBe(HEADER_SCAN_ROWS);
    expect(detection.candidates).toHaveLength(1);
  });
});
