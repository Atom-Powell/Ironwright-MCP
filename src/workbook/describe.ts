import type { CellValue } from "./cells.js";

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
