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

  it("names whatever the item does carry when it has no id", () => {
    const call = () =>
      changesFromDeltaItems([{ name: "orphan.xlsx", parentReference: { path: "/drives/d1/root:/2026" }, file: {} }]);

    expect(call).toThrow(/orphan\.xlsx/);
    expect(call).toThrow(/\/drives\/d1\/root:\/2026/);
  });
});
