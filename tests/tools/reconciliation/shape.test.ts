import { describe, expect, it } from "vitest";
import { loadExpectedReport } from "../../domain/reconcile/fixtures/load.js";
import { scanProvenance, shapeReport } from "../../../src/tools/reconciliation/shape.js";
import type { ScanProvenance } from "../../../src/tools/reconciliation/output.js";
import type { ScanResult } from "../../../src/scan/run.js";

const PROVENANCE: ScanProvenance = {
  scanMode: "incremental",
  resynced: false,
  graphRequestsByThisCall: 4,
  scanSharedWithConcurrentCall: false,
};

function scanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    snapshot: { files: [], folderPaths: [], scannedAt: "2026-09-14T00:00:00Z", searchCrossCheckIncluded: false },
    driveId: "drive-1",
    mode: "full",
    resynced: true,
    pages: 2,
    changesApplied: 9,
    graphRequests: 7,
    storeBatches: 3,
    unfilteredFileCount: 9,
    unfilteredFolderCount: 4,
    ...overrides,
  };
}

describe("shapeReport", () => {
  it("omits the compliant findings and says how many, while the counts stay whole", () => {
    const report = loadExpectedReport();

    const output = shapeReport(report, PROVENANCE, {});

    // The golden report holds five compliant findings out of ten.
    expect(output.artifacts).toHaveLength(5);
    expect(output.artifacts.every((artifact) => artifact.state !== "compliant")).toBe(true);
    expect(output.compliantArtifactsOmitted).toBe(5);
    expect(output.clients.find((client) => client.client === "CLIENTA")?.counts.compliant).toBe(3);
  });

  it("covers every client when no filter is given, including one that owes nothing", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, {});

    expect(output.clients.map((client) => client.client)).toEqual(["CLIENTA", "CLIENTB", "CLIENTC"]);
    expect(output.scope.clients).toBeNull();
    expect(output.scope.unattributableFindingsRepositoryWide).toBe(false);
  });

  it("narrows what is attributable to a client and leaves what is not", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["CLIENTA"] });

    expect(output.clients.map((client) => client.client)).toEqual(["CLIENTA"]);
    expect(output.artifacts.every((artifact) => artifact.client === "CLIENTA")).toBe(true);
    // Both golden duplicates belong to CLIENTA and both survive.
    expect(output.duplicates).toHaveLength(2);
    // Of three golden orphans, one is unrecognized and two are CLIENTB and CLIENTC.
    expect(output.orphans.map((orphan) => orphan.kind)).toEqual(["unrecognized"]);
    // Empty folders are attributable to no client and are never filtered.
    expect(output.emptyFolders).toEqual(["2025/CLIENTA", "2026/CLIENTA/04-April"]);
    expect(output.scope.clients).toEqual(["CLIENTA"]);
    expect(output.scope.unattributableFindingsRepositoryWide).toBe(true);
  });

  it("counts the compliant omissions within the filter, not across the whole report", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["CLIENTB"] });

    expect(output.compliantArtifactsOmitted).toBe(2);
    expect(output.artifacts).toHaveLength(0);
  });

  it("truncates at the cap and states the exact number it left out", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { maxArtifacts: 2 });

    expect(output.artifacts).toHaveLength(2);
    expect(output.artifactsOmittedByCap).toBe(3);
  });

  it("reports nothing omitted by the cap when nothing was", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, {});

    expect(output.artifactsOmittedByCap).toBe(0);
  });

  it("carries the report's own provenance through beside the scan's", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, {});

    expect(output.provenance.scannedAt).toBe("2026-07-06T08:30:00Z");
    expect(output.provenance.workbookSource).toContain("Deliverable Tracker.xlsx");
    expect(output.provenance.searchCrossCheckIncluded).toBe(true);
    expect(output.provenance.graphRequestsByThisCall).toBe(4);
  });
});

describe("scanProvenance", () => {
  it("reports what the starting call actually paid", () => {
    expect(scanProvenance(scanResult(), false)).toEqual({
      scanMode: "full",
      resynced: true,
      graphRequestsByThisCall: 7,
      scanSharedWithConcurrentCall: false,
    });
  });

  it("reports zero for a call that joined a scan it did not start", () => {
    const provenance = scanProvenance(scanResult(), true);

    expect(provenance.graphRequestsByThisCall).toBe(0);
    expect(provenance.scanSharedWithConcurrentCall).toBe(true);
    // The scan it joined still resynced, and the report is built on that
    // inventory, so this describes the scan rather than the caller.
    expect(provenance.resynced).toBe(true);
    expect(provenance.scanMode).toBe("full");
  });
});
