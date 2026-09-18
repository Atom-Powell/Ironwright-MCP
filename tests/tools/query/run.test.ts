import { describe, expect, it } from "vitest";
import { runQueryRepository } from "../../../src/tools/query/run.js";
import { makeFakeContext } from "../fake-context.js";
import type { InventoryRecord } from "../../../src/store/types.js";

const RECORDS: InventoryRecord[] = [
  { itemId: "1", path: "2026", name: "2026", isFolder: true, size: 0, modified: "2026-09-01T00:00:00.000Z", etag: "a" },
  { itemId: "2", path: "2026/CLIENTA", name: "CLIENTA", isFolder: true, size: 0, modified: "2026-09-01T00:00:00.000Z", etag: "b" },
  { itemId: "3", path: "2026/CLIENTB", name: "CLIENTB", isFolder: true, size: 0, modified: "2026-09-01T00:00:00.000Z", etag: "c" },
  {
    itemId: "4",
    path: "2026/CLIENTB/2026-09_CLIENTB_MonthlyTraining.xlsx",
    name: "2026-09_CLIENTB_MonthlyTraining.xlsx",
    isFolder: false,
    size: 12,
    modified: "2026-09-10T00:00:00.000Z",
    etag: "d",
  },
  {
    itemId: "5",
    path: "2026/CLIENTB/not-a-real-name.xlsx",
    name: "not-a-real-name.xlsx",
    isFolder: false,
    size: 9,
    modified: "2026-09-11T00:00:00.000Z",
    etag: "e",
  },
];

describe("runQueryRepository", () => {
  it("fails rather than reporting zero findings when nothing has been scanned", async () => {
    const context = makeFakeContext({ scannedDrives: [] });

    const result = await runQueryRepository({ profileId: "example", question: "empty_folders" }, context);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("inventory_tree");
    expect(JSON.stringify(result.content)).toContain("reconcile_workbook_vs_repository");
  });

  it("issues no Graph request for any question", async () => {
    const context = makeFakeContext({
      scannedDrives: [{ driveId: "d1", lastScanAt: "2026-09-17T00:00:00.000Z" }],
      inventory: RECORDS,
    });

    for (const question of ["empty_folders", "naming_violations", "recent_reports"] as const) {
      const result = await runQueryRepository({ profileId: "example", question }, context);
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { graphRequests: number }).graphRequests).toBe(0);
    }

    expect(context.graph.requests()).toBe(0);
  });

  it("uses the most recently scanned drive when a profile has more than one", async () => {
    const context = makeFakeContext({
      scannedDrives: [
        { driveId: "old", lastScanAt: "2026-09-01T00:00:00.000Z" },
        { driveId: "new", lastScanAt: "2026-09-17T00:00:00.000Z" },
      ],
    });

    await runQueryRepository({ profileId: "example", question: "empty_folders" }, context);

    expect(context.store.lastListedDrive).toBe("new");
  });

  it("returns isError with the registry's own message for an unknown profile", async () => {
    const context = makeFakeContext({ scannedDrives: [{ driveId: "d1", lastScanAt: "2026-09-17T00:00:00.000Z" }] });

    const result = await runQueryRepository({ profileId: "no-such-profile", question: "empty_folders" }, context);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("no-such-profile");
  });

  it("answers empty_folders with a folder that holds no file or deeper folder", async () => {
    const context = makeFakeContext({
      scannedDrives: [{ driveId: "d1", lastScanAt: "2026-09-17T00:00:00.000Z" }],
      inventory: RECORDS,
    });

    const result = await runQueryRepository({ profileId: "example", question: "empty_folders" }, context);
    const structured = result.structuredContent as { findings: Array<{ path: string }> };

    expect(structured.findings.map((finding) => finding.path)).toEqual(["2026/CLIENTA"]);
  });

  it("answers naming_violations with the one file that does not parse, naming the template and the recognizer count", async () => {
    const context = makeFakeContext({
      scannedDrives: [{ driveId: "d1", lastScanAt: "2026-09-17T00:00:00.000Z" }],
      inventory: RECORDS,
    });

    const result = await runQueryRepository({ profileId: "example", question: "naming_violations" }, context);
    const structured = result.structuredContent as { findings: Array<{ path: string; detail: string }> };

    expect(structured.findings).toHaveLength(1);
    expect(structured.findings[0]?.path).toBe("2026/CLIENTB/not-a-real-name.xlsx");
    expect(structured.findings[0]?.detail).toContain("{year}-{month:02}_{client}_{deliverable}.xlsx");
    expect(structured.findings[0]?.detail).toContain("3 recognizers");
  });

  it("answers recent_reports with only the recognized file, naming its deliverable", async () => {
    const context = makeFakeContext({
      scannedDrives: [{ driveId: "d1", lastScanAt: "2026-09-17T00:00:00.000Z" }],
      inventory: RECORDS,
    });

    const result = await runQueryRepository({ profileId: "example", question: "recent_reports" }, context);
    const structured = result.structuredContent as { findings: Array<{ path: string; detail: string }> };

    expect(structured.findings).toHaveLength(1);
    expect(structured.findings[0]?.path).toBe("2026/CLIENTB/2026-09_CLIENTB_MonthlyTraining.xlsx");
    expect(structured.findings[0]?.detail).toBe("Parsed as the MonthlyTraining deliverable.");
  });

  it("treats a folder as occupied once a real inventory record lands under it", async () => {
    const context = makeFakeContext({
      scannedDrives: [{ driveId: "d1", lastScanAt: "2026-09-17T00:00:00.000Z" }],
      inventory: [
        ...RECORDS,
        {
          itemId: "6",
          path: "2026/CLIENTA/2026-09_CLIENTA_MonthlyTraining.xlsx",
          name: "2026-09_CLIENTA_MonthlyTraining.xlsx",
          isFolder: false,
          size: 5,
          modified: "2026-09-12T00:00:00.000Z",
          etag: "f",
        },
      ],
    });

    const result = await runQueryRepository({ profileId: "example", question: "empty_folders" }, context);
    const structured = result.structuredContent as { findings: Array<{ path: string }> };

    expect(structured.findings.map((finding) => finding.path)).toEqual([]);
  });
});
