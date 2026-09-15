import { describe, expect, it } from "vitest";
import { loadExpectedReport } from "../../domain/reconcile/fixtures/load.js";
import { shapeReport } from "../../../src/tools/reconciliation/shape.js";
import type { ScanProvenance } from "../../../src/tools/reconciliation/output.js";

const PROVENANCE: ScanProvenance = {
  scanMode: "incremental",
  resynced: false,
  graphRequestsByThisCall: 1,
  scanSharedWithConcurrentCall: false,
};

describe("shapeReport with a filter that does not match", () => {
  it("names a client the workbook does not track rather than returning a silently empty report", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["NOSUCHCLIENT"] });

    expect(output.scope.unknownClients).toEqual(["NOSUCHCLIENT"]);
    expect(output.clients).toEqual([]);
    expect(output.artifacts).toEqual([]);
  });

  it("separates the tracked half of a mixed filter from the untracked half", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["CLIENTB", "NOSUCHCLIENT"] });

    expect(output.scope.unknownClients).toEqual(["NOSUCHCLIENT"]);
    expect(output.clients.map((client) => client.client)).toEqual(["CLIENTB"]);
  });

  it("reports no unknown clients when every named client is tracked", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["CLIENTA"] });

    expect(output.scope.unknownClients).toEqual([]);
  });

  it("keeps the unattributable findings even when nothing else survives the filter", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["NOSUCHCLIENT"] });

    expect(output.orphans.map((orphan) => orphan.kind)).toEqual(["unrecognized"]);
    expect(output.emptyFolders).toHaveLength(2);
  });

  it("treats an empty client list as a filter matching nothing, not as no filter", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: [] });

    expect(output.scope.clients).toEqual([]);
    expect(output.scope.unattributableFindingsRepositoryWide).toBe(true);
    expect(output.clients).toEqual([]);
  });
});
