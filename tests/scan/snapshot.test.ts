import { describe, expect, it } from "vitest";
import { assembleSnapshot } from "../../src/scan/snapshot.js";
import type { InventoryRecord } from "../../src/store/types.js";

function record(overrides: Partial<InventoryRecord>): InventoryRecord {
  return {
    itemId: "i",
    path: "a.xlsx",
    name: "a.xlsx",
    isFolder: false,
    size: 1,
    modified: "2026-09-01T00:00:00Z",
    etag: "e",
    ...overrides,
  };
}

describe("assembleSnapshot", () => {
  it("splits files from folders and sorts both, so two runs over one library are byte-identical", () => {
    const snapshot = assembleSnapshot(
      [
        record({ itemId: "2", path: "2026/b.xlsx", name: "b.xlsx" }),
        record({ itemId: "1", path: "2026/a.xlsx", name: "a.xlsx" }),
        record({ itemId: "3", path: "2026", name: "2026", isFolder: true, size: 0 }),
      ],
      "2026-09-13T12:00:00Z",
    );

    expect(snapshot.files.map((file) => file.path)).toEqual(["2026/a.xlsx", "2026/b.xlsx"]);
    expect(snapshot.folderPaths).toEqual(["2026"]);
    expect(snapshot.scannedAt).toBe("2026-09-13T12:00:00Z");
  });

  it("reports the Search cross-check as absent when no cross-check result is given", () => {
    expect(assembleSnapshot([], "2026-09-13T12:00:00Z").searchCrossCheckIncluded).toBe(false);
  });

  it("filters to a sub-path on a segment boundary, not a string prefix", () => {
    const snapshot = assembleSnapshot(
      [
        record({ itemId: "1", path: "2026/CLIENTA/a.xlsx" }),
        record({ itemId: "2", path: "2026/CLIENTAB/b.xlsx" }),
        record({ itemId: "3", path: "2026/CLIENTA", isFolder: true }),
      ],
      "2026-09-13T12:00:00Z",
      "2026/CLIENTA",
    );

    expect(snapshot.files.map((file) => file.path)).toEqual(["2026/CLIENTA/a.xlsx"]);
    expect(snapshot.folderPaths).toEqual(["2026/CLIENTA"]);
  });

  it("carries size, modified date and ETag onto each file", () => {
    const [file] = assembleSnapshot(
      [record({ path: "a.xlsx", size: 99, modified: "2026-08-01T00:00:00Z", etag: "etag-9" })],
      "2026-09-13T12:00:00Z",
    ).files;

    expect(file).toEqual({ path: "a.xlsx", name: "a.xlsx", size: 99, modified: "2026-08-01T00:00:00Z", etag: "etag-9" });
  });

  it("marks the snapshot complete only when the cross-check completed", () => {
    expect(assembleSnapshot([], "2026-09-13T12:00:00Z", undefined, { files: [], complete: true }).searchCrossCheckIncluded).toBe(
      true,
    );
    expect(
      assembleSnapshot([], "2026-09-13T12:00:00Z", undefined, { files: [], complete: false, reason: "no-region" })
        .searchCrossCheckIncluded,
    ).toBe(false);
  });

  it("joins the cross-check's files into the snapshot's own file list", () => {
    const crossCheckFile = {
      path: "2026/b.xlsx",
      name: "b.xlsx",
      size: 5,
      modified: "2026-08-15T00:00:00Z",
      etag: "",
      library: "Other Library",
    };

    const snapshot = assembleSnapshot(
      [record({ path: "2026/a.xlsx", name: "a.xlsx" })],
      "2026-09-13T12:00:00Z",
      undefined,
      { files: [crossCheckFile], complete: true },
    );

    expect(snapshot.files.map((file) => file.path)).toEqual(["2026/a.xlsx", "2026/b.xlsx"]);
    expect(snapshot.files.find((file) => file.path === "2026/b.xlsx")).toEqual(crossCheckFile);
  });
});
