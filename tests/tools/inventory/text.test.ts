import { describe, expect, it } from "vitest";
import { inventoryText } from "../../../src/tools/inventory/text.js";
import type { InventoryToolOutput } from "../../../src/tools/inventory/output.js";

// Every figure below is distinct from every other. If a sentence's formatter
// ever swapped which value fills which slot, for example handing `cap` where
// `returned` belongs, two equal fixture values would let that swap through
// unnoticed because the rendered sentence would read the same either way.
// Distinct values are what makes a transposition fail a test.
const truncated: InventoryToolOutput = {
  profileId: "example",
  library: "Documents",
  subPath: "2026/CLIENTA",
  scannedAt: "2026-09-17T00:00:00.000Z",
  totals: { files: 900, folders: 133, bytes: 204800 },
  items: [],
  listing: { returned: 487, omitted: 520, cap: 490, truncated: true },
  graphRequests: 7,
};

describe("inventoryText", () => {
  it("names the profile, the library, and the sub-path, in one sentence", () => {
    const lines = inventoryText(truncated);

    expect(lines[0]).toBe(
      'Profile "example", library "Documents", narrowed to subPath "2026/CLIENTA", scanned at 2026-09-17T00:00:00.000Z.',
    );
  });

  it("states the exact totals, including bytes, as one sentence", () => {
    const lines = inventoryText(truncated);

    expect(lines[1]).toBe(
      "Contains 900 files and 133 folders, totaling 204800 bytes. " +
        "These totals cover everything in scope, whether or not the listing below was cut.",
    );
  });

  it("states the truncation sentence with the returned count, the omitted count, and the cap each in their own place", () => {
    const lines = inventoryText(truncated);

    expect(lines[2]).toBe(
      "Listing 487 items of that total; 520 more were left out to keep this response bounded at 490. " +
        "Narrow the call with subPath to see the rest.",
    );
  });

  it("states the Graph cost this call paid as its own sentence", () => {
    const lines = inventoryText(truncated);

    expect(lines[3]).toBe("This call cost 7 Graph requests.");
  });

  it("uses the singular for a single Graph request", () => {
    const single: InventoryToolOutput = { ...truncated, graphRequests: 1 };
    expect(inventoryText(single)[3]).toBe("This call cost 1 Graph request.");
  });

  it("states the non-truncated listing sentence on its own wording, not merely without the truncated one's word", () => {
    const whole: InventoryToolOutput = {
      ...truncated,
      listing: { returned: 42, omitted: 0, cap: 490, truncated: false },
    };
    const lines = inventoryText(whole);

    expect(lines[2]).toBe("Listing every item counted above, 42 in all.");
    expect(lines[2]).not.toContain("omitted");
    expect(lines[2]).not.toContain("left out");
  });

  it("names the library alone and drops the sub-path clause when none was given", () => {
    const wholeLibrary: InventoryToolOutput = {
      ...truncated,
      subPath: undefined,
    };
    const lines = inventoryText(wholeLibrary);

    expect(lines[0]).toBe('Profile "example", library "Documents", scanned at 2026-09-17T00:00:00.000Z.');
    expect(lines[0]).not.toContain("subPath");
  });
});
