import { describe, expect, it } from "vitest";
import { MalformedJournalEntityError } from "../../src/store/types.js";
import { createTableStateStore, ensureTables } from "../../src/store/table.js";
import { FakeTableClient } from "./fake-table-client.js";

describe("Azure Table state store failures", () => {
  it("lets a failed transaction surface rather than reporting a write that did not happen", async () => {
    const inventory = new FakeTableClient();
    inventory.submitTransaction = async () => {
      throw new Error("the service is unavailable");
    };
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory, plans: new FakeTableClient(), journal: new FakeTableClient() });

    await expect(
      store.applyInventoryChanges("example", "d1", [
        {
          kind: "upsert",
          record: { itemId: "i", path: "a.xlsx", name: "a.xlsx", isFolder: false, size: 1, modified: "m", etag: "e" },
        },
      ]),
    ).rejects.toThrow(/unavailable/);
  });

  it("tolerates a 404 on delete but not another failure", async () => {
    const inventory = new FakeTableClient();
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory, plans: new FakeTableClient(), journal: new FakeTableClient() });

    await expect(
      store.applyInventoryChanges("example", "d1", [{ kind: "delete", itemId: "absent" }]),
    ).resolves.toMatchObject({ changesApplied: 1 });

    inventory.deleteEntity = async () => {
      const error: Error & { statusCode?: number } = new Error("forbidden");
      error.statusCode = 403;
      throw error;
    };

    await expect(
      store.applyInventoryChanges("example", "d1", [{ kind: "delete", itemId: "absent" }]),
    ).rejects.toThrow(/forbidden/);
  });

  it("clears a partition one row at a time when the batched delete fails", async () => {
    const inventory = new FakeTableClient();
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory, plans: new FakeTableClient(), journal: new FakeTableClient() });

    await store.applyInventoryChanges("example", "d1", [
      {
        kind: "upsert",
        record: { itemId: "a", path: "a.xlsx", name: "a.xlsx", isFolder: false, size: 1, modified: "m", etag: "e" },
      },
      {
        kind: "upsert",
        record: { itemId: "b", path: "b.xlsx", name: "b.xlsx", isFolder: false, size: 1, modified: "m", etag: "e" },
      },
    ]);

    const realTransaction = inventory.submitTransaction.bind(inventory);
    let firstCall = true;
    inventory.submitTransaction = async (actions) => {
      if (firstCall) {
        firstCall = false;
        const error: Error & { statusCode?: number } = new Error("one of the rows is already gone");
        error.statusCode = 404;
        throw error;
      }
      return realTransaction(actions);
    };

    await store.clearInventory("example", "d1");

    await expect(store.listInventory("example", "d1")).resolves.toEqual([]);
    expect(inventory.individualDeletes).toBe(2);
  });
});

describe("ensureTables", () => {
  it("tolerates a 409 from createTable, since that is the normal case after the first run", async () => {
    const deltaLinks = new FakeTableClient();
    const inventory = new FakeTableClient();
    deltaLinks.createTable = async () => {
      const error: Error & { statusCode?: number } = new Error("already exists");
      error.statusCode = 409;
      throw error;
    };
    inventory.createTable = async () => {
      const error: Error & { statusCode?: number } = new Error("already exists");
      error.statusCode = 409;
      throw error;
    };
    const plans = new FakeTableClient();
    plans.createTable = async () => {
      const error: Error & { statusCode?: number } = new Error("already exists");
      error.statusCode = 409;
      throw error;
    };

    await expect(ensureTables({ deltaLinks, inventory, plans, journal: new FakeTableClient() })).resolves.toBeUndefined();
  });

  it("lets a non-409 failure from createTable propagate", async () => {
    const deltaLinks = new FakeTableClient();
    const inventory = new FakeTableClient();
    const plans = new FakeTableClient();
    deltaLinks.createTable = async () => {
      const error: Error & { statusCode?: number } = new Error("forbidden");
      error.statusCode = 403;
      throw error;
    };

    await expect(ensureTables({ deltaLinks, inventory, plans, journal: new FakeTableClient() })).rejects.toThrow(/forbidden/);
  });

  it("creates all four clients' tables, not just the first", async () => {
    let deltaLinksCreated = false;
    let inventoryCreated = false;
    let plansCreated = false;
    let journalCreated = false;
    const deltaLinks = new FakeTableClient();
    const inventory = new FakeTableClient();
    const plans = new FakeTableClient();
    const journal = new FakeTableClient();
    deltaLinks.createTable = async () => {
      deltaLinksCreated = true;
    };
    inventory.createTable = async () => {
      inventoryCreated = true;
    };
    plans.createTable = async () => {
      plansCreated = true;
    };
    journal.createTable = async () => {
      journalCreated = true;
    };

    await ensureTables({ deltaLinks, inventory, plans, journal });

    expect(deltaLinksCreated).toBe(true);
    expect(inventoryCreated).toBe(true);
    expect(plansCreated).toBe(true);
    expect(journalCreated).toBe(true);
  });
});

describe("journal rows that cannot be read", () => {
  async function seeded(entry: unknown): Promise<ReturnType<typeof createTableStateStore>> {
    const journal = new FakeTableClient();
    await journal.upsertEntity({ partitionKey: "example|journal|ASM-1", rowKey: "row1", entry });
    return createTableStateStore({ deltaLinks: new FakeTableClient(), inventory: new FakeTableClient(), plans: new FakeTableClient(), journal });
  }

  it("throws a typed error for a row whose entry is not a string", async () => {
    const store = await seeded(42);
    await expect(store.listJournal("example", "ASM-1")).rejects.toBeInstanceOf(MalformedJournalEntityError);
  });

  it("throws a typed error for a row whose entry is not valid JSON, without naming the content", async () => {
    const store = await seeded("{secret-path");
    const error: unknown = await store.listJournal("example", "ASM-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MalformedJournalEntityError);
    expect((error as Error).message).toContain("row1");
    expect((error as Error).message).not.toContain("secret-path");
  });
});
