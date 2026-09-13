import type { RepositoryFile, RepositorySnapshot } from "../domain/reconcile/index.js";
import type { InventoryRecord } from "../store/types.js";

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

export function assembleSnapshot(
  records: readonly InventoryRecord[],
  scannedAt: string,
  subPath?: string,
): RepositorySnapshot {
  const scoped =
    subPath === undefined || subPath.length === 0
      ? [...records]
      : records.filter((record) => withinSubPath(record.path, subPath));

  const files: RepositoryFile[] = scoped
    .filter((record) => !record.isFolder)
    .map((record) => ({
      path: record.path,
      name: record.name,
      size: record.size,
      modified: record.modified,
      etag: record.etag,
    }))
    .sort((a, b) => compareStrings(a.path, b.path));

  const folderPaths = scoped
    .filter((record) => record.isFolder)
    .map((record) => record.path)
    .sort(compareStrings);

  return {
    files,
    folderPaths,
    scannedAt,
    // Phase 2a runs no Microsoft Search cross-check, so every snapshot it
    // produces is a degraded scan by the engine's own definition and says so.
    searchCrossCheckIncluded: false,
  };
}
