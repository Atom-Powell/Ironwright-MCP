import { describe, expect, it } from "vitest";
import { anchorPeriod, periodsInWindow } from "../../../src/domain/reconcile/period.js";

const asOf = { year: 2026, month: 6 };

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
});
