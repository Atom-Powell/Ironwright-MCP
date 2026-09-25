import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runQueryRepository } from "../../../src/tools/query/run.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import { createProfileRegistry } from "../../../src/profiles/registry.js";
import type { InventoryRecord, ScannedDrive, StateStore } from "../../../src/store/types.js";
import type { ToolContext } from "../../../src/tools/context.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";

const EXAMPLE_PROFILE = JSON.parse(readFileSync("examples/profiles/example.json", "utf8"));
const LIBRARY_PROFILE = JSON.parse(readFileSync("examples/profiles/library-example.json", "utf8"));

const RECORDS: InventoryRecord[] = [
  { itemId: "1", path: "Reports", name: "Reports", isFolder: true, size: 0, modified: "2026-09-17T00:00:00.000Z", etag: "a" },
];

/**
 * Same registry as library.test.ts, with `listInventory` wrapped to count
 * calls: the two questions refused here must refuse before the store is ever
 * read, and a call count is the only way to prove that rather than merely
 * asserting the answer came back empty.
 */
function libraryContext(): { context: ToolContext; listInventoryCalls: () => number } {
  const base = createFakeToolContext({
    profiles: createProfileRegistry(
      [
        { source: "example.json", contents: EXAMPLE_PROFILE },
        { source: "library-example.json", contents: LIBRARY_PROFILE },
      ],
      SITE,
    ),
  });

  const scannedDrives: ScannedDrive[] = [{ driveId: "drive-1", lastScanAt: "2026-09-17T00:00:00.000Z" }];
  let listInventoryCalls = 0;
  const store: StateStore = {
    ...base.store,
    async getScannedDrives() {
      return scannedDrives;
    },
    async listInventory() {
      listInventoryCalls += 1;
      return RECORDS;
    },
  };

  return { context: { ...base, store }, listInventoryCalls: () => listInventoryCalls };
}

describe("runQueryRepository refuses a library-only profile for a question needing a naming standard", () => {
  it.each(["naming_violations", "recent_reports"] as const)(
    "refuses %s without reading the stored inventory",
    async (question) => {
      const { context, listInventoryCalls } = libraryContext();

      const result = await runQueryRepository({ profileId: "shared-docs", question }, context);

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain(question);
      expect(text).toContain("library-only");
      expect(listInventoryCalls()).toBe(0);
    },
  );
});
