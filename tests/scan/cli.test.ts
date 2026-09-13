import { describe, expect, it } from "vitest";
import { formatScanResult, parseScanArguments } from "../../src/scan/cli.js";
import type { ScanResult } from "../../src/scan/run.js";

function result(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    snapshot: {
      files: [
        { path: "2026/a.xlsx", name: "a.xlsx", size: 1, modified: "2026-09-01T00:00:00Z", etag: "e" },
        { path: "2026/b.xlsx", name: "b.xlsx", size: 1, modified: "2026-09-01T00:00:00Z", etag: "e" },
      ],
      folderPaths: ["2026"],
      scannedAt: "2026-09-13T12:00:00.000Z",
      searchCrossCheckIncluded: false,
    },
    driveId: "drive-1",
    mode: "full",
    resynced: false,
    pages: 2,
    changesApplied: 3,
    graphRequests: 4,
    storeBatches: 1,
    ...overrides,
  };
}

describe("parseScanArguments", () => {
  it("reads the profile path", () => {
    expect(parseScanArguments(["--profile", "profiles/acme.json"])).toEqual({ profilePath: "profiles/acme.json" });
  });

  it("reads an optional sub-path", () => {
    expect(parseScanArguments(["--profile", "p.json", "--sub-path", "2026/CLIENTA"])).toEqual({
      profilePath: "p.json",
      subPath: "2026/CLIENTA",
    });
  });
});

describe("formatScanResult", () => {
  it("reports counts, mode, and the request count the project exists to reduce", () => {
    const lines = formatScanResult(result(), "azure-table");

    expect(lines).toContain("Scan complete: full enumeration of drive drive-1.");
    expect(lines).toContain("Files: 2. Folders: 1.");
    expect(lines).toContain("Graph requests: 4. Delta pages: 2.");
    expect(lines).toContain("Store: azure-table. Changes applied: 3. Write operations: 1.");
  });

  it("says a resync happened and why it cost what it cost", () => {
    const lines = formatScanResult(result({ resynced: true }), "azure-table").join("\n");

    expect(lines).toMatch(/resync/i);
    expect(lines).toMatch(/stored deltaLink was no longer valid/i);
  });

  it("warns that an in-memory run cannot be incremental", () => {
    const lines = formatScanResult(result(), "in-memory").join("\n");

    expect(lines).toMatch(/in-memory/);
    expect(lines).toMatch(/next run will enumerate in full/i);
  });

  it("always states that no Search cross-check ran, since every 2a snapshot is degraded", () => {
    expect(formatScanResult(result(), "azure-table").join("\n")).toMatch(/Search cross-check did not run/i);
  });

  it("names the count of files with no ETag when some files lack one", () => {
    const lines = formatScanResult(
      result({
        snapshot: {
          files: [
            { path: "2026/a.xlsx", name: "a.xlsx", size: 1, modified: "2026-09-01T00:00:00Z", etag: "" },
            { path: "2026/b.xlsx", name: "b.xlsx", size: 1, modified: "2026-09-01T00:00:00Z", etag: "e" },
          ],
          folderPaths: ["2026"],
          scannedAt: "2026-09-13T12:00:00.000Z",
          searchCrossCheckIncluded: false,
        },
      }),
      "azure-table",
    ).join("\n");

    expect(lines).toMatch(/1 of those files carry no ETag/);
    expect(lines).toMatch(/Graph did not report one/);
  });

  it("says nothing about missing ETags when every file has one", () => {
    // As much a check as the positive case: a line that always prints tells an
    // operator nothing, so the absence of the ETag warning is asserted here
    // for a result where every file in the fixture already carries one.
    const lines = formatScanResult(result(), "azure-table").join("\n");

    expect(lines).not.toMatch(/ETag/);
  });
});
