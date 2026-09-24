import { inventoryPartitionKey, MAX_TRANSACTION_SIZE, planInventoryChanges } from "./keys.js";
import { MAX_PLAN_JSON_CHARS, PlanTooLargeError, storedPlanJsonChars } from "./types.js";
import type { ApplyResult, InventoryRecord, ScannedDrive, StateStore, StoredPlan } from "./types.js";

/**
 * For tests and for a local run with no storage account. It counts batches the
 * same way the Table store will, not because memory needs it, but so that
 * `batches` counts the same thing in both and the scan can print the number
 * without qualifying which store produced it.
 */
export function createMemoryStateStore(): StateStore {
  const deltaLinks = new Map<string, { deltaLink: string; lastScanAt: string }>();
  const inventories = new Map<string, Map<string, InventoryRecord>>();
  const plans = new Map<string, StoredPlan>();

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
      // The prefix is built by the same inventoryPartitionKey every sibling
      // method uses, with an empty drive id, rather than a second literal "|"
      // written here. That keeps the delimiter's definition in one place, and
      // an unsafe profile id now throws the same UnsafeKeyError this store
      // raises everywhere else instead of quietly answering with no results.
      // The delimiter is what makes startsWith an exact boundary: it is the
      // character immediately after the profile id in every key this store
      // writes, so no other profile id's key can share this prefix, whatever
      // characters a drive id itself contains.
      const prefix = inventoryPartitionKey(profileId, "");
      const drives: ScannedDrive[] = [];
      for (const [key, value] of deltaLinks) {
        if (!key.startsWith(prefix)) continue;
        drives.push({ driveId: key.slice(prefix.length), lastScanAt: value.lastScanAt });
      }
      return drives;
    },

    async savePlan(profileId, plan) {
      // Enforced here too, and by the same measurement the Table store uses,
      // rather than left to that implementation alone: a StateStore caller
      // must not be able to tell which implementation answered, and a plan
      // this store would accept but the Table store would refuse is exactly
      // the drift that promise exists to rule out. `storedPlanJsonChars` is
      // the one measurement both implementations call.
      const total = storedPlanJsonChars(plan);
      if (total > MAX_PLAN_JSON_CHARS) throw new PlanTooLargeError(plan.planId, total);

      // Cloned on the way in and out. Without it, a caller holding the object
      // it saved could mutate what the store later hands to someone else,
      // which the Table implementation cannot do, and a StateStore caller must
      // not be able to tell which implementation answered.
      plans.set(inventoryPartitionKey(profileId, plan.planId), structuredClone(plan));
    },

    async getPlan(profileId, planId) {
      const stored = plans.get(inventoryPartitionKey(profileId, planId));
      return stored === undefined ? undefined : structuredClone(stored);
    },
  };
}
