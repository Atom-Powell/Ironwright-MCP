/**
 * Fixed English month names, index 0 = January. Deliberately not locale-derived:
 * these render directly into repository folder and file names, which are data
 * rather than presentation, so a server running under a different locale must
 * still produce byte-identical paths. The filename parser turns a captured
 * name back into a number by scanning this same list, so a name added or
 * reworded here changes both directions at once instead of drifting apart.
 */
export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * The one place "is this a real month" is decided. Every renderer token that
 * reads a period's month runs its value through this first, so an invalid
 * month fails the same way (a thrown error naming the bad value) no matter
 * which token a template happens to use, rather than only the tokens that
 * remembered to check.
 */
export function assertValidMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`month must be between 1 and 12, got ${month}`);
  }
}

export function monthName(month: number): string {
  assertValidMonth(month);
  // Safe: assertValidMonth has already confirmed month - 1 is 0..11, which is
  // exactly the index range MONTH_NAMES covers.
  return MONTH_NAMES[month - 1]!;
}
