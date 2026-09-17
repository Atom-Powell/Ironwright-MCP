import type { CellValue } from "./cells.js";
import { decodeCell } from "./cells.js";

/**
 * A 1 based, inclusive rectangle on a worksheet. 1 based because that is how
 * a cell reference such as "B12" already reads, and how a profile's
 * workbookMapping already names a header row: converting to 0 based only to
 * convert back at every call site is a pure source of off by one errors.
 */
export interface SheetBounds {
  firstRow: number;
  lastRow: number;
  firstColumn: number;
  lastColumn: number;
}

/**
 * Excel's own sheet maximum. A cell reference past either cap did not come
 * from a workbook this large; XFD1 is the real last column and row
 * 1,048,576 is the real last row, so a reference beyond them names a
 * corrupted or hand edited part, not a large one, and is refused rather than
 * grown into.
 */
export const MAX_GRID_ROWS = 1_048_576;
export const MAX_GRID_COLUMNS = 16_384;

/** Reads a single cell reference such as "B12" into row and column. */
function parseCellReference(ref: string): { row: number; column: number } {
  const match = /^([A-Za-z]+)([0-9]+)$/.exec(ref);
  if (!match) {
    throw new Error(
      `The cell reference "${ref}" is not a column letter followed by a row number, so its position on ` +
        "the sheet cannot be determined.",
    );
  }
  const [, letters, digits] = match;
  const column = columnLabelToIndex(letters as string);
  const row = Number(digits);

  if (column > MAX_GRID_COLUMNS) {
    throw new Error(
      `The cell reference "${ref}" names column ${String(column)}, past the ${String(MAX_GRID_COLUMNS)} ` +
        "columns a worksheet can have.",
    );
  }
  if (row > MAX_GRID_ROWS) {
    throw new Error(
      `The cell reference "${ref}" names row ${String(row)}, past the ${String(MAX_GRID_ROWS)} rows a ` +
        "worksheet can have.",
    );
  }

  return { row, column };
}

/** A column label such as "AA" read as a 1 based index, so "A" is 1. */
export function columnLabelToIndex(label: string): number {
  let index = 0;
  for (const letter of label.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index;
}

/**
 * Every `<c ...>...</c>` or self closing `<c .../>` in the part, in document
 * order. Matched directly against the whole sheet rather than scoped to each
 * `<row>` first, because each cell's own `r` attribute is what fixes its row
 * and column below; the enclosing `<row>` element contributes nothing this
 * function needs once that attribute is read, and skipping it is one pass
 * over the text instead of two. `\b` after `c` keeps this from matching
 * `<col>` or `<cols>`, which share the same leading character but are a
 * different element entirely.
 */
const CELL_PATTERN = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
const FORMULA_PATTERN = /<f[\s>/]/;

interface PlacedCell {
  row: number;
  column: number;
  value: CellValue;
  hasFormula: boolean;
}

function readCells(sheetXml: string, sharedStrings: string[]): PlacedCell[] {
  const cells: PlacedCell[] = [];
  for (const match of sheetXml.matchAll(CELL_PATTERN)) {
    const cellXml = match[0];
    const openTag = /^<c\b[^>]*/.exec(cellXml)?.[0] ?? cellXml;
    const ref = /\sr="([^"]*)"/.exec(openTag)?.[1];
    if (ref === undefined) {
      throw new Error(
        "A cell has no r attribute, so its row and column cannot be read from its position in the file.",
      );
    }
    const { row, column } = parseCellReference(ref);
    cells.push({
      row,
      column,
      value: decodeCell(cellXml, sharedStrings),
      hasFormula: FORMULA_PATTERN.test(cellXml),
    });
  }
  return cells;
}

/**
 * A worksheet part read into a rectangle. Rows and columns the part has no
 * cell for become null rather than being omitted, so every row of the grid
 * has the same length and a caller can index into it without checking bounds
 * first.
 *
 * With no `bounds`, the row range is trimmed to the rows that actually carry
 * a cell, and that trim is what `firstRow` reports back. The column range is
 * deliberately NOT trimmed the same way: it always starts at column 1 (grid
 * column 0 is always column A), even though the row range is trimmed to
 * where the data starts. This is an intentional asymmetry, not an
 * oversight, and there is no matching `firstColumn` in the return value to
 * pair with it. A bounded read is unaffected: `bounds` fixes both a firstRow
 * and a firstColumn explicitly, so the asymmetry exists only in the
 * unbounded case. It is safe because no caller needs an absolute column
 * origin for the unbounded case: `readWorkbookGrid` in `read.ts`, the one
 * consumer of an unbounded grid, locates its columns by matching header text
 * within the header row, never by absolute column index, so where column 0
 * of the grid falls relative to the sheet is not load bearing for
 * correctness there. If a future caller needs an absolute column origin,
 * that caller needs its own bounds, not a change to this default.
 */
export function sheetToGrid(
  sheetXml: string,
  sharedStrings: string[],
  bounds?: SheetBounds,
): { grid: CellValue[][]; firstRow: number; hadFormula: boolean } {
  if (bounds) {
    if (bounds.lastRow < bounds.firstRow || bounds.lastColumn < bounds.firstColumn) {
      throw new Error(
        `The requested range (rows ${String(bounds.firstRow)} to ${String(bounds.lastRow)}, columns ` +
          `${String(bounds.firstColumn)} to ${String(bounds.lastColumn)}) has a last row or column before ` +
          "its first, which names no rectangle to read.",
      );
    }
    if (bounds.lastRow > MAX_GRID_ROWS || bounds.lastColumn > MAX_GRID_COLUMNS) {
      throw new Error(
        `The requested range's last row ${String(bounds.lastRow)} or last column ${String(bounds.lastColumn)} ` +
          `is past the ${String(MAX_GRID_ROWS)} rows or ${String(MAX_GRID_COLUMNS)} columns a worksheet can ` +
          "have.",
      );
    }
  }

  const cells = readCells(sheetXml, sharedStrings);

  let firstRow: number;
  let lastRow: number;
  let firstColumn: number;
  let lastColumn: number;

  if (bounds) {
    ({ firstRow, lastRow, firstColumn, lastColumn } = bounds);
  } else if (cells.length === 0) {
    // Nothing to offset against, so row 1 is a neutral origin for an empty
    // grid rather than a claim that the part carries data starting there.
    return { grid: [], firstRow: 1, hadFormula: false };
  } else {
    firstRow = Math.min(...cells.map((cell) => cell.row));
    lastRow = Math.max(...cells.map((cell) => cell.row));
    firstColumn = 1;
    lastColumn = Math.max(...cells.map((cell) => cell.column));
  }

  const rowCount = lastRow - firstRow + 1;
  const columnCount = lastColumn - firstColumn + 1;
  const grid: CellValue[][] = Array.from({ length: rowCount }, () => Array<CellValue>(columnCount).fill(null));

  let hadFormula = false;
  for (const cell of cells) {
    if (cell.row < firstRow || cell.row > lastRow || cell.column < firstColumn || cell.column > lastColumn) {
      continue;
    }
    const row = grid[cell.row - firstRow];
    // Guarded rather than asserted: the row index is only safe because of the
    // range filter just above. If that filter and this lookup ever disagree,
    // failing loudly beats writing the cell into the wrong row, or into none,
    // with nothing to notice either.
    if (row === undefined) {
      throw new Error(
        `Cell row ${String(cell.row)} passed the range filter but has no matching grid row, which means the ` +
          "range check above and the grid's own dimensions have fallen out of agreement.",
      );
    }
    row[cell.column - firstColumn] = cell.value;
    if (cell.hasFormula) hadFormula = true;
  }

  return { grid, firstRow, hadFormula };
}
