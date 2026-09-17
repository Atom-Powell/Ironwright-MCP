import { describe, expect, it } from "vitest";
import { loadExpectedReport } from "../../domain/reconcile/fixtures/load.js";
import { shapeReport } from "../../../src/tools/reconciliation/shape.js";
import { reconcileText } from "../../../src/tools/reconciliation/text.js";
import type { ScanProvenance } from "../../../src/tools/reconciliation/output.js";

const PROVENANCE: ScanProvenance = {
  scanMode: "incremental",
  resynced: false,
  graphRequestsByThisCall: 4,
  scanSharedWithConcurrentCall: false,
};

function textFor(options: Parameters<typeof shapeReport>[2] = {}): string {
  return reconcileText(shapeReport(loadExpectedReport(), PROVENANCE, options)).join("\n");
}

describe("reconcileText", () => {
  it("names the profile and the resolved window", () => {
    expect(textFor()).toContain('Profile "synthetic-compliance"');
    expect(textFor()).toContain("2026-01 through 2026-06");
  });

  it("says how many clients are compliant out of how many", () => {
    // The golden report has CLIENTB and CLIENTC compliant, CLIENTA not.
    expect(textFor()).toContain("2 of 3 clients are compliant");
  });

  it("counts the non-compliant findings by state", () => {
    const text = textFor();

    expect(text).toContain("2 misnamed");
    expect(text).toContain("1 misplaced");
    expect(text).toContain("1 missing");
  });

  it("says the compliant rows were left out and how many", () => {
    expect(textFor()).toContain("5 compliant findings are not listed");
  });

  it("states that the Search cross-check did not run, in words", () => {
    // The golden fixture has it true, so this is asserted against a report
    // that says it did not run.
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(shapeReport(report, PROVENANCE, {})).join("\n");

    expect(text).toContain("Microsoft Search cross-check did not run");
    expect(text).toContain("every missing finding is suspect");
  });

  it("names no cause when the cross-check did not run and no reason was recorded", () => {
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(shapeReport(report, PROVENANCE, {})).join("\n");

    expect(text).toContain("did not run");
    expect(text).not.toContain("searchRegion");
    expect(text).not.toContain("failed");
    expect(text).not.toMatch(/page cap/i);
  });

  it("names the missing region as the reason when that is why the cross-check was skipped", () => {
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(
      shapeReport(report, { ...PROVENANCE, searchCrossCheckSkipReason: "no-region" }, {}),
    ).join("\n");

    expect(text).toContain("searchRegion");
    expect(text).not.toContain("failed");
  });

  it("says a search failed when that is what happened", () => {
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(
      shapeReport(report, { ...PROVENANCE, searchCrossCheckSkipReason: "search-failed" }, {}),
    ).join("\n");

    expect(text).toContain("failed");
  });

  it("says a library could not be searched, without calling it a failure, when it had no URL", () => {
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(
      shapeReport(report, { ...PROVENANCE, searchCrossCheckSkipReason: "library-not-addressable" }, {}),
    ).join("\n");

    expect(text).toContain("without a URL");
    expect(text).not.toContain("failed");
  });

  it("says the scan was too large when the page cap was reached", () => {
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(
      shapeReport(report, { ...PROVENANCE, searchCrossCheckSkipReason: "page-cap-reached" }, {}),
    ).join("\n");

    expect(text).toMatch(/too many|page cap|too large/i);
  });

  it("says nothing about the Search cross-check when it did run", () => {
    expect(textFor()).not.toContain("Search cross-check");
  });

  it("names the scan mode and what this call paid for it", () => {
    expect(textFor()).toContain("incremental scan");
    expect(textFor()).toContain("4 Graph requests");
  });

  it("uses the singular for one Graph request", () => {
    const output = shapeReport(loadExpectedReport(), { ...PROVENANCE, graphRequestsByThisCall: 1 }, {});

    expect(reconcileText(output).join("\n")).toContain("cost 1 Graph request.");
  });

  it("says a joined call issued no Graph request of its own", () => {
    const output = shapeReport(
      loadExpectedReport(),
      { ...PROVENANCE, graphRequestsByThisCall: 0, scanSharedWithConcurrentCall: true },
      {},
    );

    expect(reconcileText(output).join("\n")).toContain("shared a scan already running");
  });

  it("names the filter when one was applied, and says what stayed repository-wide", () => {
    const text = textFor({ clients: ["CLIENTA"] });

    expect(text).toContain('narrowed to "CLIENTA"');
    expect(text).toContain("repository-wide");
  });

  it("labels a finding that is both misnamed and misplaced with its full label", () => {
    // The golden fixture carries exactly one artifact in this state, so this
    // pins the label text rather than relying on the "misnamed" and
    // "misplaced" substring checks above to catch a wrong label by accident.
    expect(textFor()).toContain("1 both misnamed and misplaced");
  });

  it("uses the numerator, not the denominator, for the compliance verb", () => {
    const base = shapeReport(loadExpectedReport(), PROVENANCE, {});
    const zeroCounts = { compliant: 0, misnamed: 0, misplaced: 0, misnamed_and_misplaced: 0, missing: 0 };
    const output = {
      ...base,
      clients: [
        { client: "CLIENTA", counts: { ...zeroCounts, missing: 6 }, compliant: false },
        { client: "CLIENTB", counts: { ...zeroCounts, compliant: 6 }, compliant: true },
      ],
    };

    expect(reconcileText(output).join("\n")).toContain("1 of 2 clients is compliant.");
  });

  it("reports the truncation sentence with the exact count omitted", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { maxArtifacts: 4 });

    // Five non-compliant findings in the golden fixture, four kept, one cut.
    expect(output.artifactsOmittedByCap).toBe(1);
    expect(reconcileText(output).join("\n")).toContain("1 further non-compliant finding was omitted");
  });

  it("uses the plural for more than one finding omitted by the cap", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { maxArtifacts: 2 });

    expect(output.artifactsOmittedByCap).toBe(3);
    expect(reconcileText(output).join("\n")).toContain("3 further non-compliant findings were omitted");
  });

  it("drops \"further\" when the cap left nothing in the returned list to be further than", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { maxArtifacts: 0 });

    expect(output.artifacts).toHaveLength(0);
    const text = reconcileText(output).join("\n");
    expect(text).toContain("5 non-compliant findings were omitted");
    expect(text).not.toContain("further");
  });

  it("uses the plural pronoun for more than one unknown client", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["NOPE1", "NOPE2"] });

    const text = reconcileText(output).join("\n");
    expect(text).toContain('"NOPE1", "NOPE2" are not in the workbook, so nothing was reconciled for them.');
  });

  it("does not add the unattributable-findings caveat when the filter surfaces only duplicates", () => {
    const base = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["CLIENTA"] });
    const output = { ...base, orphans: [], emptyFolders: [] };

    // Both golden duplicates belong to CLIENTA, so this filter still has
    // something to report under "Also found", just nothing unattributable.
    expect(output.duplicates.length).toBeGreaterThan(0);
    const text = reconcileText(output).join("\n");
    expect(text).toContain("Also found");
    expect(text).not.toContain("repository-wide");
  });

  it("does not claim clients were named when the filter is an empty client list", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: [] });

    const text = reconcileText(output).join("\n");
    expect(text).toContain("Also found");
    expect(text).toContain("repository-wide");
    expect(text).not.toContain("named clients");
  });
});
