import { z } from "zod";
import { CadenceSchema, PeriodAnchorSchema } from "../profile/schema.js";
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
 * Every anchored period whose cadence span falls inside the trailing window,
 * oldest first. A monthly cadence yields one entry per month; a quarterly,
 * semiannual or annual cadence yields one entry per span, each reduced to its
 * anchored month by the same rule `anchorPeriod` applies everywhere else.
 */
export function periodsInWindow(args: PeriodsInWindowArgs): Period[] {
  const { asOf, months, cadence, anchor, effectiveFrom } = args;
  const span = CADENCE_MONTHS[cadence];

  const windowStartIndex = toIndex(asOf) - months + 1;
  const windowEndIndex = toIndex(asOf);

  const firstSpanStart = Math.floor(windowStartIndex / span) * span;
  const lastSpanStart = Math.floor(windowEndIndex / span) * span;

  const effectiveFromIndex = effectiveFrom ? toIndex(effectiveFrom) : undefined;

  const periods: Period[] = [];
  for (let spanStart = firstSpanStart; spanStart <= lastSpanStart; spanStart += span) {
    const anchorIndex = anchor === "last" ? spanStart + span - 1 : spanStart;
    if (effectiveFromIndex !== undefined && anchorIndex < effectiveFromIndex) continue;
    periods.push(fromIndex(anchorIndex));
  }
  return periods;
}
