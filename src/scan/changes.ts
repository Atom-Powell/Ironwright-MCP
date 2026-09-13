import type { DeltaItem } from "../graph/delta.js";
import { libraryRelativePath } from "../graph/paths.js";
import type { InventoryChange } from "../store/types.js";

/**
 * An item that cannot be turned into an inventory record is refused rather than
 * skipped. A skipped file becomes a file the reconciliation engine reports as
 * missing, which sends someone to produce a report that already exists; losing
 * an item has to be louder than losing a scan.
 */
export class DeltaItemError extends Error {
  readonly itemId: string;

  constructor(itemId: string, reason: string) {
    super(`A delta item could not be recorded: ${reason}. Item id: ${itemId}.`);
    this.name = "DeltaItemError";
    this.itemId = itemId;
  }
}

export function changesFromDeltaItems(items: readonly DeltaItem[]): InventoryChange[] {
  const changes: InventoryChange[] = [];

  for (const item of items) {
    // The drive root arrives in every delta response, including incremental
    // ones, and it is not a member of the library's contents.
    if (item.root !== undefined) continue;

    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new DeltaItemError("(absent)", "the item carried no id, and the inventory is keyed by it");
    }

    if (item.deleted !== undefined) {
      changes.push({ kind: "delete", itemId: item.id });
      continue;
    }

    if (typeof item.name !== "string" || item.name.length === 0) {
      throw new DeltaItemError(item.id, "the item carried no name");
    }

    const parentPath = item.parentReference?.path;
    if (typeof parentPath !== "string") {
      throw new DeltaItemError(item.id, "the item carried no parentReference.path, so its path cannot be derived");
    }

    const isFolder = item.folder !== undefined;
    changes.push({
      kind: "upsert",
      record: {
        itemId: item.id,
        path: libraryRelativePath(parentPath, item.name),
        name: item.name,
        isFolder,
        // A folder's size is the recursive total of its contents, which is not
        // what any consumer of this inventory means by size.
        size: isFolder ? 0 : (item.size ?? 0),
        modified: item.lastModifiedDateTime ?? "",
        etag: item.eTag ?? "",
      },
    });
  }

  return changes;
}
