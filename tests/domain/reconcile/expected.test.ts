import { describe, expect, it } from "vitest";
import { deriveExpected } from "../../../src/domain/reconcile/expected.js";
import type { Profile } from "../../../src/domain/profile/schema.js";
import type { ArtifactFinding, ClientRecord, WorkbookSnapshot } from "../../../src/domain/reconcile/types.js";

// A local, independent copy of month names. Deliberately not imported from the
// engine: this test derives its expected strings by hand so a bug in the
// engine's own month table (or in renderTemplate/renderPath) cannot cancel
// itself out against a test that reaches for the same broken helper.
const MONTH_NAMES = [
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
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// The deliverable's id ("monthly-training") is deliberately spelled
// differently from its token ("MonthlyTraining"): the finding's own
// `deliverable` field must carry the id, while the rendered path and name
// must carry the token. Using the same string for both would let the engine
// silently swap one for the other without any test noticing.
function monthlyPath(client: string, year: number, month: number): string {
  return `${year}/${client}/${pad2(month)}-${MONTH_NAMES[month - 1]}`;
}

function monthlyName(client: string, year: number, month: number, token: string): string {
  return `${year}-${pad2(month)}_${client}_${token}.xlsx`;
}

function finding(
  client: string,
  deliverableId: string,
  year: number,
  month: number,
  expectedPath: string,
  expectedName: string,
): ArtifactFinding {
  return {
    client,
    deliverable: deliverableId,
    period: { year, month },
    expectedPath,
    expectedName,
    state: "missing",
  };
}

// Window months (7) is not a multiple of the quarterly span (3), and asOf
// (November) is not a quarter or year boundary, so the quarterly deliverable
// below exercises a span that is genuinely clipped by the window rather than
// one that happens to divide it evenly.
const asOf = { year: 2026, month: 11 };

function buildProfile(windowOverrides: Partial<Profile["window"]> = {}): Profile {
  return {
    profileId: "example",
    identity: {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      library: "Compliance Reports",
      workbookPath: "/Trackers/Tracker.xlsx",
    },
    taxonomy: { segments: ["{year}", "{client}", "{month:02}-{monthName}"] },
    naming: { template: "{year}-{month:02}_{client}_{deliverable}.xlsx", recognizers: [] },
    deliverables: [
      {
        id: "monthly-training",
        token: "MonthlyTraining",
        cadence: "monthly",
        periodAnchor: "last",
        appliesTo: { workbookField: "monthlyTraining", truthy: true },
      },
      {
        id: "quarterly-phishing",
        token: "QuarterlyPhishing",
        cadence: "quarterly",
        periodAnchor: "last",
        appliesTo: { workbookField: "quarterlyPhishing", truthy: true },
      },
    ],
    workbookMapping: {
      source: { kind: "table", name: "ClientRoster" },
      headerRow: 1,
      columns: {
        client: "Client",
        monthlyTraining: "Monthly Training",
        quarterlyPhishing: "Quarterly Phishing",
        effectiveFrom: "Onboarded",
      },
    },
    window: { mode: "rolling", months: 7, respectEffectiveFrom: false, ...windowOverrides },
  };
}

function buildWorkbook(rows: ClientRecord[]): WorkbookSnapshot {
  return { rows, source: "test-fixture", rejectedRows: [] };
}

describe("deriveExpected", () => {
  it("produces one artifact per month in the window for a monthly deliverable, with the correct rendered path and name", () => {
    const profile = buildProfile();
    const workbook = buildWorkbook([{ client: "CLIENTA", fields: { monthlyTraining: "Yes", quarterlyPhishing: false } }]);

    const result = deriveExpected(profile, workbook, asOf);

    // Window is May..Nov 2026: seven months, deliberately spanning both
    // single-digit (May-Sep) and double-digit (Oct, Nov) month numbers, so a
    // padding bug in {month:02} cannot hide in a window that never reaches 10.
    expect(result).toEqual([
      finding("CLIENTA", "monthly-training", 2026, 5, monthlyPath("CLIENTA", 2026, 5), monthlyName("CLIENTA", 2026, 5, "MonthlyTraining")),
      finding("CLIENTA", "monthly-training", 2026, 6, monthlyPath("CLIENTA", 2026, 6), monthlyName("CLIENTA", 2026, 6, "MonthlyTraining")),
      finding("CLIENTA", "monthly-training", 2026, 7, monthlyPath("CLIENTA", 2026, 7), monthlyName("CLIENTA", 2026, 7, "MonthlyTraining")),
      finding("CLIENTA", "monthly-training", 2026, 8, monthlyPath("CLIENTA", 2026, 8), monthlyName("CLIENTA", 2026, 8, "MonthlyTraining")),
      finding("CLIENTA", "monthly-training", 2026, 9, monthlyPath("CLIENTA", 2026, 9), monthlyName("CLIENTA", 2026, 9, "MonthlyTraining")),
      finding("CLIENTA", "monthly-training", 2026, 10, monthlyPath("CLIENTA", 2026, 10), monthlyName("CLIENTA", 2026, 10, "MonthlyTraining")),
      finding("CLIENTA", "monthly-training", 2026, 11, monthlyPath("CLIENTA", 2026, 11), monthlyName("CLIENTA", 2026, 11, "MonthlyTraining")),
    ]);
  });

  it("produces one artifact per quarter for a quarterly deliverable, anchored to the quarter's last month", () => {
    const profile = buildProfile();
    const workbook = buildWorkbook([{ client: "CLIENTA", fields: { monthlyTraining: false, quarterlyPhishing: "Yes" } }]);

    const result = deriveExpected(profile, workbook, asOf);

    // Of the window's two quarters that close inside May..Nov (Q2 anchored
    // to June, Q3 anchored to September), Q3's own last month (September) is
    // not the window edge and Q4 has not closed yet, so this also proves the
    // deliverable's cadence clips independently of the monthly window above.
    expect(result).toEqual([
      finding(
        "CLIENTA",
        "quarterly-phishing",
        2026,
        6,
        monthlyPath("CLIENTA", 2026, 6),
        monthlyName("CLIENTA", 2026, 6, "QuarterlyPhishing"),
      ),
      finding(
        "CLIENTA",
        "quarterly-phishing",
        2026,
        9,
        monthlyPath("CLIENTA", 2026, 9),
        monthlyName("CLIENTA", 2026, 9, "QuarterlyPhishing"),
      ),
    ]);
  });

  it("produces artifacts for both deliverables when a client owes two, monthly first in profile order then quarterly", () => {
    const profile = buildProfile();
    const workbook = buildWorkbook([{ client: "CLIENTA", fields: { monthlyTraining: "Yes", quarterlyPhishing: "Yes" } }]);

    const result = deriveExpected(profile, workbook, asOf);

    expect(result).toHaveLength(9);
    expect(result.filter((f) => f.deliverable === "monthly-training")).toHaveLength(7);
    expect(result.filter((f) => f.deliverable === "quarterly-phishing")).toHaveLength(2);
    // Cross-product order: this client's monthly artifacts precede its
    // quarterly ones because deliverables are walked in profile order.
    expect(result[0]?.deliverable).toBe("monthly-training");
    expect(result[8]?.deliverable).toBe("quarterly-phishing");
    expect(result[8]?.expectedName).toBe(monthlyName("CLIENTA", 2026, 9, "QuarterlyPhishing"));
  });

  it("owes nothing when the workbook field is an ordinary falsey value", () => {
    const profile = buildProfile();
    const workbook = buildWorkbook([
      { client: "CLIENTB", fields: { monthlyTraining: false, quarterlyPhishing: 0 } },
      { client: "CLIENTC", fields: { monthlyTraining: "", quarterlyPhishing: null } },
    ]);

    expect(deriveExpected(profile, workbook, asOf)).toEqual([]);
  });

  it("treats the hand-typed words \"no\" and \"false\" as falsey, regardless of case", () => {
    const profile = buildProfile();
    const workbook = buildWorkbook([
      { client: "CLIENTD", fields: { monthlyTraining: "No", quarterlyPhishing: "FALSE" } },
      { client: "CLIENTE", fields: { monthlyTraining: "no", quarterlyPhishing: "false" } },
    ]);

    expect(deriveExpected(profile, workbook, asOf)).toEqual([]);
  });

  it("does not throw when a deliverable's workbook field is absent from the row, and treats it as not owed", () => {
    const profile = buildProfile();
    // quarterlyPhishing is left out of fields entirely, as if that column's
    // cell was blank when the workbook was parsed, rather than holding an
    // explicit false-like value.
    const workbook = buildWorkbook([{ client: "CLIENTF", fields: { monthlyTraining: "Yes" } }]);

    const result = deriveExpected(profile, workbook, asOf);

    expect(result).toHaveLength(7);
    expect(result.every((f) => f.deliverable === "monthly-training")).toBe(true);
  });

  it("excludes periods before the client's effective date only when respectEffectiveFrom is set", () => {
    const profile = buildProfile({ respectEffectiveFrom: true });
    // The 15th, not the 1st: proves the day is discarded rather than shifting
    // the boundary by one period in either direction.
    const workbook = buildWorkbook([
      { client: "CLIENTG", fields: { monthlyTraining: "Yes", quarterlyPhishing: false }, effectiveFrom: "2026-08-15" },
    ]);

    const result = deriveExpected(profile, workbook, asOf);

    // Window is May..Nov; effective date falls in August, so May/Jun/Jul are
    // excluded and August itself (the effective month) is included.
    expect(result).toEqual([
      finding("CLIENTG", "monthly-training", 2026, 8, monthlyPath("CLIENTG", 2026, 8), monthlyName("CLIENTG", 2026, 8, "MonthlyTraining")),
      finding("CLIENTG", "monthly-training", 2026, 9, monthlyPath("CLIENTG", 2026, 9), monthlyName("CLIENTG", 2026, 9, "MonthlyTraining")),
      finding("CLIENTG", "monthly-training", 2026, 10, monthlyPath("CLIENTG", 2026, 10), monthlyName("CLIENTG", 2026, 10, "MonthlyTraining")),
      finding("CLIENTG", "monthly-training", 2026, 11, monthlyPath("CLIENTG", 2026, 11), monthlyName("CLIENTG", 2026, 11, "MonthlyTraining")),
    ]);
  });

  it("ignores the client's effective date when respectEffectiveFrom is not set", () => {
    const profile = buildProfile({ respectEffectiveFrom: false });
    const workbook = buildWorkbook([
      { client: "CLIENTG", fields: { monthlyTraining: "Yes", quarterlyPhishing: false }, effectiveFrom: "2026-08-15" },
    ]);

    const result = deriveExpected(profile, workbook, asOf);

    // Same client and effective date as the test above, but the profile does
    // not opt into respecting it, so all seven months of the window appear.
    expect(result).toHaveLength(7);
    expect(result[0]?.period).toEqual({ year: 2026, month: 5 });
  });
});
