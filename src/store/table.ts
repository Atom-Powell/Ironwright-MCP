import { TableClient } from "@azure/data-tables";
import { chunk, decodeRowKey, encodeRowKey, inventoryPartitionKey, MAX_TRANSACTION_SIZE } from "./keys.js";
import type { ApplyResult, InventoryChange, InventoryRecord, StateStore } from "./types.js";

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
        queryOptions: { filter: `PartitionKey eq '${partitionKey}'` },
      })) {
        rowKeys.push(entity.rowKey);
      }

      for (const group of chunk(rowKeys, MAX_TRANSACTION_SIZE)) {
        await clients.inventory.submitTransaction(
          group.map((rowKey): ["delete", TableEntityLike] => ["delete", { partitionKey, rowKey }]),
        );
      }
    },

    async applyInventoryChanges(profileId, driveId, changes): Promise<ApplyResult> {
      const partitionKey = inventoryPartitionKey(profileId, driveId);
      const upserts: InventoryChange[] = changes.filter((change) => change.kind === "upsert");
      const deletes = changes.filter((change) => change.kind === "delete");
      let batches = 0;

      for (const group of chunk(upserts, MAX_TRANSACTION_SIZE)) {
        await clients.inventory.submitTransaction(
          group.map((change): ["upsert", TableEntityLike, "Replace"] => [
            "upsert",
            inventoryEntity(partitionKey, (change as Extract<InventoryChange, { kind: "upsert" }>).record),
            "Replace",
          ]),
        );
        batches += 1;
      }

      // Deletes are issued one at a time rather than batched with the upserts.
      // A transaction containing a delete of a row that is not there fails as a
      // whole, and the scan must tolerate exactly that case: the first
      // incremental pass after a resync legitimately sees deletes for items the
      // store never recorded.
      for (const change of deletes) {
        try {
          await clients.inventory.deleteEntity(
            partitionKey,
            encodeRowKey((change as Extract<InventoryChange, { kind: "delete" }>).itemId),
          );
        } catch (error) {
          if (statusCodeOf(error) !== 404) throw error;
        }
        batches += 1;
      }

      return { changesApplied: changes.length, batches };
    },

    async listInventory(profileId, driveId) {
      const partitionKey = inventoryPartitionKey(profileId, driveId);
      const records: InventoryRecord[] = [];
      for await (const entity of clients.inventory.listEntities({
        queryOptions: { filter: `PartitionKey eq '${partitionKey}'` },
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
