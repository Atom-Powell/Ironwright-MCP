import { describe, expect, it } from "vitest";
import { runInventoryTree } from "../../../src/tools/inventory/run.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import type { ToolContext } from "../../../src/tools/context.js";
import type { ScanResult } from "../../../src/scan/run.js";

function contextWith(scan?: Partial<ScanResult>, joined = false): ToolContext {
  const result: ScanResult = {
    snapshot: {
      files: [
        { path: "2026/CLIENTA/report.docx", name: "report.docx", size: 12, modified: "2026-09-01T00:00:00.000Z", etag: "a" },
      ],
      folderPaths: ["2026", "2026/CLIENTA"],
      scannedAt: "2026-09-17T00:00:00.000Z",
      searchCrossCheckIncluded: false,
    },
    driveId: "drive-1",
    mode: "incremental",
    resynced: false,
    pages: 1,
    changesApplied: 0,
    graphRequests: 6,
    storeBatches: 0,
    unfilteredFileCount: 1,
    unfilteredFolderCount: 2,
    ...scan,
  };

  return createFakeToolContext({
    scans: { run: async () => ({ result, joined }) },
  });
}

describe("runInventoryTree", () => {
  it("returns a structured inventory and a text block", async () => {
    const result = await runInventoryTree({ profileId: "example" }, contextWith());

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { profileId: string; library: string };
    expect(structured.profileId).toBe("example");
    expect(structured.library.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.content)).toContain('Profile \\"example\\"');
  });

  it("returns isError with the registry's own message for an unknown profile", async () => {
    const result = await runInventoryTree({ profileId: "no-such-profile" }, contextWith());

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("no-such-profile");
  });

  it("reports zero Graph requests for a call that joined a scan it did not start", async () => {
    const context = contextWith({ graphRequests: 42 }, true);

    const result = await runInventoryTree({ profileId: "example" }, context);
    const structured = result.structuredContent as { graphRequests: number };

    expect(structured.graphRequests).toBe(0);
  });

  it("reports the Graph cost this call actually paid when it started the scan", async () => {
    const result = await runInventoryTree({ profileId: "example" }, contextWith({ graphRequests: 6 }, false));
    const structured = result.structuredContent as { graphRequests: number };

    expect(structured.graphRequests).toBe(6);
  });

  it("returns zeroed totals, not an error, for a subPath matching nothing", async () => {
    const result = await runInventoryTree({ profileId: "example", subPath: "no/such/path" }, contextWith());

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { totals: { files: number; folders: number; bytes: number } };
    expect(structured.totals).toEqual({ files: 0, folders: 0, bytes: 0 });
  });
});
