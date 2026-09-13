import { z } from "zod";
import { CadenceSchema, PeriodAnchorSchema } from "../profile/schema.js";
import { assertValidMonth } from "./months.js";
import type { Period } from "./types.js";

// Derived from the profile schema rather than restated here: the schema is the
// one place a cadence or anchor value is declared valid, and a second, locally
// invented union could drift from it silently.
export type Cadence = z.infer<typeof CadenceSchema>;
export type PeriodAnchor = z.infer<typeof PeriodAnchorSchema>;

// Cadence as a span of months, not a distinct branch per value. Quarterly,
// semiannual and annual differ from monthly only in how many months make up
// one period, so they fall out of the same arithmetic instead of each needing
// its own case that a future cadence could be added without.
const CADENCE_MONTHS: Record<Cadence, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

// A period as an absolute month index (year * 12 + zero-based month) turns
// "add N months" and "which quarter is this in" into ordinary integer
// arithmetic, and crossing a December-to-January boundary needs no special
// case: it is just index + 1.
function toIndex(period: Period): number {
  return period.year * 12 + (period.month - 1);
}

function fromIndex(index: number): Period {
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return { year, month };
}

/**
 * Maps any month inside a cadence's span to the one month that represents the
 * whole span. A quarterly deliverable is reported once per quarter, and this
 * is what decides which of the quarter's three months that report is filed
 * under, in both directions: rendering an expected path and comparing a
 * parsed file's month both go through this function so they cannot disagree.
 */
export function anchorPeriod(period: Period, cadence: Cadence, anchor: PeriodAnchor): Period {
  const span = CADENCE_MONTHS[cadence];
  const spanStart = Math.floor(toIndex(period) / span) * span;
  const anchorIndex = anchor === "last" ? spanStart + span - 1 : spanStart;
  return fromIndex(anchorIndex);
}

/**
 * The inclusive first and last month of a trailing window of `months` ending
 * at `asOf`.
 *
 * This exists so the report can state the window it covers without restating
 * the arithmetic: `periodsInWindow` below reads its own bounds from here, so a
 * report header and the periods the report actually contains cannot disagree
 * about where the window starts. A report that claims a window it did not
 * compute is exactly the message-versus-outcome defect this project keeps
 * relearning.
 *
 * Both ends are checked and derived, not just the start, and both fields of
 * `asOf` are checked rather than only its month. `asOf` is the one period the
 * entire report is computed from and it arrives from a caller, so it is
 * validated here rather than trusted, and `to` is round-tripped through the
 * index the same way `from` is rather than handed back as the caller's own
 * object.
 *
 * Skipping any of that let the window this returns disagree with the periods
 * derived from it. An `asOf` of month 0 returned a `to` of `{2026, 0}` while
 * the last period was 2025-12, and the realistic source of a month 0 is not an
 * exotic caller but `Date.prototype.getMonth()`, which is zero-based, so a tool
 * built on it would drop a month of every client's obligations every January
 * and say nothing. A fractional year reached the same disagreement through the
 * other field, because `toIndex` multiplies the year by 12 and carries the
 * fraction into both bounds while every derived period is a whole month.
 *
 * The year's range is four digits because that is what the engine can
 * round-trip: `renderTemplate` writes `{year}` into the expected path and
 * filename as `String(year)`, and the filename parser reads a year back as
 * `\d{4}`.
 */
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;

export function windowBounds(asOf: Period, months: number): { from: Period; to: Period } {
  if (!Number.isInteger(asOf.year) || asOf.year < MIN_YEAR || asOf.year > MAX_YEAR) {
    throw new Error(
      `asOf does not name a real calendar year: year must be a whole number between ${MIN_YEAR} and ${MAX_YEAR}, got ${asOf.year}. Pass a whole year; the value renders straight into the expected path and filename as digits.`,
    );
  }

  try {
    assertValidMonth(asOf.month);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `asOf does not name a real calendar month: ${reason}. Months here are one-based, so January is 1; Date.prototype.getMonth() returns 0 for January and needs 1 added to it.`,
    );
  }

  const asOfIndex = toIndex(asOf);
  return { from: fromIndex(asOfIndex - months + 1), to: fromIndex(asOfIndex) };
}

export interface PeriodsInWindowArgs {
  /** The reference date. Never the clock: the caller supplies it. */
  asOf: Period;
  /** How many trailing months, ending at and including asOf, the window covers. */
  months: number;
  cadence: Cadence;
  anchor: PeriodAnchor;
  /** When set, periods anchored before this are excluded from the result. */
  effectiveFrom?: Period;
}

/**
 * Every anchored period whose anchor month falls inside the trailing window,
 * oldest first. A monthly cadence yields one entry per month; a quarterly,
 * semiannual or annual cadence yields one entry per span, each reduced to its
 * anchored month by the same rule `anchorPeriod` applies everywhere else.
 *
 * The window is scanned in whole spans (`firstSpanStart` to `lastSpanStart`)
 * because a span straddling the window's edge still needs to be considered:
 * with a `first` anchor, a span that starts before the window can still have
 * its anchor (its first month) land inside it. But the same straddling means
 * a span's anchor can land on the far side of *either* edge: with a `last`
 * anchor and `asOf` mid-span, the span's last month is later than `asOf`, and
 * with a `first` anchor, an earlier span's first month can be earlier than
 * the window start. Both are excluded below by checking the anchor itself
 * against the window, not just the span it came from. Skipping only the
 * upper bound would still let a not-yet-closed period into a report whose
 * entire premise is that a period is reported after it closes; skipping only
 * the lower bound would still let a stale period back in.
 */
export function periodsInWindow(args: PeriodsInWindowArgs): Period[] {
  const { asOf, months, cadence, anchor, effectiveFrom } = args;
  const span = CADENCE_MONTHS[cadence];

  const bounds = windowBounds(asOf, months);
  const windowStartIndex = toIndex(bounds.from);
  const windowEndIndex = toIndex(bounds.to);

  const firstSpanStart = Math.floor(windowStartIndex / span) * span;
  const lastSpanStart = Math.floor(windowEndIndex / span) * span;

  const effectiveFromIndex = effectiveFrom ? toIndex(effectiveFrom) : undefined;

  const periods: Period[] = [];
  for (let spanStart = firstSpanStart; spanStart <= lastSpanStart; spanStart += span) {
    const anchorIndex = anchor === "last" ? spanStart + span - 1 : spanStart;
    if (anchorIndex < windowStartIndex || anchorIndex > windowEndIndex) continue;
    if (effectiveFromIndex !== undefined && anchorIndex < effectiveFromIndex) continue;
    periods.push(fromIndex(anchorIndex));
  }
  return periods;
}
