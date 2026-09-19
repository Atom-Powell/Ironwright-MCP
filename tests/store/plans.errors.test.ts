import { describe, expect, it } from "vitest";
import { encodeRowKey } from "../../src/store/keys.js";
import { createTableStateStore, type TableEntityLike } from "../../src/store/table.js";
import { MalformedPlanEntityError, MAX_PLAN_JSON_CHARS, PlanTooLargeError, type StoredPlan } from "../../src/store/types.js";
import { FakeTableClient } from "./fake-table-client.js";

function fakeClients(): { deltaLinks: FakeTableClient; inventory: FakeTableClient; plans: FakeTableClient } {
  return { deltaLinks: new FakeTableClient(), inventory: new FakeTableClient(), plans: new FakeTableClient() };
}

function planWithItems(count: number): StoredPlan {
  return {
    planId: "rnm-2026-09-18-a1b2",
    profileId: "example",
    kind: "rename",
    driveId: "d1",
    createdAt: "2026-09-18T12:00:00Z",
    items: Array.from({ length: count }, (_value, index) => {
      const client = `CLIENT${String(index).padStart(3, "0")}`;
      return {
        path: `2026/${client}/01-January/a-fairly-long-original-filename.xlsx`,
        currentName: "a-fairly-long-original-filename.xlsx",
        targetName: `2026-01_${client}_MonthlyTraining.xlsx`,
        targetPath: `2026/${client}/01-January/2026-01_${client}_MonthlyTraining.xlsx`,
        etag: '"{01234567-89AB-CDEF-0123-456789ABCDEF},1"',
        client,
      };
    }),
    excluded: [],
  };
}

describe("stored plan size", () => {
  it("refuses a plan whose serialized items exceed what one entity holds, naming the plan and the remedy", async () => {
    // Sized well past the cap so the assertion does not depend on the exact
    // serialized length of one item, which a field rename would change.
    const store = createTableStateStore(fakeClients());
    const plan = planWithItems(300);

    await expect(store.savePlan("example", plan)).rejects.toBeInstanceOf(PlanTooLargeError);
    await expect(store.savePlan("example", plan)).rejects.toThrow(/naming fewer clients/);
  });

  it("accepts a plan comfortably inside the cap", async () => {
    const store = createTableStateStore(fakeClients());
    const plan = planWithItems(5);

    await store.savePlan("example", plan);
    await expect(store.getPlan("example", plan.planId)).resolves.toEqual(plan);
  });

  it("states the cap as a number the message and the constant agree on", () => {
    expect(new PlanTooLargeError("p1", 99999).message).toContain(String(MAX_PLAN_JSON_CHARS));
  });
});

describe("malformed stored plan entities", () => {
  // A row this codebase's own savePlan would never write: assembled directly
  // through the fake client's upsertEntity, the same way a hand-edited row or
  // a row from an older schema would arrive. getPlan must refuse each of
  // these rather than reconstruct a plan around the gap, per
  // MalformedPlanEntityError's own reasoning.
  const planId = "rnm-2026-09-18-a1b2";

  function validEntity(): TableEntityLike {
    return {
      partitionKey: "example",
      rowKey: encodeRowKey(planId),
      planId,
      profileId: "example",
      kind: "rename",
      driveId: "d1",
      createdAt: "2026-09-18T12:00:00Z",
      items: "[]",
      excluded: "[]",
    };
  }

  it("refuses a plan whose items field is absent", async () => {
    const plans = new FakeTableClient();
    const entity = validEntity();
    delete entity.items;
    await plans.upsertEntity(entity);
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory: new FakeTableClient(), plans });

    await expect(store.getPlan("example", planId)).rejects.toBeInstanceOf(MalformedPlanEntityError);
    await expect(store.getPlan("example", planId)).rejects.toThrow(/items/);
  });

  it("refuses a plan whose items field is not valid JSON", async () => {
    const plans = new FakeTableClient();
    await plans.upsertEntity({ ...validEntity(), items: "not json{" });
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory: new FakeTableClient(), plans });

    await expect(store.getPlan("example", planId)).rejects.toBeInstanceOf(MalformedPlanEntityError);
    await expect(store.getPlan("example", planId)).rejects.toThrow(/items/);
  });

  it("refuses a plan whose items field parses to something that is not an array", async () => {
    const plans = new FakeTableClient();
    await plans.upsertEntity({ ...validEntity(), items: "{}" });
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory: new FakeTableClient(), plans });

    await expect(store.getPlan("example", planId)).rejects.toBeInstanceOf(MalformedPlanEntityError);
    await expect(store.getPlan("example", planId)).rejects.toThrow(/items/);
  });

  it("refuses a plan whose driveId field is absent", async () => {
    const plans = new FakeTableClient();
    const entity = validEntity();
    delete entity.driveId;
    await plans.upsertEntity(entity);
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory: new FakeTableClient(), plans });

    await expect(store.getPlan("example", planId)).rejects.toBeInstanceOf(MalformedPlanEntityError);
    await expect(store.getPlan("example", planId)).rejects.toThrow(/driveId/);
  });

  it("refuses a plan whose kind field is present but not \"rename\"", async () => {
    const plans = new FakeTableClient();
    await plans.upsertEntity({ ...validEntity(), kind: "reversal" });
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory: new FakeTableClient(), plans });

    await expect(store.getPlan("example", planId)).rejects.toBeInstanceOf(MalformedPlanEntityError);
    await expect(store.getPlan("example", planId)).rejects.toThrow(/kind/);
  });
});
