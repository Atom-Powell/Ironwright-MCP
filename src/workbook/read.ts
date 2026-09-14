import type { Profile } from "../domain/profile/schema.js";
import { isIsoEffectiveFrom } from "../domain/reconcile/index.js";
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
  const duplicatedHeaders = new Set<string>();
  header.forEach((cell, index) => {
    if (typeof cell !== "string") return;
    const text = cell.trim();
    if (text.length === 0) return;
    if (headerIndexByText.has(text)) duplicatedHeaders.add(text);
    else headerIndexByText.set(text, index);
  });

  const columnIndexByField = new Map<string, number>();
  const mappedHeaders = new Set(Object.values(profile.workbookMapping.columns));
  const missing: string[] = [];
  for (const [field, headerText] of Object.entries(profile.workbookMapping.columns)) {
    const index = headerIndexByText.get(headerText);
    if (index === undefined) missing.push(headerText);
    else columnIndexByField.set(field, index);
  }

  if (missing.length > 0) {
    // Every missing header at once. Reporting the first only costs an operator
    // one failed run per renamed column, and a mapping usually goes stale in
    // batches when someone tidies a spreadsheet. The sentence agrees with itself
    // in both directions because an operator reads it whole, and a plural list
    // under a singular noun reads like a bug in the tool rather than in the
    // workbook.
    const several = missing.length > 1;
    throw new WorkbookMappingError(
      `The workbook has no ${several ? "columns" : "column"} headed ` +
        `${missing.map((text) => `"${text}"`).join(", ")} on row ${profile.workbookMapping.headerRow} of the ` +
        "range that was read. " +
        `The profile's workbookMapping names ${several ? "them" : "it"}, so either ` +
        `${several ? "those columns were" : "that column was"} renamed in the workbook or the mapping ` +
        "was written against a different sheet.",
    );
  }

  // Only the headers the mapping names. A workbook is free to carry two
  // columns headed "Notes" if nothing reads them, but two headed "Client" are
  // two different columns answering to one mapping entry, and they can hold
  // different values. Taking either one is a guess, and the guess is silent:
  // picking the wrong "Client" column reads every row as blank, and the
  // report comes back empty and confident, which is the same failure the
  // clientIndex guard below exists to refuse. The engine refuses a duplicated
  // client row outright rather than merging it; this is the same refusal one
  // layer earlier.
  const ambiguous = [...duplicatedHeaders].filter((text) => mappedHeaders.has(text));
  if (ambiguous.length > 0) {
    const several = ambiguous.length > 1;
    throw new WorkbookMappingError(
      `The workbook has more than one column headed ${ambiguous.map((text) => `"${text}"`).join(", ")} on ` +
        `row ${profile.workbookMapping.headerRow} of the range that was read. The profile's workbookMapping ` +
        `names ${several ? "them" : "it"}, and the repeated columns can hold different values, so which ` +
        `${several ? "of them governs is" : "one governs is"} ambiguous. Rename or remove the duplicate ` +
        `${several ? "columns" : "column"}, or point the mapping at a different sheet.`,
    );
  }

  const clientIndex = columnIndexByField.get("client");
  // Guarded rather than asserted, because the invariant that makes this safe is
  // owned by two other places: the profile schema requires a client column, and
  // the missing-header check above has already thrown if the sheet lacks one. An
  // unchecked lookup stays correct only while both hold, and the failure if
  // either moves is silent rather than loud: indexing a row by undefined reads
  // as an empty cell, so every row would be skipped as blank and the report
  // would come back empty and confident.
  if (clientIndex === undefined) {
    throw new WorkbookMappingError(
      "The profile's workbookMapping names no client column, so no row could be attributed to a client. " +
        "The profile schema requires one, so reaching this point means the schema and this reader disagree.",
    );
  }
  // A malformed effective date is only worth a rejection when something reads
  // the field. With respectEffectiveFrom off the engine never looks at it, so
  // rejecting the row would cost an operator a whole client out of a
  // compliance report over a cell nothing consults. A readable value is still
  // carried through either way, since dropping data the sheet holds is a
  // different kind of loss.
  const respectEffectiveFrom = profile.window.respectEffectiveFrom;

  const rows: ClientRecord[] = [];
  const rejectedRows: RejectedWorkbookRow[] = [];

  for (let index = headerRowIndex + 1; index < grid.length; index += 1) {
    // Numbered within the range Graph returned, not within the sheet. For a
    // table the range is the table's own, so a table starting at sheet row 12
    // numbers its header row 1 here and its first data row 2.
    // `RejectedWorkbookRow` carries the same caveat at the field an operator
    // reads, and says what it would take to make the number absolute.
    const rangeRow = index + 1;
    const cells = grid[index];
    if (cells === undefined) continue;

    const clientCell = cells[clientIndex];

    // Three cases, and the line between the first two carries the weight. An
    // absent, null or blank-string client cell is a trailing empty row, which
    // every spreadsheet has below its table: skipped silently, because
    // rejecting those would bury one real rejection under dozens of false ones.
    // Anything else in that cell was put there by someone and still cannot be
    // read as a client name, so it is rejected rather than skipped. Excel hands
    // back a numeric client code as a number, and coercing 4021 to "4021" would
    // be a guess about whether it matches the repository's folder names, while
    // skipping it would drop a client out of a compliance report with no trace.
    // A rejection is visible, and the operator decides.
    if (clientCell === undefined || clientCell === null) continue;

    if (typeof clientCell !== "string") {
      rejectedRows.push({
        row: rangeRow,
        reason: `the client cell was not text: ${JSON.stringify(clientCell)}`,
      });
      continue;
    }

    const client = clientCell.trim();
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
          if (converted !== undefined) effectiveFrom = converted;
          else if (respectEffectiveFrom) {
            rejection = `effectiveFrom was not a usable date: ${JSON.stringify(cell)}`;
          }
          // Screened against the engine's own predicate rather than a pattern
          // of this module's, because a value this reader accepts is a value
          // the engine has to be able to read: the two rules disagreeing is
          // how a hand-typed cell got past here and then aborted the report
          // from inside the engine.
        } else if (typeof cell === "string" && isIsoEffectiveFrom(cell.trim())) {
          effectiveFrom = cell.trim();
        } else if (respectEffectiveFrom) {
          rejection = `effectiveFrom was not a date: ${JSON.stringify(cell)}`;
        }
        continue;
      }

      fields[field] = cellToField(cell);
    }

    if (rejection !== undefined) {
      rejectedRows.push({ row: rangeRow, client, reason: rejection });
      continue;
    }

    rows.push(effectiveFrom === undefined ? { client, fields } : { client, fields, effectiveFrom });
  }

  return { rows, rejectedRows };
}
