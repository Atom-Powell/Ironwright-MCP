/**
 * The workbook's contents, derived from the same SeedPlan the tree was built
 * from so the two sides of the reconciliation cannot drift apart.
 */
import type { SeedPlan } from "../seed-library.js";

/** Exactly the headers examples/profiles/example.json maps in workbookMapping.columns. */
export const WORKBOOK_HEADERS = ["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"];

/**
 * Excel counts days from 1899-12-30 rather than 1900-01-01, which absorbs the
 * 1900 leap year that Excel believes in and the calendar does not. Only dates
 * after 1900-03-01 are produced here, so that offset is the whole conversion.
 */
export function excelDateSerial(year: number, month: number, day: number): number {
  const epoch = Date.UTC(1899, 11, 30);
  return (Date.UTC(year, month - 1, day) - epoch) / 86_400_000;
}

/**
 * "Yes" rather than true. The engine's isOwed treats "no" and "false" as
 * falsey regardless of case and everything else as owed, which is a rule
 * written for hand-maintained trackers that record ownership as text. A
 * boolean cell would route around it.
 */
const OWED = "Yes";

export function workbookGrid(plan: SeedPlan): (string | number)[][] {
  // January 1 of the seeded year for every client. With respectEffectiveFrom
  // on, this excludes the months of the previous calendar year that the
  // rolling window reaches back into, and those months have no folders, so
  // without it every client would show a run of missing artifacts nobody
  // planted.
  const onboarded = excelDateSerial(plan.year, 1, 1);
  return [
    [...WORKBOOK_HEADERS],
    ...plan.workbookClients.map((client) => [client, OWED, OWED, onboarded]),
  ];
}
