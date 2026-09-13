import { describe, expect, it } from "vitest";
import { anchorPeriod, periodsInWindow, windowBounds } from "../../../src/domain/reconcile/period.js";

const asOf = { year: 2026, month: 6 };

describe("windowBounds", () => {
  it("returns the inclusive first and last month of the trailing window", () => {
    expect(windowBounds(asOf, 6)).toEqual({ from: { year: 2026, month: 1 }, to: { year: 2026, month: 6 } });
  });

  it("crosses a year boundary at the start", () => {
    expect(windowBounds({ year: 2026, month: 2 }, 6)).toEqual({
      from: { year: 2025, month: 9 },
      to: { year: 2026, month: 2 },
    });
  });

  it("ends where the periods it feeds end", () => {
    // The property the report header depends on. `to` used to be handed back
    // as the caller's own asOf object without passing through the index that
    // every period the report contains is built from, which is exactly where
    // a header and a body can disagree about the end of the window.
    const bounds = windowBounds(asOf, 6);
    const periods = periodsInWindow({ asOf, months: 6, cadence: "monthly", anchor: "last" });

    expect(periods.at(0)).toEqual(bounds.from);
    expect(periods.at(-1)).toEqual(bounds.to);
  });

  it("returns its own objects rather than aliasing the caller's asOf", () => {
    // A report that held the caller's object would let a later mutation of it
    // change what an already-produced report claims to cover.
    const reference = { year: 2026, month: 6 };

    expect(windowBounds(reference, 6).to).not.toBe(reference);
  });
});

describe("periodsInWindow", () => {
  it("returns one period per month for a monthly cadence, oldest first", () => {
    const periods = periodsInWindow({ asOf, months: 3, cadence: "monthly", anchor: "last" });

    expect(periods).toEqual([
      { year: 2026, month: 4 },
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
    ]);
  });

  it("crosses a year boundary", () => {
    const periods = periodsInWindow({ asOf: { year: 2026, month: 2 }, months: 3, cadence: "monthly", anchor: "last" });

    expect(periods).toEqual([
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
      { year: 2026, month: 2 },
    ]);
  });

  it("returns one period per quarter, anchored to the quarter's last month", () => {
    const periods = periodsInWindow({ asOf, months: 12, cadence: "quarterly", anchor: "last" });

    expect(periods).toEqual([
      { year: 2025, month: 9 },
      { year: 2025, month: 12 },
      { year: 2026, month: 3 },
      { year: 2026, month: 6 },
    ]);
  });

  it("anchors a quarter to its first month when the profile says so", () => {
    const periods = periodsInWindow({ asOf, months: 6, cadence: "quarterly", anchor: "first" });

    expect(periods).toEqual([
      { year: 2026, month: 1 },
      { year: 2026, month: 4 },
    ]);
  });

  it("excludes periods before a client's effective date", () => {
    const periods = periodsInWindow({
      asOf,
      months: 6,
      cadence: "monthly",
      anchor: "last",
      effectiveFrom: { year: 2026, month: 4 },
    });

    expect(periods).toEqual([
      { year: 2026, month: 4 },
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
    ]);
  });

  // asOf deliberately off the quarter boundary (August sits inside, not at
  // the edge of, Jul-Sep). With a "last" anchor the containing quarter's
  // anchor month (September) has not happened relative to asOf, so it must
  // not appear: a report is produced after its period closes, never before.
  it("excludes a quarter that has not closed yet when asOf falls mid-quarter", () => {
    const periods = periodsInWindow({
      asOf: { year: 2026, month: 8 },
      months: 3,
      cadence: "quarterly",
      anchor: "last",
    });

    expect(periods).toEqual([{ year: 2026, month: 6 }]);
  });

  // The mirror image of the case above: with a "first" anchor and the same
  // mid-quarter asOf, the quarter that was already underway before the
  // window opened (Apr-Jun, anchored to April) must not appear either, since
  // April is earlier than the window's own start.
  it("excludes a quarter that started before the window when asOf falls mid-quarter", () => {
    const periods = periodsInWindow({
      asOf: { year: 2026, month: 8 },
      months: 3,
      cadence: "quarterly",
      anchor: "first",
    });

    expect(periods).toEqual([{ year: 2026, month: 7 }]);
  });

  it("returns one period per half-year for a semiannual cadence, anchored to the half's last month", () => {
    const periods = periodsInWindow({
      asOf: { year: 2026, month: 8 },
      months: 6,
      cadence: "semiannual",
      anchor: "last",
    });

    // August is two months into Jul-Dec, so that half has not closed and its
    // anchor (December) must be excluded; only Jan-Jun's anchor (June) has.
    expect(periods).toEqual([{ year: 2026, month: 6 }]);
  });

  it("returns one period per year for an annual cadence, anchored to the year's last month", () => {
    const periods = periodsInWindow({
      asOf: { year: 2026, month: 8 },
      months: 12,
      cadence: "annual",
      anchor: "last",
    });

    // 2026 itself has not closed as of August, so only 2025's anchor
    // (December 2025) falls inside the trailing 12-month window.
    expect(periods).toEqual([{ year: 2025, month: 12 }]);
  });
});

describe("anchorPeriod", () => {
  it("maps any month in a quarter to the quarter's anchored month", () => {
    expect(anchorPeriod({ year: 2026, month: 4 }, "quarterly", "last")).toEqual({ year: 2026, month: 6 });
    expect(anchorPeriod({ year: 2026, month: 6 }, "quarterly", "last")).toEqual({ year: 2026, month: 6 });
    expect(anchorPeriod({ year: 2026, month: 4 }, "quarterly", "first")).toEqual({ year: 2026, month: 4 });
  });

  it("leaves a monthly period alone", () => {
    expect(anchorPeriod({ year: 2026, month: 5 }, "monthly", "last")).toEqual({ year: 2026, month: 5 });
  });

  it("maps any month in a half-year to the half's anchored month", () => {
    expect(anchorPeriod({ year: 2026, month: 8 }, "semiannual", "last")).toEqual({ year: 2026, month: 12 });
    expect(anchorPeriod({ year: 2026, month: 8 }, "semiannual", "first")).toEqual({ year: 2026, month: 7 });
  });

  it("maps any month in a year to the year's anchored month", () => {
    expect(anchorPeriod({ year: 2026, month: 8 }, "annual", "last")).toEqual({ year: 2026, month: 12 });
    expect(anchorPeriod({ year: 2026, month: 8 }, "annual", "first")).toEqual({ year: 2026, month: 1 });
  });
});
