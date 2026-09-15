import { describe, expect, it } from "vitest";
import { periodFromDate, runReconcile } from "../../../src/tools/reconciliation/run.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import type { ToolContext } from "../../../src/tools/context.js";
import type { WorkbookSnapshot } from "../../../src/domain/reconcile/index.js";
import type { ScanResult } from "../../../src/scan/run.js";

const WORKBOOK: WorkbookSnapshot = {
  rows: [{ client: "ACME", fields: { safety: true } }],
  rejectedRows: [],
  source: "/Trackers/Workbook.xlsx#Roster in Compliance Reports",
};

function contextWith(overrides: Partial<ToolContext> = {}, scan?: Partial<ScanResult>): ToolContext {
  const result: ScanResult = {
    snapshot: { files: [], folderPaths: [], scannedAt: "2026-09-14T09:00:00Z", searchCrossCheckIncluded: false },
    driveId: "drive-1",
    mode: "incremental",
    resynced: false,
    pages: 1,
    changesApplied: 0,
    graphRequests: 6,
    storeBatches: 0,
    unfilteredFileCount: 0,
    unfilteredFolderCount: 0,
    ...scan,
  };

  return createFakeToolContext({
    scans: { run: async () => ({ result, joined: false }) },
    ...overrides,
  });
}

describe("periodFromDate", () => {
  it("reads the month in UTC, so the report does not depend on the host's region", () => {
    expect(periodFromDate(new Date("2026-03-01T00:30:00Z"))).toEqual({ year: 2026, month: 3 });
    expect(periodFromDate(new Date("2026-12-31T23:59:59Z"))).toEqual({ year: 2026, month: 12 });
  });
});

describe("runReconcile", () => {
  it("returns a structured report and a text block", async () => {
    const result = await runReconcile({ profileId: "example" }, contextWith(), async () => WORKBOOK);

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { profileId: string };
    expect(structured.profileId).toBe("example");
    // JSON.stringify escapes the embedded double quotes, so the needle must
    // carry the same escaping the haystack does.
    expect(JSON.stringify(result.content)).toContain('Profile \\"example\\"');
  });

  it("reads the workbook before scanning, so a bad mapping costs no enumeration", async () => {
    // A plain order log does not distinguish "workbook awaited, then scan
    // started" from "workbook and scan both started together, with the
    // workbook's callback merely invoked first in source order." Both fakes
    // that only push a marker resolve synchronously, so a
    // `Promise.all([readWorkbook(...), scans.run(...)])` mutation would call
    // the workbook fake first regardless, and an order-only assertion would
    // not notice. What proves sequencing is whether the scan starts only
    // after the workbook promise has genuinely settled, so the workbook fake
    // yields a real microtask before resolving and the scan fake records
    // whether that flag was already set at the moment it started.
    let workbookSettled = false;
    let workbookSettledWhenScanStarted: boolean | undefined;

    const context = contextWith({
      scans: {
        run: async () => {
          workbookSettledWhenScanStarted = workbookSettled;
          return {
            result: {
              snapshot: { files: [], folderPaths: [], scannedAt: "2026-09-14T09:00:00Z", searchCrossCheckIncluded: false },
              driveId: "drive-1",
              mode: "incremental" as const,
              resynced: false,
              pages: 1,
              changesApplied: 0,
              graphRequests: 1,
              storeBatches: 0,
              unfilteredFileCount: 0,
              unfilteredFolderCount: 0,
            },
            joined: false,
          };
        },
      },
    });

    await runReconcile({ profileId: "example" }, context, async () => {
      await Promise.resolve();
      workbookSettled = true;
      return WORKBOOK;
    });

    expect(workbookSettledWhenScanStarted).toBe(true);
  });

  it("reports the Graph cost this call actually paid", async () => {
    const result = await runReconcile({ profileId: "example" }, contextWith(), async () => WORKBOOK);
    const structured = result.structuredContent as { provenance: { graphRequestsByThisCall: number } };

    expect(structured.provenance.graphRequestsByThisCall).toBe(6);
  });

  it("reports zero Graph requests for a call that joined a scan it did not start", async () => {
    const context = createFakeToolContext({
      scans: {
        run: async () => ({
          result: {
            snapshot: { files: [], folderPaths: [], scannedAt: "2026-09-14T09:00:00Z", searchCrossCheckIncluded: false },
            driveId: "drive-1",
            mode: "full" as const,
            resynced: false,
            pages: 1,
            changesApplied: 0,
            graphRequests: 42,
            storeBatches: 0,
            unfilteredFileCount: 0,
            unfilteredFolderCount: 0,
          },
          joined: true,
        }),
      },
    });

    const result = await runReconcile({ profileId: "example" }, context, async () => WORKBOOK);
    const structured = result.structuredContent as {
      provenance: { graphRequestsByThisCall: number; scanSharedWithConcurrentCall: boolean };
    };

    expect(structured.provenance.graphRequestsByThisCall).toBe(0);
    expect(structured.provenance.scanSharedWithConcurrentCall).toBe(true);
  });

  it("passes the clients argument through to the shaping filter", async () => {
    const result = await runReconcile(
      { profileId: "example", clients: ["ACME"] },
      contextWith(),
      async () => WORKBOOK,
    );
    const structured = result.structuredContent as { scope: { clients: string[] | null } };

    expect(structured.scope.clients).toEqual(["ACME"]);
  });
});
