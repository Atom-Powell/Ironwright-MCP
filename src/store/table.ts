import { TableClient } from "@azure/data-tables";
import {
  chunk,
  decodeRowKey,
  encodeRowKey,
  inventoryPartitionKey,
  MAX_TRANSACTION_SIZE,
  planInventoryChanges,
} from "./keys.js";
import type { ApplyResult, InventoryRecord, StateStore } from "./types.js";

export interface TableEntityLike {
  partitionKey: string;
  rowKey: string;
  [key: string]: unknown;
}

/**
 * Narrower than `TableClient` on purpose. The transaction chunking and the
 * delete tolerance below are the parts most likely to be wrong, and this is what
 * lets a fake exercise them with no emulator and no storage account.
 */
export interface TableClientLike {
  createTable(): Promise<unknown>;
  getEntity(partitionKey: string, rowKey: string): Promise<TableEntityLike>;
  upsertEntity(entity: TableEntityLike, mode: "Replace"): Promise<unknown>;
  deleteEntity(partitionKey: string, rowKey: string): Promise<unknown>;
  listEntities(options?: { queryOptions?: { filter?: string } }): AsyncIterable<TableEntityLike>;
  submitTransaction(
    actions: Array<["upsert", TableEntityLike, "Replace"] | ["delete", TableEntityLike]>,
  ): Promise<unknown>;
}

export interface TableStateStoreClients {
  deltaLinks: TableClientLike;
  inventory: TableClientLike;
}

function statusCodeOf(error: unknown): number | undefined {
  const code = (error as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : undefined;
}

/**
 * An OData string literal is single-quoted and escapes an embedded quote by
 * doubling it. A drive id comes from Graph and this code does not control its
 * alphabet, so interpolating one raw would let a single quote close the literal
 * early and silently change which partition the query matches.
 */
function partitionFilter(partitionKey: string): string {
  return `PartitionKey eq '${partitionKey.replace(/'/g, "''")}'`;
}

function toRecord(entity: TableEntityLike): InventoryRecord {
  return {
    itemId: typeof entity.itemId === "string" ? entity.itemId : decodeRowKey(entity.rowKey),
    path: String(entity.path ?? ""),
    name: String(entity.name ?? ""),
    isFolder: entity.isFolder === true,
    size: typeof entity.size === "number" ? entity.size : 0,
    modified: String(entity.modified ?? ""),
    etag: String(entity.etag ?? ""),
  };
}

export function createTableStateStore(clients: TableStateStoreClients): StateStore {
  function inventoryEntity(partitionKey: string, record: InventoryRecord): TableEntityLike {
    return {
      partitionKey,
      rowKey: encodeRowKey(record.itemId),
      // The raw id is a property as well as the source of the row key, so a
      // reader does not have to know the encoding to use the table.
      itemId: record.itemId,
      path: record.path,
      name: record.name,
      isFolder: record.isFolder,
      size: record.size,
      modified: record.modified,
      etag: record.etag,
    };
  }

  return {
    async getDeltaLink(profileId, driveId) {
      try {
        const entity = await clients.deltaLinks.getEntity(profileId, encodeRowKey(driveId));
        return typeof entity.deltaLink === "string" ? entity.deltaLink : undefined;
      } catch (error) {
        if (statusCodeOf(error) === 404) return undefined;
        throw error;
      }
    },

    async setDeltaLink(profileId, driveId, deltaLink, lastScanAt) {
      await clients.deltaLinks.upsertEntity(
        { partitionKey: profileId, rowKey: encodeRowKey(driveId), driveId, deltaLink, lastScanAt },
        "Replace",
      );
    },

    async getLastScanAt(profileId, driveId) {
      try {
        const entity = await clients.deltaLinks.getEntity(profileId, encodeRowKey(driveId));
        return typeof entity.lastScanAt === "string" ? entity.lastScanAt : undefined;
      } catch (error) {
        if (statusCodeOf(error) === 404) return undefined;
        throw error;
      }
    },

    async clearInventory(profileId, driveId) {
      const partitionKey = inventoryPartitionKey(profileId, driveId);
      const rowKeys: string[] = [];
      for await (const entity of clients.inventory.listEntities({
        queryOptions: { filter: partitionFilter(partitionKey) },
      })) {
        rowKeys.push(entity.rowKey);
      }

      for (const group of chunk(rowKeys, MAX_TRANSACTION_SIZE)) {
        try {
          await clients.inventory.submitTransaction(
            group.map((rowKey): ["delete", TableEntityLike] => ["delete", { partitionKey, rowKey }]),
          );
        } catch {
          // A transaction fails as a whole if any row it names is already gone,
          // and these rows were listed moments earlier rather than locked, so a
          // concurrent scan can remove one in between. Retrying the chunk one row
          // at a time clears what is still there, where abandoning it would leave
          // a resync with a partly stale inventory and no sign of that in the
          // report. A failure that is not a missing row still propagates, because
          // the individual deletes below raise it.
          for (const rowKey of group) {
            try {
              await clients.inventory.deleteEntity(partitionKey, rowKey);
            } catch (individual) {
              if (statusCodeOf(individual) !== 404) throw individual;
            }
          }
        }
      }
    },

    async applyInventoryChanges(profileId, driveId, changes): Promise<ApplyResult> {
      const partitionKey = inventoryPartitionKey(profileId, driveId);
      // Steps are applied in the shared planner's arrival order (see its
      // comment), not as all upserts followed by all deletes: a delete followed
      // by a re-creation of the same item id is what a restore from the recycle
      // bin looks like, and applying every upsert first would leave it absent.
      const steps = planInventoryChanges(changes, MAX_TRANSACTION_SIZE);
      let batches = 0;

      for (const step of steps) {
        if (step.kind === "upsert") {
          await clients.inventory.submitTransaction(
            step.records.map((record): ["upsert", TableEntityLike, "Replace"] => [
              "upsert",
              inventoryEntity(partitionKey, record),
              "Replace",
            ]),
          );
        } else {
          // A transaction containing a delete of a row that is not there fails as
          // a whole, and the scan must tolerate exactly that case: the first
          // incremental pass after a resync legitimately sees deletes for items
          // the store never recorded. Issuing each delete on its own, rather than
          // batched, is what makes that tolerable.
          try {
            await clients.inventory.deleteEntity(partitionKey, encodeRowKey(step.itemId));
          } catch (error) {
            if (statusCodeOf(error) !== 404) throw error;
          }
        }
        batches += 1;
      }

      return { changesApplied: changes.length, batches };
    },

    async listInventory(profileId, driveId) {
      const partitionKey = inventoryPartitionKey(profileId, driveId);
      const records: InventoryRecord[] = [];
      for await (const entity of clients.inventory.listEntities({
        queryOptions: { filter: partitionFilter(partitionKey) },
      })) {
        records.push(toRecord(entity));
      }
      return records;
    },
  };
}

/**
 * Tables are created on first use rather than by a separate provisioning step,
 * because one-instance-per-tenant means this runs against a fresh storage
 * account often enough that a missing-table failure would be the common first
 * experience.
 */
export async function ensureTables(clients: TableStateStoreClients): Promise<void> {
  for (const client of [clients.deltaLinks, clients.inventory]) {
    try {
      await client.createTable();
    } catch (error) {
      // 409 is "already there", which is the normal case on every run after the
      // first and is not worth distinguishing from success.
      if (statusCodeOf(error) !== 409) throw error;
    }
  }
}

/**
 * Returns the clients alongside the store so the entry point can call
 * `ensureTables` on the same pair rather than constructing a second one and
 * creating tables a different store would then not use.
 */
export function tableStateStoreFromConnectionString(
  connectionString: string,
): { store: StateStore; clients: TableStateStoreClients } {
  const clients: TableStateStoreClients = {
    deltaLinks: TableClient.fromConnectionString(connectionString, "DeltaLinks") as unknown as TableClientLike,
    inventory: TableClient.fromConnectionString(connectionString, "Inventory") as unknown as TableClientLike,
  };
  return { store: createTableStateStore(clients), clients };
}
