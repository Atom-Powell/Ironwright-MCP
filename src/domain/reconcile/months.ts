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

export function monthName(month: number): string {
  const name = MONTH_NAMES[month - 1];
  if (name === undefined) {
    throw new Error(`month must be between 1 and 12, got ${month}`);
  }
  return name;
}
