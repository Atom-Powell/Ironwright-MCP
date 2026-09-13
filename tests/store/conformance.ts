import { expect, it } from "vitest";
import type { InventoryRecord, StateStore } from "../../src/store/types.js";

export function record(overrides: Partial<InventoryRecord> = {}): InventoryRecord {
  return {
    itemId: "item-1",
    path: "2026/CLIENTA/report.xlsx",
    name: "report.xlsx",
    isFolder: false,
    size: 1024,
    modified: "2026-09-01T00:00:00Z",
    etag: "etag-1",
    ...overrides,
  };
}

/**
 * One set of expectations for every StateStore implementation, so the in-memory
 * store used in tests and the Table store used in production cannot drift into
 * answering the same question differently.
 */
export function stateStoreConformance(create: () => StateStore): void {
  it("returns no deltaLink before one is stored", async () => {
    await expect(create().getDeltaLink("example", "d1")).resolves.toBeUndefined();
  });

  it("round-trips a deltaLink per profile and drive", async () => {
    const store = create();
    await store.setDeltaLink("example", "d1", "link-1", "2026-09-13T00:00:00Z");
    await store.setDeltaLink("example", "d2", "link-2", "2026-09-13T00:00:00Z");

    await expect(store.getDeltaLink("example", "d1")).resolves.toBe("link-1");
    await expect(store.getDeltaLink("other", "d1")).resolves.toBeUndefined();
  });

  it("records when a drive was last scanned, and reports none before a first scan", async () => {
    const store = create();

    await expect(store.getLastScanAt("example", "d1")).resolves.toBeUndefined();

    await store.setDeltaLink("example", "d1", "link-1", "2026-09-13T12:00:00Z");

    await expect(store.getLastScanAt("example", "d1")).resolves.toBe("2026-09-13T12:00:00Z");
    await expect(store.getLastScanAt("example", "d2")).resolves.toBeUndefined();
  });

  it("upserts by item id, so a moved item replaces its row rather than adding one", async () => {
    const store = create();
    await store.applyInventoryChanges("example", "d1", [
      { kind: "upsert", record: record({ path: "2026/CLIENTA/report.xlsx" }) },
    ]);
    await store.applyInventoryChanges("example", "d1", [
      { kind: "upsert", record: record({ path: "2026/CLIENTB/report.xlsx" }) },
    ]);

    const listed = await store.listInventory("example", "d1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.path).toBe("2026/CLIENTB/report.xlsx");
  });

  it("deletes by item id", async () => {
    const store = create();
    await store.applyInventoryChanges("example", "d1", [{ kind: "upsert", record: record() }]);
    await store.applyInventoryChanges("example", "d1", [{ kind: "delete", itemId: "item-1" }]);

    await expect(store.listInventory("example", "d1")).resolves.toEqual([]);
  });

  it("tolerates deleting an item it never held", async () => {
    const store = create();
    await expect(
      store.applyInventoryChanges("example", "d1", [{ kind: "delete", itemId: "never-seen" }]),
    ).resolves.toMatchObject({ changesApplied: 1 });
  });

  it("keeps one drive's inventory out of another's", async () => {
    const store = create();
    await store.applyInventoryChanges("example", "d1", [{ kind: "upsert", record: record() }]);
    await expect(store.listInventory("example", "d2")).resolves.toEqual([]);
  });

  it("clears one drive's inventory and leaves the other alone", async () => {
    const store = create();
    await store.applyInventoryChanges("example", "d1", [{ kind: "upsert", record: record() }]);
    await store.applyInventoryChanges("example", "d2", [{ kind: "upsert", record: record({ itemId: "item-2" }) }]);

    await store.clearInventory("example", "d1");

    await expect(store.listInventory("example", "d1")).resolves.toEqual([]);
    await expect(store.listInventory("example", "d2")).resolves.toHaveLength(1);
  });

  it("reports batches in units of 100 upserts", async () => {
    const store = create();
    const changes = Array.from({ length: 250 }, (_, index) => ({
      kind: "upsert" as const,
      record: record({ itemId: `item-${index}` }),
    }));

    await expect(store.applyInventoryChanges("example", "d1", changes)).resolves.toEqual({
      changesApplied: 250,
      batches: 3,
    });
  });

  it("counts one batch per chunk of upserts and one per delete, since deletes cannot be batched", async () => {
    const store = create();
    const changes = [
      ...Array.from({ length: 120 }, (_, index) => ({
        kind: "upsert" as const,
        record: record({ itemId: `item-${index}` }),
      })),
      { kind: "delete" as const, itemId: "item-0" },
      { kind: "delete" as const, itemId: "item-1" },
    ];

    await expect(store.applyInventoryChanges("example", "d1", changes)).resolves.toEqual({
      changesApplied: 122,
      batches: 4,
    });
  });

  it("writes nothing for an empty change list", async () => {
    await expect(create().applyInventoryChanges("example", "d1", [])).resolves.toEqual({
      changesApplied: 0,
      batches: 0,
    });
  });
}
