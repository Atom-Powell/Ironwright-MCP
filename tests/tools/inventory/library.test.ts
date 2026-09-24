import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runInventoryTree } from "../../../src/tools/inventory/run.js";
import { createFakeToolContext, scanCoordinatorStub } from "../../tools/fake-context.js";
import { createProfileRegistry } from "../../../src/profiles/registry.js";
import type { ScanResult } from "../../../src/scan/run.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";

const EXAMPLE_PROFILE = JSON.parse(readFileSync("examples/profiles/example.json", "utf8"));
const LIBRARY_PROFILE = JSON.parse(readFileSync("examples/profiles/library-example.json", "utf8"));

/**
 * Mirrors run.test.ts's own contextWith helper: a scan coordinator stub that
 * hands back a fixed ScanResult, over a registry carrying both the compliance
 * example profile and the library-only "shared-docs" profile from Task 1, so
 * this suite proves the tool works over a library profile without losing the
 * compliance profile's own coverage.
 */
function libraryContext(scan?: Partial<ScanResult>, joined = false) {
  const result: ScanResult = {
    snapshot: {
      files: [
        { path: "Reports/notes.docx", name: "notes.docx", size: 12, modified: "2026-09-01T00:00:00.000Z", etag: "a" },
      ],
      folderPaths: ["Reports"],
      scannedAt: "2026-09-17T00:00:00.000Z",
      searchCrossCheckIncluded: false,
    },
    driveId: "drive-1",
    mode: "incremental",
    resynced: false,
    pages: 1,
    changesApplied: 0,
    graphRequests: 4,
    storeBatches: 0,
    unfilteredFileCount: 1,
    unfilteredFolderCount: 1,
    ...scan,
  };

  return createFakeToolContext({
    profiles: createProfileRegistry(
      [
        { source: "example.json", contents: EXAMPLE_PROFILE },
        { source: "library-example.json", contents: LIBRARY_PROFILE },
      ],
      SITE,
    ),
    scans: scanCoordinatorStub(async () => ({ result, joined })),
  });
}

describe("runInventoryTree over a library-only profile", () => {
  it("returns a structured inventory listing the fixture's files", async () => {
    const result = await runInventoryTree({ profileId: "shared-docs" }, libraryContext());

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { profileId: string; items: Array<{ path: string; kind: string }> };
    expect(structured.profileId).toBe("shared-docs");
    expect(structured.items.map((item) => item.path)).toContain("Reports/notes.docx");
    expect(structured.items.map((item) => item.path)).toContain("Reports");
  });
});
