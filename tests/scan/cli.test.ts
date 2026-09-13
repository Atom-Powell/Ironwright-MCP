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
    unfilteredFileCount: 2,
    unfilteredFolderCount: 1,
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

  it("strips a leading slash from the sub-path", () => {
    expect(parseScanArguments(["--profile", "p.json", "--sub-path", "/2026/CLIENTA"])).toEqual({
      profilePath: "p.json",
      subPath: "2026/CLIENTA",
    });
  });

  it("strips a trailing slash from the sub-path", () => {
    expect(parseScanArguments(["--profile", "p.json", "--sub-path", "2026/CLIENTA/"])).toEqual({
      profilePath: "p.json",
      subPath: "2026/CLIENTA",
    });
  });

  it("treats a sub-path that strips to nothing as no sub-path at all", () => {
    // "/" names the whole library, which is what omitting the flag means. Left
    // unset rather than stored empty so the output cannot announce a filter that
    // never applied.
    expect(parseScanArguments(["--profile", "p.json", "--sub-path", "/"])).toEqual({ profilePath: "p.json" });
    expect(parseScanArguments(["--profile", "p.json", "--sub-path", "///"])).toEqual({ profilePath: "p.json" });
  });

  it("strips both a leading and a trailing slash from the sub-path", () => {
    expect(parseScanArguments(["--profile", "p.json", "--sub-path", "/2026/CLIENTA/"])).toEqual({
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
    expect(lines).toContain("Store: azure-table. Changes applied: 3. Write operations from applying those changes: 1.");
  });

  it("says a resync happened and why it cost what it cost", () => {
    const lines = formatScanResult(result({ resynced: true }), "azure-table").join("\n");

    expect(lines).toMatch(/resync/i);
    expect(lines).toMatch(/stored deltaLink was no longer valid/i);
  });

  it("says a resync's clearing writes are not in the write-operations count", () => {
    // clearInventory returns nothing, so its delete transactions are in no
    // counter formatScanResult can read. The largest write cost of a resync on
    // a large library is exactly the one this line must not claim to cover.
    const lines = formatScanResult(result({ resynced: true }), "azure-table").join("\n");

    expect(lines).toMatch(/not included in the write-operations count/i);
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

    expect(lines).toMatch(/1 carries no ETag/);
    expect(lines).toMatch(/Graph did not report one/);
  });

  it("agrees the verb with a plural count as well, so the singular fix is not a constant", () => {
    const lines = formatScanResult(
      result({
        snapshot: {
          files: [
            { path: "2026/a.xlsx", name: "a.xlsx", size: 1, modified: "2026-09-01T00:00:00Z", etag: "" },
            { path: "2026/b.xlsx", name: "b.xlsx", size: 1, modified: "2026-09-01T00:00:00Z", etag: "" },
          ],
          folderPaths: ["2026"],
          scannedAt: "2026-09-13T12:00:00.000Z",
          searchCrossCheckIncluded: false,
        },
      }),
      "azure-table",
    ).join("\n");

    expect(lines).toMatch(/2 carry no ETag/);
  });

  it("names the count of files with no modified date when some files lack one", () => {
    // changes.ts records item.lastModifiedDateTime ?? "" exactly as it records
    // item.eTag ?? "", so the same gap on the same fixture shape is asserted here.
    const lines = formatScanResult(
      result({
        snapshot: {
          files: [
            { path: "2026/a.xlsx", name: "a.xlsx", size: 1, modified: "", etag: "e" },
            { path: "2026/b.xlsx", name: "b.xlsx", size: 1, modified: "2026-09-01T00:00:00Z", etag: "e" },
          ],
          folderPaths: ["2026"],
          scannedAt: "2026-09-13T12:00:00.000Z",
          searchCrossCheckIncluded: false,
        },
      }),
      "azure-table",
    ).join("\n");

    expect(lines).toMatch(/1 carries no modified date/);
  });

  it("names both counts when files lack an ETag, a modified date, or both", () => {
    const lines = formatScanResult(
      result({
        snapshot: {
          files: [
            { path: "2026/a.xlsx", name: "a.xlsx", size: 1, modified: "", etag: "" },
            { path: "2026/b.xlsx", name: "b.xlsx", size: 1, modified: "2026-09-01T00:00:00Z", etag: "e" },
          ],
          folderPaths: ["2026"],
          scannedAt: "2026-09-13T12:00:00.000Z",
          searchCrossCheckIncluded: false,
        },
      }),
      "azure-table",
    ).join("\n");

    expect(lines).toMatch(/1 carries no ETag/);
    expect(lines).toMatch(/1 carries no modified date/);
    expect(lines).toMatch(/Graph did not report those values/);
  });

  it("names the sub-path filter and gives the unfiltered totals alongside the filtered ones", () => {
    const lines = formatScanResult(
      result({ subPath: "2026/CLIENTA", unfilteredFileCount: 12, unfilteredFolderCount: 3 }),
      "azure-table",
    );

    expect(lines).toContain("Files: 2. Folders: 1.");
    expect(lines.join("\n")).toMatch(/Sub-path filter applied: 2026\/CLIENTA/);
    expect(lines.join("\n")).toMatch(/drive as a whole holds 12 files and 3 folders/);
  });

  it("says nothing about a sub-path filter when none was applied", () => {
    expect(formatScanResult(result(), "azure-table").join("\n")).not.toMatch(/[Ss]ub-path/);
  });

  it("says nothing about a missing ETag or modified date when every file has both", () => {
    // As much a check as the positive cases: a line that always prints tells an
    // operator nothing, so the absence of the warning is asserted here for a
    // result where every file in the fixture already carries both values.
    const lines = formatScanResult(result(), "azure-table").join("\n");

    expect(lines).not.toMatch(/ETag/);
    expect(lines).not.toMatch(/modified date/);
  });
});
