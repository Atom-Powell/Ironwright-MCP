import { describe, expect, it } from "vitest";
import { deriveExpected } from "../../../src/domain/reconcile/expected.js";
import type { Profile } from "../../../src/domain/profile/schema.js";
import type { WorkbookSnapshot } from "../../../src/domain/reconcile/types.js";

// Nothing validates a workbook cell's contents the way the profile validator
// validates the profile itself, so respectEffectiveFrom is the only path
// that ever reads a row's effectiveFrom string as-is.
function buildProfile(): Profile {
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
    ],
    workbookMapping: {
      source: { kind: "table", name: "ClientRoster" },
      headerRow: 1,
      columns: { client: "Client", monthlyTraining: "Monthly Training", effectiveFrom: "Onboarded" },
    },
    window: { mode: "rolling", months: 6, respectEffectiveFrom: true },
  };
}

function buildWorkbook(effectiveFrom: string): WorkbookSnapshot {
  return {
    rows: [{ client: "CLIENTX", fields: { monthlyTraining: "Yes" }, effectiveFrom }],
    source: "test-fixture",
  };
}

const asOf = { year: 2026, month: 11 };

// Before this check, one bad cell aborted the whole run with a message that
// named neither the offending client nor the value, leaving an operator to
// bisect a fifty-row spreadsheet to find it. A hand-maintained tracker is
// exactly where a date typed day-first (rather than ISO) shows up.
describe("deriveExpected rejections for a malformed effectiveFrom", () => {
  it("names the client and quotes the value when effectiveFrom is not an ISO date", () => {
    const profile = buildProfile();
    const workbook = buildWorkbook("15/08/2026");

    expect(() => deriveExpected(profile, workbook, asOf)).toThrow(
      'client "CLIENTX" has an effectiveFrom that is not an ISO date: "15/08/2026"',
    );
  });

  it("names the client and quotes the value when effectiveFrom names an out-of-range month", () => {
    const profile = buildProfile();
    const workbook = buildWorkbook("2026-13-01");

    expect(() => deriveExpected(profile, workbook, asOf)).toThrow(
      'client "CLIENTX" has an invalid effectiveFrom "2026-13-01": month must be between 1 and 12, got 13',
    );
  });
});
