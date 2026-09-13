import { describe, expect, it } from "vitest";
import { createTableStateStore } from "../../src/store/table.js";
import { FakeTableClient } from "./fake-table-client.js";

describe("Azure Table state store failures", () => {
  it("lets a failed transaction surface rather than reporting a write that did not happen", async () => {
    const inventory = new FakeTableClient();
    inventory.submitTransaction = async () => {
      throw new Error("the service is unavailable");
    };
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory });

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
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory });

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
});
