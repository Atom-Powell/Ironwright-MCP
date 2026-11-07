import { TableClient } from "@azure/data-tables";
import {
  chunk,
  decodeRowKey,
  encodeRowKey,
  inventoryPartitionKey,
  journalPartitionKey,
  journalRowKey,
  MAX_TRANSACTION_SIZE,
  planInventoryChanges,
} from "./keys.js";
import type { CustomStep } from "../domain/custom/resolve.js";
import { MalformedPlanEntityError, MAX_PLAN_JSON_CHARS, PlanTooLargeError, storedPlanJsonChars } from "./types.js";
import type {
  ApplyResult,
  ExcludedPlanItem,
  InventoryRecord,
  JournalEntry,
  RenamePlanItem,
  ScannedDrive,
  StateStore,
} from "./types.js";

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
  plans: TableClientLike;
  journal: TableClientLike;
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

/**
 * A required, non-empty string field on a stored plan entity. Used for every
 * plan field except `items` and `excluded`, which are JSON rather than plain
 * strings. Throws rather than substituting a default: see
 * `MalformedPlanEntityError`'s own comment for why a plan cannot tolerate a
 * missing field the way `getScannedDrives` tolerates one.
 */
function requiredPlanString(entity: TableEntityLike, field: string, planId: string): string {
  const value = entity[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new MalformedPlanEntityError(planId, field, "is missing");
  }
  return value;
}

/**
 * A required JSON array field on a stored plan entity, `items` or `excluded`.
 * Azure Table has no array property type, so these are stored as JSON
 * strings; this is the read-side half of that encoding, and it distinguishes
 * the three ways the encoding can be broken so the message names which one
 * happened.
 */
function requiredPlanJsonArray<T>(entity: TableEntityLike, field: string, planId: string): T[] {
  const value = entity[field];
  if (typeof value !== "string") {
    throw new MalformedPlanEntityError(planId, field, "is missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MalformedPlanEntityError(planId, field, "is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new MalformedPlanEntityError(planId, field, "does not parse to an array");
  }
  return parsed as T[];
}

/**
 * The same encoding as `requiredPlanJsonArray`, for a field only a custom
 * plan's entity carries. `steps` is absent on a rename or move plan's entity,
 * which is not malformed; it is malformed only when the column is present and
 * fails the same JSON-array checks the required fields are held to.
 */
function optionalPlanJsonArray<T>(entity: TableEntityLike, field: string, planId: string): T[] | undefined {
  if (entity[field] === undefined) return undefined;
  return requiredPlanJsonArray<T>(entity, field, planId);
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

    async getScannedDrives(profileId): Promise<ScannedDrive[]> {
      // Neither this table's partition key nor its sibling deltaLinks methods
      // (getDeltaLink, setDeltaLink, getLastScanAt) validate profileId, since
      // Table Storage keeps partition and row key separate and none of them
      // needs inventoryPartitionKey's join. This call is deliberately out of
      // step with those siblings anyway: a StateStore caller must not be able
      // to tell which implementation answered, and the memory implementation
      // now rejects a malformed profile id before it looks anywhere, so this
      // one must refuse the same input before it queries, not answer with an
      // empty result a caller cannot distinguish from "never scanned". The
      // key this builds is thrown away: the call is made for the throw alone,
      // which is why the drive id it also takes is passed empty.
      inventoryPartitionKey(profileId, "");
      const drives: ScannedDrive[] = [];
      for await (const entity of clients.deltaLinks.listEntities({
        queryOptions: { filter: partitionFilter(profileId) },
      })) {
        // Skips a row an older build wrote without these fields, rather than
        // crashing the read, because this table survives a deployment.
        if (typeof entity.driveId !== "string" || typeof entity.lastScanAt !== "string") continue;
        drives.push({ driveId: entity.driveId, lastScanAt: entity.lastScanAt });
      }
      return drives;
    },

    async savePlan(profileId, plan) {
      const items = JSON.stringify(plan.items);
      const excluded = JSON.stringify(plan.excluded);
      // Present only on a custom plan, the same as `reverses` below: absent
      // rather than an empty-array placeholder, so a rename or move plan's
      // entity carries no steps key at all and contributes nothing to the
      // size total, which `storedPlanJsonChars` measures the same way.
      const steps = plan.steps === undefined ? undefined : JSON.stringify(plan.steps);
      const total = storedPlanJsonChars(plan);
      if (total > MAX_PLAN_JSON_CHARS) throw new PlanTooLargeError(plan.planId, total);

      await clients.plans.upsertEntity(
        {
          partitionKey: profileId,
          rowKey: encodeRowKey(plan.planId),
          planId: plan.planId,
          profileId: plan.profileId,
          kind: plan.kind,
          driveId: plan.driveId,
          createdAt: plan.createdAt,
          items,
          excluded,
          // Written only when present, so a forward plan's entity carries no
          // reverses key at all and the read below can use its absence. An
          // empty string would be indistinguishable from a reversal of a plan
          // whose id is the empty string.
          ...(plan.reverses === undefined ? {} : { reverses: plan.reverses }),
          ...(steps === undefined ? {} : { steps }),
        },
        "Replace",
      );
    },

    async appendJournalEntry(profileId, assessmentId, entry) {
      // The entry is one JSON property: every field is short (a path, a hash,
      // an etag), far under the 32 KB property cap.
      await clients.journal.upsertEntity(
        {
          partitionKey: journalPartitionKey(profileId, assessmentId),
          rowKey: encodeRowKey(journalRowKey(entry)),
          entry: JSON.stringify(entry),
        },
        "Replace",
      );
    },

    async listJournal(profileId, assessmentId) {
      const partitionKey = journalPartitionKey(profileId, assessmentId);
      const entries: JournalEntry[] = [];
      for await (const entity of clients.journal.listEntities({
        queryOptions: { filter: partitionFilter(partitionKey) },
      })) {
        if (typeof entity.entry === "string") entries.push(JSON.parse(entity.entry) as JournalEntry);
      }
      // In memory, because base64url row keys do not preserve time order.
      return entries.sort((a, b) => {
        const x = journalRowKey(a);
        const y = journalRowKey(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
    },

    async getPlan(profileId, planId) {
      try {
        const entity = await clients.plans.getEntity(profileId, encodeRowKey(planId));

        // Deliberately unlike getScannedDrives, which skips a row an older
        // build wrote without every current field: a listing that tolerates a
        // partial row loses one answer, but a plan that tolerates one loses
        // files, so every field here is a required read rather than a
        // fallback, and a row that exists but cannot be reconstructed
        // faithfully throws instead of coming back as a valid-looking plan
        // with nothing to do.
        const kind = requiredPlanString(entity, "kind", planId);
        if (kind !== "rename" && kind !== "move" && kind !== "custom") {
          throw new MalformedPlanEntityError(planId, "kind", `is "${kind}", not "rename", "move" or "custom"`);
        }

        const steps = optionalPlanJsonArray<CustomStep>(entity, "steps", planId);

        return {
          planId: requiredPlanString(entity, "planId", planId),
          profileId: requiredPlanString(entity, "profileId", planId),
          kind,
          driveId: requiredPlanString(entity, "driveId", planId),
          createdAt: requiredPlanString(entity, "createdAt", planId),
          items: requiredPlanJsonArray<RenamePlanItem>(entity, "items", planId),
          excluded: requiredPlanJsonArray<ExcludedPlanItem>(entity, "excluded", planId),
          ...(typeof entity.reverses === "string" ? { reverses: entity.reverses } : {}),
          ...(steps === undefined ? {} : { steps }),
        };
      } catch (error) {
        if (statusCodeOf(error) === 404) return undefined;
        throw error;
      }
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
  for (const client of [clients.deltaLinks, clients.inventory, clients.plans, clients.journal]) {
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
 * `ensureTables` on the same set rather than constructing a second one and
 * creating tables a different store would then not use.
 */
export function tableStateStoreFromConnectionString(
  connectionString: string,
): { store: StateStore; clients: TableStateStoreClients } {
  const clients: TableStateStoreClients = {
    deltaLinks: TableClient.fromConnectionString(connectionString, "DeltaLinks") as unknown as TableClientLike,
    inventory: TableClient.fromConnectionString(connectionString, "Inventory") as unknown as TableClientLike,
    plans: TableClient.fromConnectionString(connectionString, "Plans") as unknown as TableClientLike,
    journal: TableClient.fromConnectionString(connectionString, "Journal") as unknown as TableClientLike,
  };
  return { store: createTableStateStore(clients), clients };
}
