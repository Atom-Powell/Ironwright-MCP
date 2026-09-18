import { describe, expect, it } from "vitest";
import { inventoryText } from "../../../src/tools/inventory/text.js";
import type { InventoryToolOutput } from "../../../src/tools/inventory/output.js";

const truncated: InventoryToolOutput = {
  profileId: "example",
  library: "Documents",
  subPath: "2026/CLIENTA",
  scannedAt: "2026-09-17T00:00:00.000Z",
  totals: { files: 900, folders: 120, bytes: 1024 },
  items: [],
  listing: { returned: 500, omitted: 520, cap: 500, truncated: true },
  graphRequests: 4,
};

describe("inventoryText", () => {
  it("reports the true totals and says what was left out", () => {
    const lines = inventoryText(truncated).join("\n");

    expect(lines).toContain("900 files");
    expect(lines).toContain("120 folders");
    expect(lines).toContain("520");
    expect(lines).toContain("subPath");
    expect(lines).toContain("2026/CLIENTA");
  });

  it("does not claim a complete listing when the listing was cut", () => {
    const lines = inventoryText(truncated).join("\n").toLowerCase();
    expect(lines).not.toContain("complete listing");
  });

  it("says nothing about truncation when nothing was truncated", () => {
    const whole: InventoryToolOutput = { ...truncated, listing: { returned: 20, omitted: 0, cap: 500, truncated: false } };
    expect(inventoryText(whole).join("\n")).not.toContain("omitted");
  });

  it("names the library and omits the sub-path clause when none was given", () => {
    const whole: InventoryToolOutput = {
      ...truncated,
      subPath: undefined,
      listing: { returned: 1020, omitted: 0, cap: 2000, truncated: false },
    };
    const lines = inventoryText(whole).join("\n");

    expect(lines).toContain('library "Documents"');
    expect(lines).not.toContain("subPath");
  });

  it("states the Graph cost this call paid", () => {
    const lines = inventoryText(truncated).join("\n");
    expect(lines).toContain("4 Graph requests");
  });

  it("uses the singular for a single Graph request", () => {
    const single: InventoryToolOutput = { ...truncated, graphRequests: 1 };
    expect(inventoryText(single).join("\n")).toContain("1 Graph request.");
  });
});
