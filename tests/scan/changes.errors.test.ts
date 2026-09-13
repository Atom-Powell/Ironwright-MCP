import { describe, expect, it } from "vitest";
import { changesFromDeltaItems, DeltaItemError } from "../../src/scan/changes.js";

describe("changesFromDeltaItems failures", () => {
  it("refuses an item with no parentReference.path, naming the item id", () => {
    expect(() => changesFromDeltaItems([{ id: "i9", name: "a.xlsx", file: {} }])).toThrow(DeltaItemError);
    expect(() => changesFromDeltaItems([{ id: "i9", name: "a.xlsx", file: {} }])).toThrow(/i9/);
  });

  it("refuses an item with no id, since the inventory is keyed by it", () => {
    expect(() =>
      changesFromDeltaItems([{ name: "a.xlsx", parentReference: { path: "/drives/d1/root:" }, file: {} }]),
    ).toThrow(/no id/i);
  });

  it("refuses an item with no name rather than storing a path ending in undefined", () => {
    expect(() =>
      changesFromDeltaItems([{ id: "i9", parentReference: { path: "/drives/d1/root:" }, file: {} }]),
    ).toThrow(/no name/i);
  });
});
