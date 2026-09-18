import { inventoryPartitionKey, MAX_TRANSACTION_SIZE, planInventoryChanges } from "./keys.js";
import type { ApplyResult, InventoryRecord, ScannedDrive, StateStore } from "./types.js";

/**
 * For tests and for a local run with no storage account. It counts batches the
 * same way the Table store will, not because memory needs it, but so that
 * `batches` counts the same thing in both and the scan can print the number
 * without qualifying which store produced it.
 */
export function createMemoryStateStore(): StateStore {
  const deltaLinks = new Map<string, { deltaLink: string; lastScanAt: string }>();
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
      return deltaLinks.get(inventoryPartitionKey(profileId, driveId))?.deltaLink;
    },

    async setDeltaLink(profileId, driveId, deltaLink, lastScanAt) {
      deltaLinks.set(inventoryPartitionKey(profileId, driveId), { deltaLink, lastScanAt });
    },

    async getLastScanAt(profileId, driveId) {
      return deltaLinks.get(inventoryPartitionKey(profileId, driveId))?.lastScanAt;
    },

    async clearInventory(profileId, driveId) {
      inventories.delete(inventoryPartitionKey(profileId, driveId));
    },

    async applyInventoryChanges(profileId, driveId, changes): Promise<ApplyResult> {
      const inventory = inventoryFor(profileId, driveId);
      // Applied in arrival order via the shared planner (see its comment), not by
      // partitioning into upserts-then-deletes: a delete followed by a
      // re-creation of the same item id is what a restore from the recycle bin
      // looks like, and applying all upserts first would leave it absent.
      const steps = planInventoryChanges(changes, MAX_TRANSACTION_SIZE);
      let batches = 0;

      for (const step of steps) {
        if (step.kind === "upsert") {
          for (const record of step.records) inventory.set(record.itemId, record);
        } else {
          inventory.delete(step.itemId);
        }
        batches += 1;
      }

      return { changesApplied: changes.length, batches };
    },

    async listInventory(profileId, driveId) {
      return [...inventoryFor(profileId, driveId).values()];
    },

    async getScannedDrives(profileId): Promise<ScannedDrive[]> {
      // The map is keyed by inventoryPartitionKey, "profileId|driveId", not a
      // NUL-separated pair. A profile id is restricted to lowercase letters,
      // digits and hyphens, so it cannot itself contain "|" and the prefix
      // match below is unambiguous even if a drive id happens to contain one.
      const prefix = `${profileId}|`;
      const drives: ScannedDrive[] = [];
      for (const [key, value] of deltaLinks) {
        if (!key.startsWith(prefix)) continue;
        drives.push({ driveId: key.slice(prefix.length), lastScanAt: value.lastScanAt });
      }
      return drives;
    },
  };
}
