import { z } from "zod";

/**
 * The most sheets or tables one call lists in inventory mode. Named and
 * exported separately, matching MAX_TABLES_LISTED below, because the two
 * lists are independent: a workbook can carry many sheets and few tables or
 * the reverse, and one shared cap would let either list's truncation hide
 * behind the other's count.
 */
export const MAX_SHEETS_LISTED = 200;
export const MAX_TABLES_LISTED = 200;

/**
 * The most columns one call describes in source mode. `totals` for the
 * described range is never abridged; this bounds the per-column detail list
 * the same way MAX_CLIENT_DETAIL bounds validate_structure's own listing.
 */
export const MAX_COLUMNS_DESCRIBED = 100;

export const DESCRIBE_MODES = ["inventory", "source"] as const;
export type DescribeMode = (typeof DESCRIBE_MODES)[number];

export const DESCRIBE_SOURCE_KINDS = ["table", "worksheet"] as const;

export const DESCRIBE_INFERRED_TYPES = ["string", "number", "boolean", "mixed", "empty"] as const;

interface Listing {
  returned: number;
  omitted: number;
  cap: number;
  truncated: boolean;
}

const LISTING_SHAPE = {
  returned: z.number().int(),
  omitted: z.number().int(),
  cap: z.number().int(),
  truncated: z.boolean(),
};

export interface DescribeSheetSummary {
  name: string;
  /** Absent when the worksheet part declares no dimension, which a genuinely empty sheet can have. */
  usedRange?: string;
  rows: number;
  columns: number;
}

export interface DescribeTableSummary {
  name: string;
  sheet: string;
  ref: string;
  rows: number;
  columns: number;
  hasHeaderRow: boolean;
}

export interface DescribeUnresolvedEntry {
  kind: "sheet" | "table";
  name: string;
  reason: string;
}

export interface DescribeHeaderCandidate {
  row: number;
  distinctLabels: number;
  reason: string;
}

export interface DescribeHeaderRow {
  /** 1 based row within the described range. Absent when no row was proposed; see declinedReason. */
  proposed?: number;
  /** Empty for a table, whose header row is read from its own headerRowCount attribute rather than scanned for. */
  candidates: DescribeHeaderCandidate[];
  /** Set exactly when proposed is absent, stating why this tool declined to guess. */
  declinedReason?: string;
}

export interface DescribeColumnDescription {
  position: number;
  columnLabel: string;
  /** Absent when there is no header row, the header cell is not text, or it is unevaluable. */
  header?: string;
  headerUnevaluable: boolean;
  inferredType: (typeof DESCRIBE_INFERRED_TYPES)[number];
  nonEmptyCount: number;
  unevaluableCount: number;
  distinctCount: number;
  /** Distinct values, first seen order. Empty when samplesWithheld is true, regardless of distinctCount. */
  samples: string[];
  samplesOmitted: number;
}

/**
 * Declared as a raw shape rather than a `z.object`, because that is what
 * `ToolDefinition.outputSchema` and the SDK's `registerTool` both take.
 */
export const DESCRIBE_OUTPUT_SCHEMA = {
  library: z.string().describe("The document library this call named."),
  workbookPath: z.string().describe("The library-relative path to the workbook this call named."),
  mode: z
    .enum(DESCRIBE_MODES)
    .describe(
      "\"inventory\" lists every worksheet and table the workbook declares; \"source\" describes the one " +
        "table or worksheet this call named.",
    ),
  sheets: z
    .array(
      z.object({
        name: z.string(),
        usedRange: z
          .string()
          .optional()
          .describe("Absent when the worksheet part declares no dimension, which a genuinely empty sheet can have."),
        rows: z.number().int(),
        columns: z.number().int(),
      }),
    )
    .optional()
    .describe(
      "Every worksheet the workbook declares, in the workbook's own sheet order. Present only in inventory " +
        "mode. May be a prefix of the full set; see sheetsListing.",
    ),
  sheetsListing: z
    .object(LISTING_SHAPE)
    .optional()
    .describe("What survived the cap on the sheet listing, and how much did not. Present only in inventory mode."),
  tables: z
    .array(
      z.object({
        name: z.string(),
        sheet: z.string(),
        ref: z.string(),
        rows: z.number().int(),
        columns: z.number().int(),
        hasHeaderRow: z.boolean(),
      }),
    )
    .optional()
    .describe(
      "Every table the workbook declares. Present only in inventory mode. May be a prefix of the full set; " +
        "see tablesListing.",
    ),
  tablesListing: z
    .object(LISTING_SHAPE)
    .optional()
    .describe("What survived the cap on the table listing, and how much did not. Present only in inventory mode."),
  unresolved: z
    .array(
      z.object({
        kind: z.enum(["sheet", "table"]),
        name: z.string(),
        reason: z.string(),
      }),
    )
    .optional()
    .describe(
      "A sheet or table the workbook's own sheet list or table list named, that this tool could not resolve, " +
        "with why. Present only in inventory mode. Never dropped silently: a workbook whose internal wiring is " +
        "partly broken must not read as a workbook with fewer sheets or tables than it actually declares. " +
        "Always the complete set; this list is never capped.",
    ),
  source: z
    .object({ kind: z.enum(DESCRIBE_SOURCE_KINDS), name: z.string() })
    .optional()
    .describe("The table or worksheet this call asked to describe. Present only in source mode."),
  headerRow: z
    .object({
      proposed: z
        .number()
        .int()
        .optional()
        .describe("1 based row within the described range. Absent when no row was proposed; see declinedReason."),
      candidates: z
        .array(z.object({ row: z.number().int(), distinctLabels: z.number().int(), reason: z.string() }))
        .describe("Empty for a table, whose header row is read from its own declaration rather than scanned for."),
      declinedReason: z.string().optional().describe("Set exactly when proposed is absent, stating why."),
    })
    .optional()
    .describe("Present only in source mode."),
  columns: z
    .array(
      z.object({
        position: z.number().int(),
        columnLabel: z.string(),
        header: z
          .string()
          .optional()
          .describe("Absent when there is no header row, the header cell is not text, or it is unevaluable."),
        headerUnevaluable: z.boolean(),
        inferredType: z.enum(DESCRIBE_INFERRED_TYPES),
        nonEmptyCount: z.number().int(),
        unevaluableCount: z.number().int(),
        distinctCount: z.number().int(),
        samples: z.array(z.string()).describe("Distinct values, first seen order. Empty when samplesWithheld is true."),
        samplesOmitted: z.number().int(),
      }),
    )
    .optional()
    .describe(
      "Every column the described range's widest row touches, ordered by position. Present only in source " +
        "mode. May be a prefix of the full set; see columnsListing. This tool never proposes which column is " +
        "which; the header text, type, distinct count and samples are the evidence for a human to decide that.",
    ),
  columnsListing: z
    .object(LISTING_SHAPE)
    .optional()
    .describe("What survived the cap on the column listing, and how much did not. Present only in source mode."),
  sampleCap: z
    .number()
    .int()
    .optional()
    .describe(
      "The most distinct sample values one column's samples array holds; see each column's own samplesOmitted " +
        "for how many more it actually has. Present only in source mode.",
    ),
  samplesWithheld: z
    .boolean()
    .describe(
      "True when the workbook is marked fullCalcOnLoad and the described range held a formula, meaning its " +
        "cached values are not authoritative. Column structure is still reported; sample values are not. " +
        "Always false in inventory mode, which describes no column samples at all.",
    ),
  graphRequests: z.number().int().describe("What this call itself paid: resolving the drive and downloading the workbook."),
} satisfies z.ZodRawShape;

/**
 * Hand-declared rather than inferred from `DESCRIBE_OUTPUT_SCHEMA` with
 * `z.infer`, matching `InventoryToolOutput`, `QueryToolOutput` and
 * `ValidateStructureOutput`: a value built only to be read through `typeof`
 * in a type position has no runtime use, and this repo's lint configuration
 * treats that as the unused variable it is.
 */
export interface DescribeToolOutput {
  library: string;
  workbookPath: string;
  mode: DescribeMode;
  sheets?: DescribeSheetSummary[];
  sheetsListing?: Listing;
  tables?: DescribeTableSummary[];
  tablesListing?: Listing;
  unresolved?: DescribeUnresolvedEntry[];
  source?: { kind: "table" | "worksheet"; name: string };
  headerRow?: DescribeHeaderRow;
  columns?: DescribeColumnDescription[];
  columnsListing?: Listing;
  sampleCap?: number;
  samplesWithheld: boolean;
  graphRequests: number;
}
