import { describe, expect, it } from "vitest";
import type { CellValue } from "../../src/workbook/cells.js";
import { UNEVALUABLE } from "../../src/workbook/cells.js";
import { describeColumns } from "../../src/workbook/describe.js";

describe("describeColumns", () => {
  const grid = [
    ["Client", "Owed", "Active", "Notes"],
    ["CLIENTA", 3, true, null],
    ["CLIENTB", 1, false, null],
    ["CLIENTA", 2, true, null],
  ];

  it("labels columns against the sheet, not the grid", () => {
    const described = describeColumns(grid, 1, 3, {});
    expect(described.map((column) => column.columnLabel)).toEqual(["C", "D", "E", "F"]);
  });

  it("numbers positions against the sheet too, so position and columnLabel never disagree", () => {
    // A table that does not start at column A is the case where a
    // range-relative position and a sheet-absolute label would diverge, and
    // an operator reading position 1 beside label C has to decide which of
    // the two to trust. They agree instead.
    const described = describeColumns(grid, 1, 3, {});

    expect(described.map((column) => column.position)).toEqual([3, 4, 5, 6]);
  });

  it("reports the header verbatim and the type under it", () => {
    const described = describeColumns(grid, 1, 1, {});
    expect(described[0]).toMatchObject({ header: "Client", inferredType: "string", nonEmptyCount: 3, distinctCount: 2 });
    expect(described[1]).toMatchObject({ header: "Owed", inferredType: "number", distinctCount: 3 });
    expect(described[2]).toMatchObject({ header: "Active", inferredType: "boolean", distinctCount: 2 });
  });

  it("reports a column with no values as empty rather than as a type", () => {
    expect(describeColumns(grid, 1, 1, {})[3]).toMatchObject({ header: "Notes", inferredType: "empty", nonEmptyCount: 0 });
  });

  it("reports mixed types as mixed rather than picking the first", () => {
    const mixed = [["H"], ["a"], [2]];
    expect(describeColumns(mixed, 1, 1, {})[0]?.inferredType).toBe("mixed");
  });

  it("caps samples and says how many it left out", () => {
    const many = [["H"], ...Array.from({ length: 9 }, (_unused, index) => [`v${String(index)}`])];
    const described = describeColumns(many, 1, 1, { maxSamples: 4 });

    expect(described[0]?.samples).toHaveLength(4);
    expect(described[0]?.samplesOmitted).toBe(5);
    expect(described[0]?.distinctCount).toBe(9);
  });

  it("counts an unevaluable cell rather than treating it as blank", () => {
    const withUnevaluable: CellValue[][] = [["H"], ["a"], [UNEVALUABLE]];
    const described = describeColumns(withUnevaluable, 1, 1, {});

    expect(described[0]?.unevaluableCount).toBe(1);
    expect(described[0]?.nonEmptyCount).toBe(1);
    expect(described[0]?.samples).not.toContain("");
  });

  it("marks an unevaluable header rather than reporting no header", () => {
    const described = describeColumns([[UNEVALUABLE], ["a"]], 1, 1, {});
    expect(described[0]?.headerUnevaluable).toBe(true);
    expect(described[0]?.header).toBeUndefined();
  });

  it("returns no samples at all when they are withheld, and says every value was left out", () => {
    const described = describeColumns(grid, 1, 1, { samplesWithheld: true });
    expect(described.every((column) => column.samples.length === 0)).toBe(true);
    expect(described[0]?.distinctCount).toBe(2);
    // Not zero. Zero would report that nothing was left out of a list that
    // showed the reader nothing.
    expect(described[0]?.samplesOmitted).toBe(2);
  });

  it("renders a non-text header rather than reporting no header for it", () => {
    // A year in a header row is an ordinary tracking-workbook shape. Leaving
    // `header` unset for it made it indistinguishable from a column with no
    // header cell at all, in the field an operator reads most closely.
    const numericHeader: CellValue[][] = [[2026, null], ["a", "b"]];

    const described = describeColumns(numericHeader, 1, 1, {});

    expect(described[0]).toMatchObject({ header: "2026", headerUnevaluable: false });
    expect(described[1]).toMatchObject({ header: undefined, headerUnevaluable: false });
  });

  it("makes an empty text sample visible rather than showing it as nothing", () => {
    // Reachable from a t="str" formula cell: a column of =IF(A1="","",...)
    // looks blank in Excel and genuinely holds empty strings.
    const emptyStrings: CellValue[][] = [["Notes"], [""], [""], ["filled"]];

    const described = describeColumns(emptyStrings, 1, 1, {});

    expect(described[0]).toMatchObject({ nonEmptyCount: 3, distinctCount: 2, inferredType: "string" });
    expect(described[0]?.samples).toEqual(["(empty text)", "filled"]);
  });

  it("describes every column when there is no header row", () => {
    const described = describeColumns([["a", 1]], undefined, 1, {});
    expect(described).toHaveLength(2);
    expect(described[0]?.header).toBeUndefined();
  });

  // Edges the brief itself does not pin, added because a real tracking
  // workbook keeps both shapes and this function's counts become the
  // evidence an operator's column mapping is built from.

  it("still describes a column that only some data rows reach", () => {
    // A ragged grid: the second data row is one cell short. The missing cell
    // reads the same way an explicit null does, nothing was written there,
    // rather than as unevaluable or as a third bucket the return shape has
    // no room for. This is also why the shape is rare: sheetToGrid always
    // fills a rectangle out to one width with null, so raggedness only
    // reaches this function from a grid built by hand.
    const ragged = [
      ["Client", "Owed"],
      ["CLIENTA", 3],
      ["CLIENTB"],
    ];

    const described = describeColumns(ragged, 1, 1, {});

    expect(described).toHaveLength(2);
    expect(described[1]).toMatchObject({ header: "Owed", nonEmptyCount: 1, unevaluableCount: 0 });
  });

  it("describes a data column the header row does not reach", () => {
    // The header row is narrower than the data beneath it. Column count
    // comes from the widest row anywhere in the grid, so the extra data
    // column is still described, just with no header text, rather than
    // being silently cropped to the header's own width.
    const wideData = [["Client"], ["CLIENTA", "extra"]];

    const described = describeColumns(wideData, 1, 1, {});

    expect(described).toHaveLength(2);
    expect(described[1]).toMatchObject({ header: undefined, nonEmptyCount: 1, inferredType: "string" });
  });

  it("describes a header column the data never reaches", () => {
    // The header row is wider than the data beneath it. The extra column
    // still gets reported, as empty, rather than being dropped because no
    // data row happens to reach it.
    const wideHeader = [["Client", "Owed"], ["CLIENTA"]];

    const described = describeColumns(wideHeader, 1, 1, {});

    expect(described).toHaveLength(2);
    expect(described[1]).toMatchObject({ header: "Owed", nonEmptyCount: 0, inferredType: "empty" });
  });
});
