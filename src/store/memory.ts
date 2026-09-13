import { chunk, inventoryPartitionKey, MAX_TRANSACTION_SIZE } from "./keys.js";
import type { ApplyResult, InventoryChange, InventoryRecord, StateStore } from "./types.js";

/**
 * For tests and for a local run with no storage account. It chunks the same way
 * the Table implementation does, not because memory needs it, but so that
 * `batches` counts the same thing in both and the scan can print the number
 * without qualifying which store produced it.
 */
export function createMemoryStateStore(): StateStore {
  const deltaLinks = new Map<string, string>();
  const inventories = new Map<string, Map<string, InventoryRecord>>();

  function inventoryFor(profileId: string, driveId: string): Map<string, InventoryRecord> {
    const key = inventoryPartitionKey(profileId, driveId);
    let inventory = inventories.get(key);
    if (inventory === undefined) {
      inventory = new Map();
      inventories.set(key, inventory);
    }
    return inventory;
  }

  return {
    async getDeltaLink(profileId, driveId) {
      return deltaLinks.get(inventoryPartitionKey(profileId, driveId));
    },

    async setDeltaLink(profileId, driveId, deltaLink) {
      deltaLinks.set(inventoryPartitionKey(profileId, driveId), deltaLink);
    },

    async clearInventory(profileId, driveId) {
      inventories.delete(inventoryPartitionKey(profileId, driveId));
    },

    async applyInventoryChanges(profileId, driveId, changes): Promise<ApplyResult> {
      const inventory = inventoryFor(profileId, driveId);
      const upserts = changes.filter((change): change is Extract<InventoryChange, { kind: "upsert" }> =>
        change.kind === "upsert",
      );
      const deletes = changes.filter((change): change is Extract<InventoryChange, { kind: "delete" }> =>
        change.kind === "delete",
      );

      for (const change of upserts) inventory.set(change.record.itemId, change.record);
      for (const change of deletes) inventory.delete(change.itemId);

      return {
        changesApplied: changes.length,
        batches: chunk(upserts, MAX_TRANSACTION_SIZE).length + deletes.length,
      };
    },

    async listInventory(profileId, driveId) {
      return [...inventoryFor(profileId, driveId).values()];
    },
  };
}
