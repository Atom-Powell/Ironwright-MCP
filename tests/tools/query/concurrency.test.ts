import { describe, expect, it } from "vitest";
import { runQueryRepository } from "../../../src/tools/query/run.js";
import { createScanCoordinator, type ScanCoordinator } from "../../../src/scan/coordinator.js";
import { createMemoryStateStore } from "../../../src/store/memory.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import type { GraphClient } from "../../../src/graph/client.js";
import type { Profile } from "../../../src/domain/profile/schema.js";
import type { ScanResult } from "../../../src/scan/run.js";
import type { InventoryRecord, StateStore } from "../../../src/store/types.js";
import type { ToolContext } from "../../../src/tools/context.js";

const PROFILE_ID = "example";
const DRIVE_ID = "drive-1";
const SCANNED_AT = "2026-09-17T00:00:00.000Z";

/**
 * One populated year folder over three empty client folders, so
 * `empty_folders` has exactly three findings to report and a torn read has a
 * visibly different answer rather than a subtly different one. A cleared
 * inventory answers zero, and zero is also what a genuinely tidy library
 * answers, which is the whole reason a torn read is dangerous here.
 */
const RECORDS: InventoryRecord[] = [
  { itemId: "1", path: "2026", name: "2026", isFolder: true, size: 0, modified: SCANNED_AT, etag: "a" },
  { itemId: "2", path: "2026/CLIENTA", name: "CLIENTA", isFolder: true, size: 0, modified: SCANNED_AT, etag: "b" },
  { itemId: "3", path: "2026/CLIENTB", name: "CLIENTB", isFolder: true, size: 0, modified: SCANNED_AT, etag: "c" },
  { itemId: "4", path: "2026/CLIENTC", name: "CLIENTC", isFolder: true, size: 0, modified: SCANNED_AT, etag: "d" },
];

const EMPTY_CLIENT_FOLDERS = ["2026/CLIENTA", "2026/CLIENTB", "2026/CLIENTC"];

async function fill(store: StateStore): Promise<void> {
  await store.applyInventoryChanges(
    PROFILE_ID,
    DRIVE_ID,
    RECORDS.map((record) => ({ kind: "upsert" as const, record })),
  );
}

/** What `setDeltaLink` leaves behind, which is what `getScannedDrives` reads. */
async function markScanned(store: StateStore): Promise<void> {
  await store.setDeltaLink(PROFILE_ID, DRIVE_ID, "delta-link", SCANNED_AT);
}

function scanResult(): ScanResult {
  return {
    snapshot: { files: [], folderPaths: [], scannedAt: SCANNED_AT, searchCrossCheckIncluded: false },
    driveId: DRIVE_ID,
    mode: "full",
    resynced: true,
    pages: 1,
    changesApplied: RECORDS.length,
    graphRequests: 4,
    storeBatches: 1,
    unfilteredFileCount: 0,
    unfilteredFolderCount: RECORDS.length,
  };
}

function findingPaths(result: { structuredContent?: unknown }): string[] {
  const structured = result.structuredContent as { findings: Array<{ path: string }> } | undefined;
  return (structured?.findings ?? []).map((finding) => finding.path);
}

function textOf(result: { content?: unknown }): string {
  return JSON.stringify(result.content);
}

/**
 * These tests drive the real coordinator and the real in-memory store against
 * the real handler, and each one arranges an actual interleaving rather than
 * asserting that one was handled. The scan fake does what `runScan` does on a
 * delta resync, in the same order: `clearInventory` first, re-enumeration
 * second, and the new `lastScanAt` only at the end. That order is the whole
 * hazard. While it is in progress the deltaLinks row still carries the
 * PREVIOUS scan's timestamp, so a reader that answers from the store inside
 * the window under-reports every question and stamps the under-report with a
 * freshness the evidence no longer has.
 *
 * Each test records what the store actually held at the moment the handler
 * reached the store, so a pass means the race was live and survived rather
 * than that the timing happened not to line up. A test that cannot observe the
 * race must not claim to guard it.
 */
describe("query_repository against a concurrent scan", () => {
  it("waits for an in-flight resync and answers from the rebuilt inventory, not the cleared one", async () => {
    const store = createMemoryStateStore();
    await fill(store);
    await markScanned(store);

    const observed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const real = createScanCoordinator({
      client: {} as GraphClient,
      store,
      now: () => new Date(SCANNED_AT),
      scan: async () => {
        await store.clearInventory(PROFILE_ID, DRIVE_ID);
        await gate;
        await fill(store);
        return scanResult();
      },
    });

    // The gate is released from inside `settle` rather than on a timer, so the
    // scan resumes only once the handler has actually reached the join. A
    // timer would let the scan finish first on a slow machine and the test
    // would pass having observed nothing.
    const coordinator: ScanCoordinator = {
      run: (profile) => real.run(profile),
      settle: async (profile) => {
        const stored = await store.listInventory(PROFILE_ID, DRIVE_ID);
        observed.push(`handler reached the join with ${stored.length} records stored`);
        release();
        return real.settle(profile);
      },
      scansStarted: (profile) => real.scansStarted(profile),
    };

    const base = createFakeToolContext();
    const profile: Profile = base.profiles.get(PROFILE_ID);
    const context: ToolContext = { ...base, store, scans: coordinator };

    const scanning = coordinator.run(profile);
    const result = await runQueryRepository({ profileId: PROFILE_ID, question: "empty_folders" }, context);
    // Idempotent, and only ever reached on a handler that did not join, which
    // is the regression this test exists for. Without it that handler leaves
    // the scan parked forever and this test reports a five-second timeout
    // instead of the assertion it actually failed.
    release();
    await scanning;

    // The inventory really was empty when the handler arrived. Without this,
    // the assertion below would pass just as well on a run where the scan had
    // already finished, and would guard nothing.
    expect(observed).toEqual(["handler reached the join with 0 records stored"]);
    expect(result.isError).toBeFalsy();
    expect(findingPaths(result)).toEqual(EMPTY_CLIENT_FOLDERS);
  });

  it("refuses to answer when a scan starts while it is reading the store", async () => {
    const store = createMemoryStateStore();
    await fill(store);
    await markScanned(store);

    const real = createScanCoordinator({
      client: {} as GraphClient,
      store,
      now: () => new Date(SCANNED_AT),
      scan: async () => {
        await store.clearInventory(PROFILE_ID, DRIVE_ID);
        await fill(store);
        return scanResult();
      },
    });

    const base = createFakeToolContext();
    const profile: Profile = base.profiles.get(PROFILE_ID);

    // The scan is started from inside `listInventory`, which is the window
    // `settle` cannot close by waiting: there was nothing in flight when the
    // handler joined. This is the interleaving itself and not a stand-in for
    // it, so what the assertions below prove is that the handler noticed.
    let scanning: Promise<unknown> | undefined;
    const racing: StateStore = {
      ...store,
      async listInventory(profileId, driveId) {
        scanning ??= real.run(profile);
        return store.listInventory(profileId, driveId);
      },
    };

    const context: ToolContext = { ...base, store: racing, scans: real };

    const result = await runQueryRepository({ profileId: PROFILE_ID, question: "empty_folders" }, context);
    await scanning;

    expect(scanning).toBeDefined();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toContain("started while this call was reading the stored inventory");
  });

  it("answers normally through the same store wrapper when no scan starts during the read", async () => {
    // The control for the test above. Without it, a refusal caused by the
    // wrapper itself rather than by the interleaving would read as a pass.
    const store = createMemoryStateStore();
    await fill(store);
    await markScanned(store);

    const real = createScanCoordinator({
      client: {} as GraphClient,
      store,
      now: () => new Date(SCANNED_AT),
      scan: () => Promise.reject(new Error("no scan should start in this test")),
    });

    const base = createFakeToolContext();
    const quiet: StateStore = {
      ...store,
      async listInventory(profileId, driveId) {
        return store.listInventory(profileId, driveId);
      },
    };
    const context: ToolContext = { ...base, store: quiet, scans: real };

    const result = await runQueryRepository({ profileId: PROFILE_ID, question: "empty_folders" }, context);

    expect(result.isError).toBeFalsy();
    expect(findingPaths(result)).toEqual(EMPTY_CLIENT_FOLDERS);
  });

  it("refuses to answer when the scan it waited for failed, rather than reporting the cleared inventory as the library", async () => {
    const store = createMemoryStateStore();
    await fill(store);
    await markScanned(store);

    const observed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const real = createScanCoordinator({
      client: {} as GraphClient,
      store,
      now: () => new Date(SCANNED_AT),
      scan: async () => {
        await store.clearInventory(PROFILE_ID, DRIVE_ID);
        await gate;
        throw new Error("the delta enumeration failed after the resync cleared the inventory");
      },
    });

    const coordinator: ScanCoordinator = {
      run: (profile) => real.run(profile),
      settle: async (profile) => {
        const stored = await store.listInventory(PROFILE_ID, DRIVE_ID);
        observed.push(`handler reached the join with ${stored.length} records stored`);
        release();
        return real.settle(profile);
      },
      scansStarted: (profile) => real.scansStarted(profile),
    };

    const base = createFakeToolContext();
    const profile: Profile = base.profiles.get(PROFILE_ID);
    const context: ToolContext = { ...base, store, scans: coordinator };

    const scanning = coordinator.run(profile);
    const result = await runQueryRepository({ profileId: PROFILE_ID, question: "empty_folders" }, context);
    // Idempotent, and reached only by a handler that did not join. See the
    // first test for why this is here rather than left to the gate.
    release();
    await expect(scanning).rejects.toThrow("the delta enumeration failed");

    expect(observed).toEqual(["handler reached the join with 0 records stored"]);
    // The store is genuinely still empty here, which is exactly why answering
    // would be wrong: zero empty folders is also what a clean library reports.
    expect(await store.listInventory(PROFILE_ID, DRIVE_ID)).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toContain("was already running when this call started, and it failed");
  });
});
