import { expect, it } from "vitest";
import { UnsafeKeyError } from "../../src/store/keys.js";
import type { InventoryRecord, StateStore, StoredPlan } from "../../src/store/types.js";

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

    // The counts alone would pass for an implementation that reported the right
    // numbers while applying the wrong changes, so the resulting inventory is
    // checked too: 120 upserts less the two items deleted in the same call.
    await expect(store.listInventory("example", "d1")).resolves.toHaveLength(118);
  });

  it("applies a delete then a re-creation of the same id in that order, as a restore would arrive", async () => {
    const store = create();

    await store.applyInventoryChanges("example", "d1", [
      { kind: "delete", itemId: "item-1" },
      { kind: "upsert", record: record({ itemId: "item-1", path: "2026/restored.xlsx" }) },
    ]);

    const listed = await store.listInventory("example", "d1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.path).toBe("2026/restored.xlsx");
  });

  it("applies an upsert then a delete of the same id in that order", async () => {
    const store = create();

    await store.applyInventoryChanges("example", "d1", [
      { kind: "upsert", record: record({ itemId: "item-1" }) },
      { kind: "delete", itemId: "item-1" },
    ]);

    await expect(store.listInventory("example", "d1")).resolves.toEqual([]);
  });

  it("writes nothing for an empty change list", async () => {
    await expect(create().applyInventoryChanges("example", "d1", [])).resolves.toEqual({
      changesApplied: 0,
      batches: 0,
    });
  });

  it("returns nothing for a profile that has never been scanned", async () => {
    const store = create();
    await expect(store.getScannedDrives("never-scanned")).resolves.toEqual([]);
  });

  it("returns each scanned drive with the time it was last scanned", async () => {
    const store = create();
    await store.setDeltaLink("example", "drive-1", "link-1", "2026-09-17T10:00:00.000Z");
    await store.setDeltaLink("example", "drive-2", "link-2", "2026-09-17T11:00:00.000Z");

    const drives = await store.getScannedDrives("example");

    expect(drives).toHaveLength(2);
    expect(drives).toContainEqual({ driveId: "drive-1", lastScanAt: "2026-09-17T10:00:00.000Z" });
    expect(drives).toContainEqual({ driveId: "drive-2", lastScanAt: "2026-09-17T11:00:00.000Z" });
  });

  it("does not leak one profile's drives into another's", async () => {
    const store = create();
    await store.setDeltaLink("example", "drive-1", "link-1", "2026-09-17T10:00:00.000Z");
    await store.setDeltaLink("other", "drive-9", "link-9", "2026-09-17T10:00:00.000Z");

    await expect(store.getScannedDrives("example")).resolves.toEqual([
      { driveId: "drive-1", lastScanAt: "2026-09-17T10:00:00.000Z" },
    ]);
  });

  it("does not match a profile id that is a prefix of another profile id", async () => {
    // "clienta" is a literal prefix of "clientab", so a prefix match with no
    // delimiter, or one that drops the trailing separator, would let clientab's
    // drive leak into clienta's answer. This is what a bare prefix check on
    // "example" and "other" can never catch, since neither is a prefix of the
    // other.
    const store = create();
    await store.setDeltaLink("clienta", "drive-1", "link-1", "2026-09-17T10:00:00.000Z");
    await store.setDeltaLink("clientab", "drive-9", "link-9", "2026-09-17T10:00:00.000Z");

    await expect(store.getScannedDrives("clienta")).resolves.toEqual([
      { driveId: "drive-1", lastScanAt: "2026-09-17T10:00:00.000Z" },
    ]);
  });

  it("refuses a malformed profile id before answering, the same for every implementation", async () => {
    // A StateStore caller cannot tell which implementation is behind it, so an
    // id every other store method rejects must not be the one input where one
    // implementation throws and the other quietly resolves to an empty
    // result, since an empty result is indistinguishable from "never scanned".
    const store = create();
    await expect(store.getScannedDrives("bad/id")).rejects.toThrow(UnsafeKeyError);
  });

  it("returns no plan before one is stored", async () => {
    await expect(create().getPlan("example", "rnm-2026-09-18-a1b2")).resolves.toBeUndefined();
  });

  it("round-trips a plan with all of its items and exclusions", async () => {
    const store = create();
    const plan: StoredPlan = {
      planId: "rnm-2026-09-18-a1b2",
      profileId: "example",
      kind: "rename",
      driveId: "d1",
      createdAt: "2026-09-18T12:00:00Z",
      items: [
        {
          path: "2026/CLIENTA/01-January/wrong.xlsx",
          currentName: "wrong.xlsx",
          targetName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
          targetPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
          etag: '"{GUID},1"',
          client: "CLIENTA",
        },
      ],
      excluded: [
        {
          path: "2026/CLIENTB/01-January/other.xlsx",
          currentName: "other.xlsx",
          targetName: "2026-01_CLIENTB_MonthlyTraining.xlsx",
          client: "CLIENTB",
          reason: "target_path_already_occupied",
        },
      ],
    };

    await store.savePlan("example", plan);

    await expect(store.getPlan("example", plan.planId)).resolves.toEqual(plan);
  });

  it("keeps one profile's plans out of another profile's reach", async () => {
    const store = create();
    const plan: StoredPlan = {
      planId: "rnm-2026-09-18-a1b2",
      profileId: "example",
      kind: "rename",
      driveId: "d1",
      createdAt: "2026-09-18T12:00:00Z",
      items: [],
      excluded: [],
    };

    await store.savePlan("example", plan);

    await expect(store.getPlan("other", plan.planId)).resolves.toBeUndefined();
  });

  it("replaces a plan saved under the same id, which is how a reversal entry's etag is corrected", async () => {
    const store = create();
    const item = {
      path: "a.xlsx",
      currentName: "a.xlsx",
      targetName: "b.xlsx",
      targetPath: "b.xlsx",
      etag: "stale",
      client: "CLIENTA",
    };
    const plan: StoredPlan = {
      planId: "rev-2026-09-18-c3d4",
      profileId: "example",
      kind: "rename",
      driveId: "d1",
      createdAt: "2026-09-18T12:00:00Z",
      items: [item],
      excluded: [],
      reverses: "rnm-2026-09-18-a1b2",
    };

    await store.savePlan("example", plan);
    await store.savePlan("example", { ...plan, items: [{ ...item, etag: "fresh" }] });

    const stored = await store.getPlan("example", plan.planId);
    expect(stored?.items[0]?.etag).toBe("fresh");
    expect(stored?.reverses).toBe("rnm-2026-09-18-a1b2");
  });

  it("does not let a caller mutate a stored plan through the object it saved", async () => {
    // The Table implementation cannot be mutated this way, and a StateStore
    // caller must not be able to tell which implementation answered.
    const store = create();
    const plan: StoredPlan = {
      planId: "rnm-2026-09-18-a1b2",
      profileId: "example",
      kind: "rename",
      driveId: "d1",
      createdAt: "2026-09-18T12:00:00Z",
      items: [
        {
          path: "a.xlsx",
          currentName: "a.xlsx",
          targetName: "b.xlsx",
          targetPath: "b.xlsx",
          etag: "e1",
          client: "CLIENTA",
        },
      ],
      excluded: [],
    };

    await store.savePlan("example", plan);
    const firstItem = plan.items[0];
    if (firstItem !== undefined) firstItem.etag = "tampered";

    const stored = await store.getPlan("example", plan.planId);
    expect(stored?.items[0]?.etag).toBe("e1");
  });

  it("does not let a caller mutate a stored plan through the object the store handed back", async () => {
    // The mirror of the inbound case above. The Table implementation passes
    // this for a different reason than the memory implementation: it
    // reparses the stored JSON into a fresh object on every read, where the
    // memory implementation needs its own outbound clone to get the same
    // answer. A StateStore caller must not be able to tell which one is
    // behind it, so both directions belong in the shared suite, not only the
    // inbound one.
    const store = create();
    const plan: StoredPlan = {
      planId: "rnm-2026-09-18-a1b2",
      profileId: "example",
      kind: "rename",
      driveId: "d1",
      createdAt: "2026-09-18T12:00:00Z",
      items: [
        {
          path: "a.xlsx",
          currentName: "a.xlsx",
          targetName: "b.xlsx",
          targetPath: "b.xlsx",
          etag: "e1",
          client: "CLIENTA",
        },
      ],
      excluded: [],
    };

    await store.savePlan("example", plan);
    const firstRead = await store.getPlan("example", plan.planId);
    const firstReadItem = firstRead?.items[0];
    if (firstReadItem !== undefined) firstReadItem.etag = "tampered";

    const secondRead = await store.getPlan("example", plan.planId);
    expect(secondRead?.items[0]?.etag).toBe("e1");
  });
}
