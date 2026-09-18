import type { CellValue } from "./cells.js";
import { UNEVALUABLE } from "./cells.js";
import { columnIndexToLabel } from "./sheet.js";

/**
 * How many rows from the top of a grid detectHeaderRow will look at. A
 * header row belongs near the top of a range; scanning without a limit
 * would let a coincidentally label-shaped data row far down the sheet win
 * by default; simply because nothing closer to the top was ever compared
 * against it.
 */
export const HEADER_SCAN_ROWS = 20;

/** One row that met the candidate test, with the evidence behind its score. */
export interface HeaderCandidate {
  row: number;
  distinctLabels: number;
  reason: string;
}

/**
 * The result of scanning a grid for its header row. `proposed` is set only
 * when the scan is confident; `candidates` lists every row that qualified,
 * win or not, so a caller can show its work; `declinedReason` is set exactly
 * when `proposed` is not.
 */
export interface HeaderDetection {
  proposed?: number;
  candidates: HeaderCandidate[];
  declinedReason?: string;
}

/**
 * A cell that reads as genuinely absent: no value was ever written there.
 * An unevaluable cell is not blank by this test, because something is
 * there and this function only does not know what it says.
 */
function isBlankCell(value: CellValue): boolean {
  return value === null || value === "";
}

/**
 * Decides which row of a grid is its header row, or declines to decide.
 *
 * The rule: within the first HEADER_SCAN_ROWS rows, a row is a candidate
 * when it has at least two non-blank cells, every one of those cells is a
 * string, and the strings are all distinct from one another. An
 * unevaluable cell counts as non-blank, since something was written there,
 * but it is not a string, so a row holding one can never pass the
 * all-strings test; a row of column labels this function cannot read with
 * confidence is not proposed as a header any more than a row of numbers
 * would be. A candidate's score is its count of distinct labels.
 *
 * The detection proposes a row only when exactly one candidate holds the
 * highest score. A tie at the top means the grid itself does not settle
 * the question, and this function returns no proposal and a declinedReason
 * rather than picking one side of the tie: a header row chosen wrongly
 * shifts every column beneath it by one, the resulting mapping still
 * validates, and the server then reports compliance computed from the
 * wrong column. An operator can resolve that ambiguity by looking at the
 * two rows; this function cannot, and must not guess in its place.
 */
export function detectHeaderRow(grid: CellValue[][]): HeaderDetection {
  const candidates: HeaderCandidate[] = [];

  for (let index = 0; index < Math.min(grid.length, HEADER_SCAN_ROWS); index += 1) {
    const row = grid[index] ?? [];
    const filled = row.filter((value) => !isBlankCell(value));
    const labels = filled.filter((value): value is string => typeof value === "string");
    const distinct = new Set(labels);

    // Fewer than two filled cells is too little evidence either way. A
    // non-string among the filled cells, unevaluable or otherwise, fails
    // the all-labels test. A repeated label fails the all-distinct test,
    // since a header names each column once.
    if (filled.length < 2 || labels.length !== filled.length || distinct.size !== labels.length) continue;

    candidates.push({
      row: index + 1,
      distinctLabels: distinct.size,
      reason: `Every one of its ${String(filled.length)} filled cells is a distinct piece of text.`,
    });
  }

  const best = Math.max(0, ...candidates.map((candidate) => candidate.distinctLabels));
  const leaders = candidates.filter((candidate) => candidate.distinctLabels === best);

  if (leaders.length === 1) return { proposed: leaders[0]?.row, candidates };

  if (leaders.length === 0) {
    return { candidates, declinedReason: "No row in the scanned range looks like a header." };
  }

  return {
    candidates,
    declinedReason:
      `Rows ${leaders.map((candidate) => String(candidate.row)).join(" and ")} are equally plausible headers, ` +
      "so this tool proposes none. A header row chosen wrongly shifts every column by one and produces a " +
      "mapping that validates and reads the wrong data.",
  };
}

/** How many distinct sample values a described column carries by default. */
export const MAX_COLUMN_SAMPLES = 5;

export type InferredType = "string" | "number" | "boolean" | "mixed" | "empty";

/**
 * The evidence a human reads to decide which column is which, for one column
 * of a range. This is deliberately a report of what is there rather than a
 * guess at what a column means: the tool this feeds never proposes that a
 * column is "the client column", only what its header says, what type its
 * values settle on, and a few of them to look at.
 */
export interface ColumnDescription {
  /** The sheet-absolute column number, matching columnLabel. */
  position: number;
  /** columnLabel is derived from position, never from the grid's own 0 based index. */
  columnLabel: string;
  /** The header cell's text, verbatim. Unset when there is no header row, the header cell is not text, or it is unevaluable. */
  header?: string;
  /** True when the header cell exists but could not be read, so header being unset does not read as the cell being blank. */
  headerUnevaluable: boolean;
  inferredType: InferredType;
  /** Cells below the header (or every cell, when there is no header) that were read and hold a value. Never counts an unevaluable cell. */
  nonEmptyCount: number;
  /** Cells that were seen but could not be read. Counted separately from nonEmptyCount, since their value was never actually read. */
  unevaluableCount: number;
  /** How many distinct values the column holds, before any sample cap is applied. */
  distinctCount: number;
  /** Distinct values, in first-seen order, capped at maxSamples. */
  samples: string[];
  /** distinctCount minus how many samples were kept, computed before the cap so it stays accurate even when samples themselves are withheld. */
  samplesOmitted: number;
}

/**
 * Renders a read cell value the way an operator would type it, for a sample.
 * Only called on a value that already passed the null and UNEVALUABLE
 * checks below, so it never has to decide what an absent or unreadable
 * value looks like as text.
 */
function renderSample(value: string | number | boolean): string {
  return String(value);
}

/**
 * A key that keeps the number 1, the string "1" and the boolean true from
 * colliding into one distinct value: distinctCount and the sample list both
 * need to tell a column's actual types apart, not just their printed form.
 */
function distinctKey(value: string | number | boolean): string {
  return `${typeof value}:${String(value)}`;
}

/**
 * Describes every column a grid touches: its header text if there is a
 * header row, the type its data settles on, how many values and how many
 * unreadable cells it holds, and a bounded, first-seen sample of its
 * distinct values.
 *
 * `headerRow` is 1 based within the grid, the same numbering
 * detectHeaderRow's own `proposed` field already uses, so its result can be
 * passed straight through without conversion. `firstColumn` is the
 * sheet-absolute column the grid's column 0 sits at; every column this
 * function reports is labeled and positioned against the sheet, not
 * against the grid's own 0 based index, because a human comparing this
 * output to the open workbook needs the sheet's own column letters.
 *
 * Column count is taken from the widest row anywhere in the grid, header row
 * included, rather than from the header row alone or the data rows alone.
 * That is what lets a header wider than its data still report the extra
 * column as empty instead of dropping it, and lets data reaching past a
 * narrow or absent header still get described, just with no header text to
 * show. A row shorter than that width simply has no cell at the missing
 * position, and this function reads that the same way it reads an explicit
 * null cell: nothing was written there, not that something unreadable was.
 * A real workbook never actually produces this shape, since sheetToGrid
 * always fills a rectangle out to a single width with null rather than
 * omitting a cell; raggedness only reaches this function from a grid built
 * by hand.
 */
export function describeColumns(
  grid: CellValue[][],
  headerRow: number | undefined,
  firstColumn: number,
  options?: { samplesWithheld?: boolean; maxSamples?: number },
): ColumnDescription[] {
  const maxSamples = options?.maxSamples ?? MAX_COLUMN_SAMPLES;
  const samplesWithheld = options?.samplesWithheld ?? false;

  const columnCount = grid.reduce((widest, row) => Math.max(widest, row.length), 0);

  const headerRowIndex = headerRow === undefined ? undefined : headerRow - 1;
  const headerCells = headerRowIndex === undefined ? undefined : grid[headerRowIndex];
  const dataRows = headerRowIndex === undefined ? grid : grid.slice(headerRowIndex + 1);

  const columns: ColumnDescription[] = [];

  for (let column = 0; column < columnCount; column += 1) {
    const headerCell = headerCells?.[column];
    const headerUnevaluable = headerCell === UNEVALUABLE;
    const header = typeof headerCell === "string" ? headerCell : undefined;

    let nonEmptyCount = 0;
    let unevaluableCount = 0;
    let sawString = false;
    let sawNumber = false;
    let sawBoolean = false;
    let distinctCount = 0;
    const seen = new Set<string>();
    const samples: string[] = [];

    for (const row of dataRows) {
      const cell = row[column];
      // undefined (a row too short to reach this column) and null (a cell
      // that exists but was never written) are read the same way: neither
      // is a value and neither was ever unreadable, so both are simply
      // skipped rather than counted anywhere.
      if (cell === undefined || cell === null) continue;

      if (cell === UNEVALUABLE) {
        unevaluableCount += 1;
        continue;
      }

      nonEmptyCount += 1;
      if (typeof cell === "string") sawString = true;
      else if (typeof cell === "number") sawNumber = true;
      else sawBoolean = true;

      const key = distinctKey(cell);
      if (seen.has(key)) continue;
      seen.add(key);
      distinctCount += 1;
      if (!samplesWithheld && samples.length < maxSamples) samples.push(renderSample(cell));
    }

    const typesSeen = [sawString, sawNumber, sawBoolean].filter(Boolean).length;
    const inferredType: InferredType =
      nonEmptyCount === 0
        ? "empty"
        : typesSeen > 1
          ? "mixed"
          : sawString
            ? "string"
            : sawNumber
              ? "number"
              : "boolean";

    const position = firstColumn + column;

    columns.push({
      position,
      columnLabel: columnIndexToLabel(position),
      header,
      headerUnevaluable,
      inferredType,
      nonEmptyCount,
      unevaluableCount,
      distinctCount,
      samples,
      // Zeroed rather than computed when samples are withheld: the counts
      // are structure and stay intact, but samplesOmitted is a statement
      // about what the (absent) sample list left out, and there is nothing
      // to have left out of a list that was never populated.
      samplesOmitted: samplesWithheld ? 0 : Math.max(0, distinctCount - maxSamples),
    });
  }

  return columns;
}
