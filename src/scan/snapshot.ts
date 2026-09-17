import type { RepositoryFile, RepositorySnapshot } from "../domain/reconcile/index.js";
import type { InventoryRecord } from "../store/types.js";
import type { CrossCheckResult } from "./cross-check.js";

/**
 * Ordinary code-unit comparison rather than `localeCompare`, matching the
 * reconciliation engine: sort order is part of what gets diffed between runs and
 * `localeCompare` varies with the host's ICU data.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A segment-boundary test rather than a string prefix. `startsWith("2026/CLIENTA")`
 * also matches `2026/CLIENTAB`, which would silently fold one client's files into
 * another client's scan.
 */
function withinSubPath(path: string, subPath: string): boolean {
  return path === subPath || path.startsWith(`${subPath}/`);
}

/**
 * `crossCheck` is optional, and absent means exactly what an always-false
 * flag used to mean before this parameter existed: no cross-check files are
 * joined in, and `searchCrossCheckIncluded` is false. Every caller that has
 * not been wired to run the cross-check yet is therefore unaffected by this
 * parameter existing at all.
 */
export function assembleSnapshot(
  records: readonly InventoryRecord[],
  scannedAt: string,
  subPath?: string,
  crossCheck?: CrossCheckResult,
): RepositorySnapshot {
  const scoped =
    subPath === undefined || subPath.length === 0
      ? [...records]
      : records.filter((record) => withinSubPath(record.path, subPath));

  const localFiles: RepositoryFile[] = scoped
    .filter((record) => !record.isFolder)
    .map((record) => ({
      path: record.path,
      name: record.name,
      size: record.size,
      modified: record.modified,
      etag: record.etag,
    }));

  // The cross-check's files are joined in unconditionally rather than
  // filtered by subPath. They were found in a library other than the one
  // subPath narrows, so no subtree of this library's own scan ever held
  // them, and there is no sense in which a filter over this library's own
  // tree should be allowed to hide them.
  const files: RepositoryFile[] = [...localFiles, ...(crossCheck?.files ?? [])].sort((a, b) =>
    compareStrings(a.path, b.path),
  );

  const folderPaths = scoped
    .filter((record) => record.isFolder)
    .map((record) => record.path)
    .sort(compareStrings);

  return {
    files,
    folderPaths,
    scannedAt,
    // True only when the cross-check ran to completion. A cross-check that
    // never ran, failed outright, hit a library it could not address, or was
    // cut off by the page cap before finishing is still a degraded scan by
    // the engine's own definition, so only full completion earns the flag.
    searchCrossCheckIncluded: crossCheck?.complete === true,
  };
}
