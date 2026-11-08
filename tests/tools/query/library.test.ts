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
const ASSESSMENT_PROFILE = JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8"));

const SCANNED_AT = "2026-09-17T00:00:00.000Z";

const RECORDS: InventoryRecord[] = [
  { itemId: "1", path: "Reports", name: "Reports", isFolder: true, size: 0, modified: SCANNED_AT, etag: "a" },
  { itemId: "2", path: "Reports/Empty", name: "Empty", isFolder: true, size: 0, modified: SCANNED_AT, etag: "b" },
];

/**
 * A query context over a registry carrying both the compliance example
 * profile and the library-only "shared-docs" profile, with the store fakes
 * makeFakeContext also uses, applied by hand because that helper does not
 * take a profiles override.
 */
function libraryContext(): ToolContext {
  const base = createFakeToolContext({
    profiles: createProfileRegistry(
      [
        { source: "example.json", contents: EXAMPLE_PROFILE },
        { source: "library-example.json", contents: LIBRARY_PROFILE },
        { source: "assessment-example.json", contents: ASSESSMENT_PROFILE },
      ],
      SITE,
    ),
  });

  const scannedDrives: ScannedDrive[] = [{ driveId: "drive-1", lastScanAt: SCANNED_AT }];
  const store: StateStore = {
    ...base.store,
    async getScannedDrives() {
      return scannedDrives;
    },
    async listInventory() {
      return RECORDS;
    },
  };

  return { ...base, store };
}

describe("runQueryRepository over a library-only profile", () => {
  it("answers empty_folders without error", async () => {
    const result = await runQueryRepository({ profileId: "shared-docs", question: "empty_folders" }, libraryContext());

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { findings: Array<{ path: string }> };
    expect(structured.findings.map((finding) => finding.path)).toEqual(["Reports/Empty"]);
  });
});

describe("runQueryRepository over an assessment profile", () => {
  it("answers empty_folders without error", async () => {
    const result = await runQueryRepository({ profileId: "vendor-assessments", question: "empty_folders" }, libraryContext());

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { findings: Array<{ path: string }> };
    expect(structured.findings.map((finding) => finding.path)).toEqual(["Reports/Empty"]);
  });
});
