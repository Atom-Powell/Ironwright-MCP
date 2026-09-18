import type { RepositorySnapshot } from "../../domain/reconcile/index.js";
import { withinSubPath } from "../../scan/snapshot.js";
import { MAX_INVENTORY_ITEMS, type InventoryToolOutput } from "./output.js";

export { MAX_INVENTORY_ITEMS };

export interface InventoryShapeOptions {
  /** Overridden only by tests, so the truncation rule runs on a small fixture. */
  maxItems?: number;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Totals come from the full filtered set and the listing is cut afterwards, in
 * that order. Counting what survived the cut and presenting it as a count of
 * what exists is the substitution this project treats as its worst failure,
 * and it is one line away at every truncation site.
 *
 * `library` is a parameter rather than filled in by the caller after the fact:
 * a function that returns a value it already knows to be wrong, relying on a
 * caller to repair it before anyone reads it, is the same defect this
 * project's message-audit practice exists to catch, just moved from prose
 * into structured data.
 */
export function shapeInventory(
  profileId: string,
  library: string,
  snapshot: RepositorySnapshot,
  subPath: string | undefined,
  graphRequests: number,
  options: InventoryShapeOptions,
): InventoryToolOutput {
  const cap = options.maxItems ?? MAX_INVENTORY_ITEMS;
  const keep = (path: string): boolean =>
    subPath === undefined || subPath.length === 0 || withinSubPath(path, subPath);

  // A cross-library file carries `library` and was found by the Search
  // cross-check in a different library, so it is not part of this library's
  // tree and must not be counted as though it were.
  const files = snapshot.files.filter((file) => file.library === undefined && keep(file.path));
  const folders = snapshot.folderPaths.filter(keep);

  const items = [
    ...files.map((file) => ({
      path: file.path,
      name: file.name,
      kind: "file" as const,
      size: file.size,
      modified: file.modified,
    })),
    // A folder carries no modified date of its own: `folderPaths` is a plain
    // string array with nothing else attached, and the scan's own timestamp is
    // when the scan ran, not when any particular folder last changed. Filling
    // it in with `scannedAt` would report a date this server never observed,
    // so the field is left off entirely, the same way `size` already is.
    ...folders.map((path) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      kind: "folder" as const,
    })),
  ].sort((a, b) => compareStrings(a.path, b.path));

  const listed = items.slice(0, cap);

  return {
    profileId,
    library,
    ...(subPath === undefined ? {} : { subPath }),
    scannedAt: snapshot.scannedAt,
    totals: {
      files: files.length,
      folders: folders.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
    },
    items: listed,
    listing: {
      returned: listed.length,
      omitted: items.length - listed.length,
      cap,
      truncated: listed.length < items.length,
    },
    graphRequests,
  };
}
