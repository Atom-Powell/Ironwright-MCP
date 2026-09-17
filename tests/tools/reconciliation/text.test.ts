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

  it("states that the Search cross-check did not complete, in words, when no reason was recorded", () => {
    // The golden fixture has it true, so this is asserted against a report
    // that says it did not complete. This function only ever knows that much
    // when no reason was recorded: it must not claim the stronger "did not
    // run at all," since it cannot observe whether an attempt was made.
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(shapeReport(report, PROVENANCE, {})).join("\n");

    expect(text).toContain("Microsoft Search cross-check did not complete");
    expect(text).not.toContain("did not run");
  });

  it("names no cause when the cross-check did not complete and no reason was recorded", () => {
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(shapeReport(report, PROVENANCE, {})).join("\n");

    expect(text).toContain("did not complete");
    expect(text).not.toContain("searchRegion");
    expect(text).not.toContain("failed");
    expect(text).not.toMatch(/page cap/i);
  });

  it("names the missing region as the reason when that is why the cross-check was skipped, and says it never ran", () => {
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(
      shapeReport(report, { ...PROVENANCE, searchCrossCheckSkipReason: "no-region" }, {}),
    ).join("\n");

    expect(text).toContain("searchRegion");
    expect(text).not.toContain("failed");
    // The only reason meaning the cross-check spent no request at all, so
    // "Without it" is the honest framing rather than "did not complete".
    expect(text).toContain("Without it");
  });

  it("says a search failed when that is what happened, and does not claim the cross-check never ran", () => {
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(
      shapeReport(report, { ...PROVENANCE, searchCrossCheckSkipReason: "search-failed" }, {}),
    ).join("\n");

    expect(text).toContain("failed");
    // A search-failed run can still carry files from a library that
    // succeeded before a different one's request threw, so the consequence
    // must not say the whole cross-check never ran.
    expect(text).not.toContain("Without it");
    expect(text).toContain("did not reach");
  });

  it("says a library could not be searched, without calling it a failure, when it had no URL", () => {
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(
      shapeReport(report, { ...PROVENANCE, searchCrossCheckSkipReason: "library-not-addressable" }, {}),
    ).join("\n");

    expect(text).toContain("without a URL");
    expect(text).not.toContain("failed");
    expect(text).not.toContain("Without it");
  });

  it("says the scan was too large when the page cap was reached, and that it ran rather than never starting", () => {
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(
      shapeReport(report, { ...PROVENANCE, searchCrossCheckSkipReason: "page-cap-reached" }, {}),
    ).join("\n");

    expect(text).toMatch(/too many|page cap|too large/i);
    // page-cap-reached means every library was at least attempted, so the
    // files it did find are already in this report; only the tail end of an
    // over-large library stays uncertain.
    expect(text).not.toContain("Without it");
  });

  it("describes what is invisible without a completed cross-check as another library, not the old taxonomy claim", () => {
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(
      shapeReport(report, { ...PROVENANCE, searchCrossCheckSkipReason: "no-region" }, {}),
    ).join("\n");

    expect(text).toContain("different document library");
    expect(text).not.toContain("outside the expected taxonomy");
    expect(text).not.toContain("every misplaced finding is unreliable");
  });

  it("says nothing about the Search cross-check when it did run", () => {
    expect(textFor()).not.toContain("Search cross-check");
  });

  it("names the library a misplaced finding was actually found in, so it is not mistaken for a local misfiling", () => {
    const report = loadExpectedReport();
    const misplaced = report.artifacts.find(
      (artifact) => artifact.client === "CLIENTA" && artifact.deliverable === "monthly-safety" && artifact.period.month === 4,
    );
    if (misplaced?.matched === undefined) {
      throw new Error("the golden fixture no longer has a misplaced CLIENTA April finding to qualify");
    }
    misplaced.matched = { ...misplaced.matched, library: "Archive" };

    const text = reconcileText(shapeReport(report, PROVENANCE, {})).join("\n");

    expect(text).toContain('found in another document library rather than the profile\'s own: "Archive"');
  });

  it("says nothing about another library when every listed finding is in the profile's own", () => {
    expect(textFor()).not.toContain("another document library");
  });

  it("names the scan mode and what this call paid for it", () => {
    expect(textFor()).toContain("incremental scan");
    expect(textFor()).toContain("4 Graph requests");
  });

  it("reports the cross-check's cost as its own figure rather than folding it into the scan's", () => {
    const output = shapeReport(
      loadExpectedReport(),
      { ...PROVENANCE, searchCrossCheckGraphRequestsByThisCall: 3 },
      {},
    );

    const text = reconcileText(output).join("\n");

    // Both counts must appear undisturbed: the scan's own 4, and the
    // cross-check's 3, never summed into a single 7 a reader would have to
    // pull apart by hand.
    expect(text).toContain("cost 4 Graph requests");
    expect(text).toContain("3 Graph requests for the Search cross-check");
    expect(text).not.toContain("7 Graph request");
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
