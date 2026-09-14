import { describe, expect, it } from "vitest";
import type { Profile } from "../../../src/domain/profile/schema.js";
import { deriveExpected } from "../../../src/domain/reconcile/expected.js";
import { reconcile } from "../../../src/domain/reconcile/index.js";
import type { ClientRecord, RepositorySnapshot, WorkbookSnapshot } from "../../../src/domain/reconcile/types.js";

/**
 * A tracker that lists one client on two rows used to double that client's
 * entire report in silence: every expected artifact was derived twice, the
 * matching stage kept one slot per key but mapped over the undeduped finding
 * array, and the per-client rollup counted both copies. A client owed two
 * reports read as owing four, with no error, no warning, and no field in the
 * report an operator could have used to notice.
 *
 * Two rows for one client is also genuinely ambiguous rather than merely
 * redundant: the rows can carry different effectiveFrom dates and different
 * owed-deliverable cells, and nothing in the workbook says which one governs.
 * So the engine refuses the workbook instead of guessing, the same way a
 * malformed effectiveFrom is refused.
 */
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
    // Two months, so a doubled report is 4 findings against a true 2 and the
    // difference cannot be read as an off-by-one.
    window: { mode: "rolling", months: 2, respectEffectiveFrom: false },
  };
}

function row(client: string): ClientRecord {
  return { client, fields: { monthlySafety: "Yes" } };
}

function workbookOf(...rows: ClientRecord[]): WorkbookSnapshot {
  return { rows, source: "/Trackers/Tracker.xlsx#ClientRoster", rejectedRows: [] };
}

const emptyRepository: RepositorySnapshot = {
  files: [],
  folderPaths: [],
  scannedAt: "2026-06-30T00:00:00Z",
  searchCrossCheckIncluded: true,
};

const asOf = { year: 2026, month: 6 };

describe("a workbook listing one client on more than one row", () => {
  it("is refused by deriveExpected, naming the repeated client", () => {
    const workbook = workbookOf(row("CLIENTA"), row("CLIENTA"));

    expect(() => deriveExpected(buildProfile(), workbook, asOf)).toThrow(/client "CLIENTA" appears on more than one workbook row/);
  });

  it("tells the operator what to do about it", () => {
    const workbook = workbookOf(row("CLIENTA"), row("CLIENTA"));

    // The message has to carry an action, not just a complaint: the operator
    // holding the spreadsheet is the only party who can decide which of the
    // two rows is the real one.
    expect(() => deriveExpected(buildProfile(), workbook, asOf)).toThrow(/merge them into one row/);
  });

  it("is refused by reconcile too, so no doubled report can reach a caller", () => {
    const workbook = workbookOf(row("CLIENTA"), row("CLIENTA"));

    expect(() => reconcile(buildProfile(), workbook, emptyRepository, asOf)).toThrow(
      /client "CLIENTA" appears on more than one workbook row/,
    );
  });

  it("is refused even when the repeat is far from the row it repeats", () => {
    // The check is over the whole sheet rather than adjacent rows: a tracker
    // sorted by something other than client is exactly where a repeat hides.
    const workbook = workbookOf(row("CLIENTA"), row("CLIENTB"), row("CLIENTC"), row("CLIENTA"));

    expect(() => deriveExpected(buildProfile(), workbook, asOf)).toThrow(/client "CLIENTA" appears on more than one workbook row/);
  });

  it("is refused even when the repeated client owes nothing", () => {
    // Ownership is per deliverable cell, so a repeated row with every cell
    // blank produces no findings at all and would slip past a check that
    // only looked at rows that generated one. The ambiguity about which row
    // governs is still there.
    const blank: ClientRecord = { client: "CLIENTA", fields: { monthlySafety: "No" } };

    expect(() => deriveExpected(buildProfile(), workbookOf(blank, blank), asOf)).toThrow(
      /client "CLIENTA" appears on more than one workbook row/,
    );
  });
});

describe("a workbook with one row per client", () => {
  it("derives exactly one finding per client, deliverable and period", () => {
    // Guards the guard above. Without this, a check that rejected every
    // workbook would pass every rejection test in this file while destroying
    // the engine.
    const report = reconcile(buildProfile(), workbookOf(row("CLIENTA")), emptyRepository, asOf);

    expect(report.artifacts.map((artifact) => artifact.period)).toEqual([
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
    ]);
    expect(report.clients).toEqual([
      {
        client: "CLIENTA",
        counts: { compliant: 0, misnamed: 0, misplaced: 0, misnamed_and_misplaced: 0, missing: 2 },
        compliant: false,
      },
    ]);
  });

  it("accepts two clients whose rows are otherwise identical", () => {
    // The rejection is about a repeated client, not about repeated row
    // contents: two clients owing exactly the same deliverables is ordinary.
    const report = reconcile(buildProfile(), workbookOf(row("CLIENTA"), row("CLIENTB")), emptyRepository, asOf);

    expect(report.artifacts).toHaveLength(4);
    expect(report.clients.map((summary) => summary.client)).toEqual(["CLIENTA", "CLIENTB"]);
  });
});
