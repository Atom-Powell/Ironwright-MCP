import { describe, expect, it } from "vitest";
import { createScanCoordinator } from "../../src/scan/coordinator.js";
import type { ScanResult } from "../../src/scan/run.js";
import type { GraphClient } from "../../src/graph/client.js";
import type { StateStore } from "../../src/store/types.js";
import type { Profile } from "../../src/domain/profile/schema.js";

const PROFILE = { profileId: "example" } as unknown as Profile;
const client = {} as GraphClient;
const store = {} as StateStore;

function scanResult(): ScanResult {
  return {
    snapshot: { files: [], folderPaths: [], scannedAt: "2026-09-14T00:00:00Z", searchCrossCheckIncluded: false },
    driveId: "drive-1",
    mode: "full",
    resynced: false,
    pages: 1,
    changesApplied: 0,
    graphRequests: 5,
    storeBatches: 0,
    unfilteredFileCount: 0,
    unfilteredFolderCount: 0,
  };
}

describe("createScanCoordinator failures", () => {
  it("fails both calls when the scan they share fails", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async () => {
        await gate;
        throw new Error("delta enumeration failed");
      },
    });

    const first = coordinator.run(PROFILE);
    const second = coordinator.run(PROFILE);
    release?.();

    await expect(first).rejects.toThrow("delta enumeration failed");
    await expect(second).rejects.toThrow("delta enumeration failed");
  });

  it("settle reports a failed scan rather than rejecting, so the waiter can refuse on its own terms", async () => {
    // The failure belongs to the call that started the scan. A waiter reading
    // the store needs only one fact out of it, that what it is about to read
    // may be a half-cleared inventory, and rethrowing here would hand it
    // someone else's Graph error to describe as its own.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async () => {
        await gate;
        throw new Error("delta enumeration failed");
      },
    });

    const scanning = coordinator.run(PROFILE);
    const settling = coordinator.settle(PROFILE);
    release?.();

    await expect(scanning).rejects.toThrow("delta enumeration failed");
    await expect(settling).resolves.toEqual({ awaited: true, failed: true });
  });

  it("settle after a failed scan has already been cleared reports nothing in flight", async () => {
    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: () => Promise.reject(new Error("first scan failed")),
    });

    await expect(coordinator.run(PROFILE)).rejects.toThrow("first scan failed");

    expect(await coordinator.settle(PROFILE)).toEqual({ awaited: false, failed: false });
  });

  it("does not poison the key: a call after a failed scan scans again and can succeed", async () => {
    let attempt = 0;
    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("first scan failed");
        return scanResult();
      },
    });

    await expect(coordinator.run(PROFILE)).rejects.toThrow("first scan failed");
    const second = await coordinator.run(PROFILE);

    expect(second.joined).toBe(false);
    expect(second.result.graphRequests).toBe(5);
  });
});
