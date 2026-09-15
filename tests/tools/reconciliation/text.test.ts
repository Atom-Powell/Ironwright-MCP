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
});
