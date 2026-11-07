import { describe, expect, it } from "vitest";
import type { Profile } from "../../../src/domain/profile/schema.js";
import { reconcile } from "../../../src/domain/reconcile/index.js";
import { periodsInWindow, windowBounds } from "../../../src/domain/reconcile/period.js";
import type { RepositorySnapshot, WorkbookSnapshot } from "../../../src/domain/reconcile/types.js";

/**
 * `asOf` is the single month the whole report is computed from, and it comes
 * from a caller. Every other month in the engine was already guarded -- the
 * renderer's month tokens, a month parsed out of a filename, a workbook's
 * effectiveFrom -- and this one was not.
 *
 * Left unguarded it did not fail, which is the problem: an `asOf` of month 0
 * produced a report whose header named a month that does not exist while the
 * last period the report actually contained was the December before it. The
 * realistic source of a month 0 is `Date.prototype.getMonth()`, which is
 * zero-based, so a caller written the obvious way would drop one month of
 * every client's obligations every January and report the loss nowhere.
 */
function buildProfile(): Profile {
  return {
    profileId: "example",
    identity: {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      library: "Compliance Reports",
      workbookPath: "/Trackers/Tracker.xlsx",
    },
    sites: [{
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      library: "Compliance Reports",
      workbookPath: "/Trackers/Tracker.xlsx",
    }],
    taxonomy: { segments: ["{year}", "{client}", "{month:02}-{monthName}"] },
    naming: { template: "{year}-{month:02}_{client}_{deliverable}.xlsx", recognizers: [] },
    deliverables: [
      {
        id: "monthly-safety",
        token: "Safety",
        cadence: "monthly",
        periodAnchor: "last",
        appliesTo: { workbookField: "monthlySafety", truthy: true },
      },
    ],
    workbookMapping: {
      source: { kind: "table", name: "ClientRoster" },
      headerRow: 1,
      columns: { client: "Client", monthlySafety: "Monthly Safety" },
    },
    window: { mode: "rolling", months: 6, respectEffectiveFrom: false },
  };
}

const workbook: WorkbookSnapshot = {
  rows: [{ client: "CLIENTA", fields: { monthlySafety: "Yes" } }],
  source: "/Trackers/Tracker.xlsx#ClientRoster",
  rejectedRows: [],
};

const repository: RepositorySnapshot = {
  files: [],
  folderPaths: [],
  scannedAt: "2026-06-30T00:00:00Z",
  searchCrossCheckIncluded: true,
};

describe("windowBounds rejections for an asOf that is not a real month", () => {
  it("rejects a zero month and quotes the value", () => {
    expect(() => windowBounds({ year: 2026, month: 0 }, 6)).toThrow(
      /asOf does not name a real calendar month: month must be between 1 and 12, got 0/,
    );
  });

  it("names getMonth as the likely cause and says what to do about it", () => {
    // The action matters more than the complaint here: the caller is holding
    // a Date and the fix is one addition, not a redesign.
    expect(() => windowBounds({ year: 2026, month: 0 }, 6)).toThrow(/getMonth\(\) returns 0 for January and needs 1 added to it/);
  });

  it("rejects a month past December", () => {
    expect(() => windowBounds({ year: 2026, month: 13 }, 6)).toThrow(/month must be between 1 and 12, got 13/);
  });

  it("rejects a fractional month", () => {
    expect(() => windowBounds({ year: 2026, month: 6.5 }, 6)).toThrow(/month must be between 1 and 12, got 6.5/);
  });

  it("refuses through periodsInWindow, which reads its bounds from here", () => {
    expect(() => periodsInWindow({ asOf: { year: 2026, month: 0 }, months: 6, cadence: "monthly", anchor: "last" })).toThrow(
      /asOf does not name a real calendar month/,
    );
  });

  it("refuses through reconcile, so no report can carry an impossible window", () => {
    expect(() => reconcile(buildProfile(), workbook, repository, { year: 2026, month: 0 })).toThrow(
      /asOf does not name a real calendar month/,
    );
  });

  it("accepts both edges of the year", () => {
    // Guards the guard: a check that rejected everything would satisfy every
    // assertion above and break the engine.
    expect(windowBounds({ year: 2026, month: 1 }, 1)).toEqual({ from: { year: 2026, month: 1 }, to: { year: 2026, month: 1 } });
    expect(windowBounds({ year: 2026, month: 12 }, 1)).toEqual({ from: { year: 2026, month: 12 }, to: { year: 2026, month: 12 } });
  });
});

/**
 * The same gap reached through the other field of the same object. Guarding
 * the month left the year trusted, and `toIndex` multiplies the year by 12, so
 * a fraction there propagates into both bounds while `periodsInWindow` floors
 * its span indices and derives whole months: the header names two months that
 * do not exist over a body that contains twelve that do.
 *
 * Lower reach than month 0 had -- `Date.prototype.getFullYear()` always returns
 * an integer and there is no zero-versus-one-based trap on a year -- but it is
 * the same defect, and "both ends are checked" has to be true of the whole
 * Period rather than half of it.
 */
describe("windowBounds rejections for an asOf that is not a real year", () => {
  it("rejects a fractional year and quotes the value", () => {
    expect(() => windowBounds({ year: 2026.7, month: 6 }, 6)).toThrow(
      /asOf does not name a real calendar year: year must be a whole number between 1000 and 9999, got 2026.7/,
    );
  });

  it("says what to do about it", () => {
    expect(() => windowBounds({ year: 2026.7, month: 6 }, 6)).toThrow(/Pass a whole year/);
  });

  it("rejects a year too short to render as four digits", () => {
    // The year renders into the expected path and filename through
    // String(year), and the canonical matcher reads it back as \d{4}, so a
    // three-digit year is outside what the engine can round-trip.
    expect(() => windowBounds({ year: 999, month: 6 }, 6)).toThrow(/got 999/);
  });

  it("rejects a year too long to render as four digits", () => {
    expect(() => windowBounds({ year: 12345, month: 6 }, 6)).toThrow(/got 12345/);
  });

  it("rejects a zero year", () => {
    expect(() => windowBounds({ year: 0, month: 6 }, 6)).toThrow(/got 0/);
  });

  it("refuses through reconcile, so no report can carry an impossible window", () => {
    expect(() => reconcile(buildProfile(), workbook, repository, { year: 2026.7, month: 6 })).toThrow(
      /asOf does not name a real calendar year/,
    );
  });

  it("accepts the four-digit years either side of the range", () => {
    // Guards the guard, and pins that ordinary years are untouched.
    expect(windowBounds({ year: 1000, month: 6 }, 1)).toEqual({ from: { year: 1000, month: 6 }, to: { year: 1000, month: 6 } });
    expect(windowBounds({ year: 9999, month: 6 }, 1)).toEqual({ from: { year: 9999, month: 6 }, to: { year: 9999, month: 6 } });
    expect(windowBounds({ year: 2026, month: 6 }, 6)).toEqual({ from: { year: 2026, month: 1 }, to: { year: 2026, month: 6 } });
  });
});
