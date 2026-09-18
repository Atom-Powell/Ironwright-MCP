import type { WorkbookInventory } from "../../workbook/introspect.js";
import type { ColumnDescription, HeaderDetection } from "../../workbook/describe.js";
import type { WorkbookSource } from "../../workbook/xlsx.js";
import {
  MAX_COLUMNS_DESCRIBED,
  MAX_SHEETS_LISTED,
  MAX_TABLES_LISTED,
  type DescribeToolOutput,
} from "./output.js";

export { MAX_COLUMNS_DESCRIBED, MAX_SHEETS_LISTED, MAX_TABLES_LISTED };

export interface DescribeShapeOptions {
  /** Overridden only by tests, so the sheet-listing truncation rule runs on a small fixture. */
  maxSheets?: number;
  /** Overridden only by tests, so the table-listing truncation rule runs on a small fixture. */
  maxTables?: number;
  /** Overridden only by tests, so the column-listing truncation rule runs on a small fixture. */
  maxColumns?: number;
}

/**
 * Totals come from the workbook's own complete sheet and table lists, and
 * each listing is cut only afterward. Counting what survived the cut and
 * presenting it as a count of what the workbook declares is the substitution
 * this project treats as its worst failure, and it is one line away at every
 * truncation site.
 *
 * Sheets and tables are listed in the workbook's own declared order rather
 * than sorted, unlike inventory_tree's path-sorted listing: there is no
 * natural sort key for a sheet or a table that means anything to an operator
 * comparing this output against the open file, and the workbook's own order
 * is exactly what they see in Excel's own sheet tabs.
 *
 * `unresolved` is never capped. It is the evidence that this survey is
 * honest about what it could not read, and a workbook broken enough to
 * produce more unresolved entries than any plausible cap is exactly the
 * workbook an operator most needs the complete list for.
 */
export function shapeDescribeInventory(
  library: string,
  workbookPath: string,
  inventory: WorkbookInventory,
  graphRequests: number,
  options: DescribeShapeOptions,
): DescribeToolOutput {
  const maxSheets = options.maxSheets ?? MAX_SHEETS_LISTED;
  const maxTables = options.maxTables ?? MAX_TABLES_LISTED;

  const listedSheets = inventory.sheets.slice(0, maxSheets);
  const listedTables = inventory.tables.slice(0, maxTables);

  return {
    library,
    workbookPath,
    mode: "inventory",
    sheets: listedSheets,
    sheetsListing: {
      returned: listedSheets.length,
      omitted: inventory.sheets.length - listedSheets.length,
      cap: maxSheets,
      truncated: listedSheets.length < inventory.sheets.length,
    },
    tables: listedTables,
    tablesListing: {
      returned: listedTables.length,
      omitted: inventory.tables.length - listedTables.length,
      cap: maxTables,
      truncated: listedTables.length < inventory.tables.length,
    },
    unresolved: inventory.unresolved,
    samplesWithheld: false,
    graphRequests,
  };
}

/** What run.ts hands over after resolving and describing one source. */
export interface DescribeSourceResolution {
  columns: ColumnDescription[];
  headerRow: HeaderDetection;
  samplesWithheld: boolean;
  /**
   * The cap describeColumns actually applied when it built `columns`, carried
   * through rather than re-read from a constant here: a second default in
   * this module could silently disagree with whatever run.ts really passed
   * to describeColumns.
   */
  sampleCap: number;
}

/**
 * Totals for the described range's columns come from the complete widest-row
 * column set describeColumns already computed, and the column listing is cut
 * only afterward, the same discipline shapeDescribeInventory applies above.
 */
export function shapeDescribeSource(
  library: string,
  workbookPath: string,
  source: WorkbookSource,
  resolution: DescribeSourceResolution,
  graphRequests: number,
  options: DescribeShapeOptions,
): DescribeToolOutput {
  const maxColumns = options.maxColumns ?? MAX_COLUMNS_DESCRIBED;
  const listedColumns = resolution.columns.slice(0, maxColumns);

  return {
    library,
    workbookPath,
    mode: "source",
    source,
    headerRow: resolution.headerRow,
    columns: listedColumns,
    columnsListing: {
      returned: listedColumns.length,
      omitted: resolution.columns.length - listedColumns.length,
      cap: maxColumns,
      truncated: listedColumns.length < resolution.columns.length,
    },
    sampleCap: resolution.sampleCap,
    samplesWithheld: resolution.samplesWithheld,
    graphRequests,
  };
}
