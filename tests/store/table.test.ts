import { describe, expect, it } from "vitest";
import { createTableStateStore } from "../../src/store/table.js";
import { FakeTableClient } from "./fake-table-client.js";
import { stateStoreConformance } from "./conformance.js";

describe("Azure Table state store", () => {
  stateStoreConformance(() =>
    createTableStateStore({ deltaLinks: new FakeTableClient(), inventory: new FakeTableClient(), plans: new FakeTableClient(), journal: new FakeTableClient() }),
  );
});

describe("Azure Table state store write shape", () => {
  it("chunks upserts into transactions of at most 100 and issues deletes individually", async () => {
    const inventory = new FakeTableClient();
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory, plans: new FakeTableClient(), journal: new FakeTableClient() });

    await store.applyInventoryChanges("example", "d1", [
      ...Array.from({ length: 150 }, (_, index) => ({
        kind: "upsert" as const,
        record: {
          itemId: `item-${index}`,
          path: `2026/a-${index}.xlsx`,
          name: `a-${index}.xlsx`,
          isFolder: false,
          size: 1,
          modified: "2026-09-01T00:00:00Z",
          etag: "e",
        },
      })),
      { kind: "delete" as const, itemId: "item-0" },
    ]);

    expect(inventory.transactions).toBe(2);
    expect(inventory.individualDeletes).toBe(1);
  });

  it("stores the raw item id alongside the encoded row key so it reads back without decoding", async () => {
    const inventory = new FakeTableClient();
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory, plans: new FakeTableClient(), journal: new FakeTableClient() });

    await store.applyInventoryChanges("example", "d1", [
      {
        kind: "upsert",
        record: {
          itemId: "has/slash",
          path: "a.xlsx",
          name: "a.xlsx",
          isFolder: false,
          size: 1,
          modified: "2026-09-01T00:00:00Z",
          etag: "e",
        },
      },
    ]);

    const [stored] = [...inventory.rows.values()];
    expect(stored?.rowKey).not.toContain("/");
    expect(stored?.itemId).toBe("has/slash");
    await expect(store.listInventory("example", "d1")).resolves.toMatchObject([{ itemId: "has/slash" }]);
  });

  it("doubles a single quote in the partition filter so a drive id cannot break out of the literal", async () => {
    const inventory = new FakeTableClient();
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory, plans: new FakeTableClient(), journal: new FakeTableClient() });
    const filters: string[] = [];
    inventory.listEntities = async function* (options?: { queryOptions?: { filter?: string } }) {
      filters.push(options?.queryOptions?.filter ?? "");
    };

    await store.listInventory("example", "d'1");

    expect(filters[0]).toBe("PartitionKey eq 'example|d''1'");
  });
});
