import type { Profile } from "../domain/profile/schema.js";
import type { ClientRecord, RejectedWorkbookRow } from "../domain/reconcile/index.js";

/**
 * A mapping failure, not a data failure. The distinction is the load-bearing
 * rule of this module: a header the mapping names and the sheet does not have
 * makes every row wrong, so reporting fifty rejected rows would bury the real
 * cause, which is that the mapping is stale against a renamed column.
 */
export class WorkbookMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookMappingError";
  }
}

export interface ReadResult {
  rows: ClientRecord[];
  rejectedRows: RejectedWorkbookRow[];
}

/**
 * 25569 is the Excel serial for 1970-01-01, so the conversion is anchored on the
 * Unix epoch rather than on Excel's own 1899 epoch. Serials below 61 are refused
 * rather than converted: Excel models a 29 February 1900 that never existed, so
 * that range maps ambiguously, and no effective date in a tracking workbook is
 * in 1900.
 */
const UNIX_EPOCH_EXCEL_SERIAL = 25569;
const MILLISECONDS_PER_DAY = 86_400_000;
const FIRST_UNAMBIGUOUS_SERIAL = 61;

export function excelSerialToIsoDate(serial: number): string | undefined {
  if (!Number.isFinite(serial) || serial < FIRST_UNAMBIGUOUS_SERIAL) return undefined;

  const date = new Date((serial - UNIX_EPOCH_EXCEL_SERIAL) * MILLISECONDS_PER_DAY);
  if (Number.isNaN(date.getTime())) return undefined;

  return date.toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cellToField(value: unknown): string | number | boolean | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return null;
}

export function readWorkbookGrid(grid: unknown[][], profile: Profile): ReadResult {
  const headerRowIndex = profile.workbookMapping.headerRow - 1;
  const header = grid[headerRowIndex];
  if (header === undefined) {
    throw new WorkbookMappingError(
      `The workbook range has no row ${profile.workbookMapping.headerRow}, which the profile's ` +
        "workbookMapping names as the header row. Either the mapping points at the wrong sheet or table, " +
        "or the range came back empty.",
    );
  }

  const headerIndexByText = new Map<string, number>();
  header.forEach((cell, index) => {
    if (typeof cell === "string" && cell.trim().length > 0) headerIndexByText.set(cell.trim(), index);
  });

  const columnIndexByField = new Map<string, number>();
  const missing: string[] = [];
  for (const [field, headerText] of Object.entries(profile.workbookMapping.columns)) {
    const index = headerIndexByText.get(headerText);
    if (index === undefined) missing.push(headerText);
    else columnIndexByField.set(field, index);
  }

  if (missing.length > 0) {
    // Every missing header at once. Reporting the first only costs an operator
    // one failed run per renamed column, and a mapping usually goes stale in
    // batches when someone tidies a spreadsheet.
    throw new WorkbookMappingError(
      `The workbook has no column headed ${missing.map((text) => `"${text}"`).join(", ")} on row ` +
        `${profile.workbookMapping.headerRow}. The profile's workbookMapping names ${missing.length === 1 ? "it" : "them"}, ` +
        "so either a column was renamed in the workbook or the mapping was written against a different sheet.",
    );
  }

  const clientIndex = columnIndexByField.get("client") as number;
  const rows: ClientRecord[] = [];
  const rejectedRows: RejectedWorkbookRow[] = [];

  for (let index = headerRowIndex + 1; index < grid.length; index += 1) {
    const sheetRow = index + 1;
    const cells = grid[index];
    if (cells === undefined) continue;

    const clientCell = cells[clientIndex];
    const client = typeof clientCell === "string" ? clientCell.trim() : "";
    // A blank client cell is a trailing empty row, which every spreadsheet has.
    // It is not an error and must not be reported as one, or a workbook with
    // whitespace below its table would report dozens of rejections.
    if (client.length === 0) continue;

    const fields: Record<string, string | number | boolean | null> = {};
    let effectiveFrom: string | undefined;
    let rejection: string | undefined;

    for (const [field, columnIndex] of columnIndexByField) {
      if (field === "client") continue;
      const cell = cells[columnIndex];

      if (field === "effectiveFrom") {
        if (cell === undefined || cell === null || cell === "") continue;
        if (typeof cell === "number") {
          const converted = excelSerialToIsoDate(cell);
          if (converted === undefined) rejection = `effectiveFrom was not a usable date: ${JSON.stringify(cell)}`;
          else effectiveFrom = converted;
        } else if (typeof cell === "string" && ISO_DATE.test(cell.trim())) {
          effectiveFrom = cell.trim();
        } else {
          rejection = `effectiveFrom was not a date: ${JSON.stringify(cell)}`;
        }
        continue;
      }

      fields[field] = cellToField(cell);
    }

    if (rejection !== undefined) {
      rejectedRows.push({ row: sheetRow, client, reason: rejection });
      continue;
    }

    rows.push(effectiveFrom === undefined ? { client, fields } : { client, fields, effectiveFrom });
  }

  return { rows, rejectedRows };
}
