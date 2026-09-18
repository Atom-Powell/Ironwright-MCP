import { describe, expect, it } from "vitest";
import { createMemoryStateStore } from "../../src/store/memory.js";
import { UnsafeKeyError } from "../../src/store/keys.js";
import { stateStoreConformance } from "./conformance.js";

describe("in-memory state store", () => {
  stateStoreConformance(() => createMemoryStateStore());
});

describe("in-memory state store safety", () => {
  it("refuses a profile id carrying a character Azure Table forbids, the same as every sibling method", async () => {
    const store = createMemoryStateStore();
    // Every other method reaches this same rejection through inventoryPartitionKey,
    // so getScannedDrives must not be the one method that quietly answers with no
    // results for an id the rest of this store treats as unsafe.
    await expect(store.getScannedDrives("bad/id")).rejects.toThrow(UnsafeKeyError);
  });
});
