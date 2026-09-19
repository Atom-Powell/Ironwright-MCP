import { describe, expect, it } from "vitest";
import { createTableStateStore, ensureTables } from "../../src/store/table.js";
import { FakeTableClient } from "./fake-table-client.js";

describe("Azure Table state store failures", () => {
  it("lets a failed transaction surface rather than reporting a write that did not happen", async () => {
    const inventory = new FakeTableClient();
    inventory.submitTransaction = async () => {
      throw new Error("the service is unavailable");
    };
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory, plans: new FakeTableClient() });

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
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory, plans: new FakeTableClient() });

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
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory, plans: new FakeTableClient() });

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

    await expect(ensureTables({ deltaLinks, inventory, plans })).resolves.toBeUndefined();
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

    await expect(ensureTables({ deltaLinks, inventory, plans })).rejects.toThrow(/forbidden/);
  });

  it("creates all three clients' tables, not just the first", async () => {
    let deltaLinksCreated = false;
    let inventoryCreated = false;
    let plansCreated = false;
    const deltaLinks = new FakeTableClient();
    const inventory = new FakeTableClient();
    const plans = new FakeTableClient();
    deltaLinks.createTable = async () => {
      deltaLinksCreated = true;
    };
    inventory.createTable = async () => {
      inventoryCreated = true;
    };
    plans.createTable = async () => {
      plansCreated = true;
    };

    await ensureTables({ deltaLinks, inventory, plans });

    expect(deltaLinksCreated).toBe(true);
    expect(inventoryCreated).toBe(true);
    expect(plansCreated).toBe(true);
  });
});
