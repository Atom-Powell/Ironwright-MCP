import { describe, expect, it } from "vitest";
import { chunk, decodeRowKey, encodeRowKey, inventoryPartitionKey, UnsafeKeyError } from "../../src/store/keys.js";

describe("encodeRowKey", () => {
  it.each([
    "01ABCDEF",
    "b!x-y_z",
    "has/slash",
    "has\\backslash",
    "has#hash",
    "has?question",
    "spaces and Ünicode",
  ])("round-trips %s through an alphabet Azure Table accepts", (itemId) => {
    const encoded = encodeRowKey(itemId);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRowKey(encoded)).toBe(itemId);
  });
});

describe("inventoryPartitionKey", () => {
  it("joins the profile id and drive id unambiguously", () => {
    expect(inventoryPartitionKey("example", "b!abc")).toBe("example|b!abc");
  });

  it("refuses a drive id carrying a character Azure Table forbids in a key", () => {
    expect(() => inventoryPartitionKey("example", "b!a/c")).toThrow(UnsafeKeyError);
  });
});

describe("chunk", () => {
  it("splits into full groups and a remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no groups for an empty list, so a no-op scan writes nothing", () => {
    expect(chunk([], 100)).toEqual([]);
  });
});
