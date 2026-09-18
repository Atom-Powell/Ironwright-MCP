import { describe, expect, it } from "vitest";
import { loadExpectedReport } from "../../domain/reconcile/fixtures/load.js";
import { shapeReport } from "../../../src/tools/reconciliation/shape.js";
import { reconcileText } from "../../../src/tools/reconciliation/text.js";
import type { CallProvenance, ReconcileToolOutput } from "../../../src/tools/reconciliation/output.js";

const PROVENANCE: CallProvenance = {
  scanMode: "incremental",
  resynced: false,
  graphRequestsByThisCall: 4,
  scanSharedWithConcurrentCall: false,
  workbookReadGraphRequestsByThisCall: 2,
};

function emptyOutput(): ReconcileToolOutput {
  const output = shapeReport(loadExpectedReport(), PROVENANCE, {});
  return {
    ...output,
    clients: [],
    artifacts: [],
    compliantArtifactsOmitted: 0,
    artifactsOmittedByCap: 0,
    duplicates: [],
    orphans: [],
    emptyFolders: [],
    rejectedWorkbookRows: [],
  };
}

describe("reconcileText says nothing it cannot observe", () => {
  it("does not claim a compliance ratio when no client is in scope", () => {
    const text = reconcileText(emptyOutput()).join("\n");

    expect(text).toContain("no compliance result to report");
    expect(text).not.toMatch(/\d+ of \d+ client/);
  });

  it("does not list a state that no returned finding carries", () => {
    const text = reconcileText(emptyOutput()).join("\n");

    expect(text).toContain("No non-compliant deliverables are listed");
    expect(text).not.toContain("misnamed");
  });

  it("says nothing about truncation when nothing was truncated", () => {
    expect(reconcileText(emptyOutput()).join("\n")).not.toContain("omitted to keep this response bounded");
  });

  it("says nothing about compliant omissions when none were omitted", () => {
    expect(reconcileText(emptyOutput()).join("\n")).not.toContain("not listed");
  });

  it("says nothing about duplicates, orphans or empty folders when there are none", () => {
    expect(reconcileText(emptyOutput()).join("\n")).not.toContain("Also found");
  });

  it("does not claim findings are repository-wide when no filter was applied", () => {
    const text = reconcileText(shapeReport(loadExpectedReport(), PROVENANCE, {})).join("\n");

    expect(text).not.toContain("repository-wide");
  });

  it("reports a resync in the scan line only when one happened", () => {
    const clean = reconcileText(shapeReport(loadExpectedReport(), PROVENANCE, {})).join("\n");
    const resynced = reconcileText(
      shapeReport(loadExpectedReport(), { ...PROVENANCE, resynced: true }, {}),
    ).join("\n");

    expect(clean).not.toContain("resync");
    expect(resynced).toContain("after a delta resync forced a full re-enumeration");
  });

  it("still reports the workbook's cost on a joined call, which shares the scan and nothing else", () => {
    // The sentence this replaces said a joined call "issued no Graph request
    // of its own because it shared a scan already running", which was false
    // every time it fired: the coordinator shares the repository snapshot,
    // and a joiner resolves the drive and downloads the workbook by itself.
    const text = reconcileText(
      shapeReport(
        loadExpectedReport(),
        { ...PROVENANCE, graphRequestsByThisCall: 0, scanSharedWithConcurrentCall: true },
        {},
      ),
    ).join("\n");

    expect(text).toContain(
      "This call cost 2 Graph requests reading the workbook, and issued no Graph request of its own for the " +
        "repository scan because it shared a scan already running.",
    );
    // Never reported as costing nothing at all.
    expect(text).not.toContain("This call issued no Graph request");
  });

  it("uses the singular for one rejected workbook row and one unknown client", () => {
    const base = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["NOSUCHCLIENT"] });
    const output: ReconcileToolOutput = {
      ...base,
      rejectedWorkbookRows: [{ row: 4, client: "CLIENTD", reason: "effectiveFrom is not an ISO date" }],
    };

    const text = reconcileText(output).join("\n");

    expect(text).toContain("1 workbook row was rejected");
    expect(text).toContain('"NOSUCHCLIENT" is');
    expect(text).not.toContain("rows were rejected");
  });
});
