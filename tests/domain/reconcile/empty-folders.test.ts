import { describe, expect, it } from "vitest";
import { findEmptyFolders } from "../../../src/domain/reconcile/empty-folders.js";
import type { RepositoryFile, RepositorySnapshot } from "../../../src/domain/reconcile/types.js";

function repoFile(path: string, library?: string): RepositoryFile {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const file: RepositoryFile = { path, name, size: 1024, modified: "2026-06-01T00:00:00Z", etag: `etag-${path}` };
  return library === undefined ? file : { ...file, library };
}

function snapshot(folderPaths: string[], filePaths: string[], extraFiles: RepositoryFile[] = []): RepositorySnapshot {
  return {
    files: [...filePaths.map((path) => repoFile(path)), ...extraFiles],
    folderPaths,
    scannedAt: "2026-06-02T00:00:00Z",
    searchCrossCheckIncluded: true,
  };
}

describe("findEmptyFolders", () => {
  it("does not call a folder empty when a file sits directly in it", () => {
    const result = findEmptyFolders(snapshot(["2026/CLIENTA"], ["2026/CLIENTA/report.xlsx"]));

    expect(result).toEqual([]);
  });

  it("does not call a folder empty when it holds only another folder, even an empty one", () => {
    const result = findEmptyFolders(snapshot(["2026/CLIENTA", "2026/CLIENTA/05-May"], []));

    // The parent holds something (the child folder), so only the leaf is empty.
    expect(result).toEqual(["2026/CLIENTA/05-May"]);
  });

  it("does not call a folder empty when a file sits in a folder below it", () => {
    const result = findEmptyFolders(snapshot(["2026/CLIENTA", "2026/CLIENTA/05-May"], ["2026/CLIENTA/05-May/report.xlsx"]));

    expect(result).toEqual([]);
  });

  it("calls a folder with nothing beneath it empty", () => {
    const result = findEmptyFolders(snapshot(["2026/CLIENTA/05-May"], []));

    expect(result).toEqual(["2026/CLIENTA/05-May"]);
  });

  it("compares paths a whole segment at a time, so a sibling with a longer name is not a child", () => {
    // A plain startsWith check reports "2026/CLIENTA" as occupied here,
    // because "2026/CLIENTAB/report.xlsx" does begin with those characters.
    // The two clients are unrelated folders and CLIENTA is genuinely empty.
    const result = findEmptyFolders(snapshot(["2026/CLIENTA", "2026/CLIENTAB"], ["2026/CLIENTAB/report.xlsx"]));

    expect(result).toEqual(["2026/CLIENTA"]);
  });

  it("does not treat a folder whose name extends another folder's name as its child", () => {
    // The folder-versus-folder half of the same trap: CLIENTAB is a sibling,
    // not a child, so it leaves CLIENTA empty.
    const result = findEmptyFolders(snapshot(["2026/CLIENTA", "2026/CLIENTAB", "2026/CLIENTAB/05-May"], []));

    expect(result).toEqual(["2026/CLIENTA", "2026/CLIENTAB/05-May"]);
  });

  it("returns empty folders sorted by path regardless of the order they were scanned in", () => {
    const result = findEmptyFolders(snapshot(["2026/CLIENTB", "2025/CLIENTA", "2026/CLIENTA"], []));

    expect(result).toEqual(["2025/CLIENTA", "2026/CLIENTA", "2026/CLIENTB"]);
  });

  it("reports nothing for a repository with no folders at all", () => {
    expect(findEmptyFolders(snapshot([], []))).toEqual([]);
  });

  it("still calls a folder empty when only a cross-library file coincidentally shares its path", () => {
    // A file qualified with `library` came from the Microsoft Search
    // cross-check and sits in a different document library, not the
    // profile's own one that `folderPaths` describes. If this walk let it
    // occupy a folder here, a client folder that is genuinely empty in the
    // profile's own library would stop being reported the moment the same
    // relative path happened to exist in another library on the site.
    const foreign = repoFile("2026/CLIENTA/report.xlsx", "Archive");
    const result = findEmptyFolders(snapshot(["2026/CLIENTA"], [], [foreign]));

    expect(result).toEqual(["2026/CLIENTA"]);
  });

  it("still occupies the folder when an unqualified local file sits in it alongside a cross-library one", () => {
    // Guards the guard: excluding qualified files must not become excluding
    // every file whenever any qualified one is present.
    const local = repoFile("2026/CLIENTA/report.xlsx");
    const foreign = repoFile("2026/CLIENTA/report.xlsx", "Archive");
    const result = findEmptyFolders(snapshot(["2026/CLIENTA"], [], [local, foreign]));

    expect(result).toEqual([]);
  });
});
