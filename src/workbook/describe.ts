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
 *
 * The empty string counts as absent HERE and as a present value in
 * `describeColumns` below, and that split is deliberate rather than an
 * oversight the two should be unified out of. This test serves header
 * detection, where an empty cell in a candidate row is a column with no
 * label and must not be scored as one. `describeColumns` reports what a
 * column holds, and `t="str"` formula cells make the empty string a value
 * the file genuinely carries: a column of `=IF(A1="","",...)` looks blank in
 * Excel and really does hold hundreds of empty strings, which that function
 * counts and this one does not. Both readings are honest about their own
 * question; a shared one would have to be wrong about one of them.
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
 *
 * This is one property, not the two the design spec first named. The
 * second, whether the row beneath a candidate differs in type from it,
 * could only ever break a tie, and a tie here is the evidence failing to
 * decide rather than a question waiting for a second opinion. See the
 * 2026-09-18 amendment in the phase 4c spec for why the signal was dropped
 * rather than delivered.
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
  /**
   * The header cell as Excel shows it: text verbatim, and a number or
   * boolean rendered the way it is displayed. Unset only when the header
   * cell is genuinely absent or blank, or when there is no header row at
   * all, or when the cell is unevaluable and headerUnevaluable says so.
   */
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
  /** distinctCount minus how many samples were kept, so it stays accurate even when samples themselves are withheld. */
  samplesOmitted: number;
}

/** What an empty text cell renders as in a sample list. */
export const EMPTY_TEXT_SAMPLE = "(empty text)";

/**
 * Renders a read cell value the way an operator would type it, for a sample.
 * Only called on a value that already passed the null and UNEVALUABLE
 * checks below, so it never has to decide what an absent or unreadable
 * value looks like as text.
 *
 * The empty string is the one value that cannot render as itself. A `t="str"`
 * formula cell can genuinely hold it, and an empty entry sitting in a list
 * of real values reads as nothing at all rather than as a value the column
 * holds, which is the same conflation between absent and present this module
 * refuses everywhere else. A cell whose text is literally "(empty text)"
 * would be indistinguishable from it; that is accepted, because the trade is
 * a contrived collision against a value an operator would otherwise not see.
 */
function renderSample(value: string | number | boolean): string {
  return value === "" ? EMPTY_TEXT_SAMPLE : String(value);
}

/**
 * The header cell as Excel displays it. A header row holding the year 2026
 * is an ordinary tracking-workbook shape, and leaving `header` unset for it
 * made a numeric header indistinguishable from a column with no header cell
 * at all, in the field an operator reads most closely. Rendering it is what
 * Excel itself shows and what the operator will compare this output
 * against; the alternative, a second flag beside headerUnevaluable, adds a
 * field to say what the value could already have said.
 *
 * Absent, blank and unevaluable cells never reach here: each is its own
 * answer and none of them has a display form to render.
 */
function renderHeader(value: CellValue | undefined): string | undefined {
  if (value === null || value === undefined || value === UNEVALUABLE || value === "") return undefined;
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
    const header = renderHeader(headerCell);

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

      // The empty string is counted here as a value the column holds, unlike
      // isBlankCell above, which reads it as absent for header detection.
      // See that function for why the two differ: a `t="str"` formula cell
      // genuinely carries it, so a column of `=IF(A1="","",...)` looks blank
      // in Excel and truthfully reports hundreds of non-empty strings here.
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
      // Measured against the sample list actually built, which is what makes
      // it right in both directions: distinctCount minus the cap when the cap
      // bit, and the whole distinctCount when every sample was withheld.
      // Zeroing it under withholding was the alternative and it is the
      // project's named defect in miniature: true of the cap, which left
      // nothing out, and false about the response, which showed the reader
      // none of a column's values while reporting that none were missing.
      samplesOmitted: distinctCount - samples.length,
    });
  }

  return columns;
}
