import type { TableClientLike, TableEntityLike } from "../../src/store/table.js";

/**
 * Lives in its own module rather than in a test file. A helper exported from a
 * `.test.ts` re-registers that file's suites in every file that imports it, so
 * the conformance suite would run twice under the errors file's name.
 */
export class FakeTableClient implements TableClientLike {
  readonly rows = new Map<string, TableEntityLike>();
  transactions = 0;
  individualDeletes = 0;

  async createTable(): Promise<void> {}

  async getEntity(partitionKey: string, rowKey: string): Promise<TableEntityLike> {
    const entity = this.rows.get(`${partitionKey}/${rowKey}`);
    if (entity === undefined) {
      const error: Error & { statusCode?: number } = new Error("not found");
      error.statusCode = 404;
      throw error;
    }
    return entity;
  }

  async upsertEntity(entity: TableEntityLike): Promise<void> {
    this.rows.set(`${entity.partitionKey}/${entity.rowKey}`, entity);
  }

  async deleteEntity(partitionKey: string, rowKey: string): Promise<void> {
    this.individualDeletes += 1;
    if (!this.rows.delete(`${partitionKey}/${rowKey}`)) {
      const error: Error & { statusCode?: number } = new Error("not found");
      error.statusCode = 404;
      throw error;
    }
  }

  async *listEntities(options?: { queryOptions?: { filter?: string } }): AsyncIterable<TableEntityLike> {
    const match = /PartitionKey eq '(.*)'/.exec(options?.queryOptions?.filter ?? "");
    for (const entity of this.rows.values()) {
      if (match === null || entity.partitionKey === match[1]) yield entity;
    }
  }

  async submitTransaction(actions: Array<["upsert", TableEntityLike, "Replace"] | ["delete", TableEntityLike]>): Promise<void> {
    this.transactions += 1;
    if (actions.length > 100) throw new Error("a transaction may not exceed 100 entities");

    // A real Azure Table transaction is atomic: it must not leave some of its
    // actions applied and others not. Every delete target is validated before
    // anything is written, so a row that is already gone fails the whole
    // transaction rather than the transaction silently applying everything else.
    for (const action of actions) {
      if (action[0] === "delete" && !this.rows.has(`${action[1].partitionKey}/${action[1].rowKey}`)) {
        const error: Error & { statusCode?: number } = new Error("not found");
        error.statusCode = 404;
        throw error;
      }
    }

    for (const action of actions) {
      if (action[0] === "upsert") {
        await this.upsertEntity(action[1]);
      } else {
        // Removed from the map directly rather than through deleteEntity, so that
        // clearInventory's transactional deletes do not inflate the individual-delete
        // count the write-shape test asserts on.
        this.rows.delete(`${action[1].partitionKey}/${action[1].rowKey}`);
      }
    }
  }
}
