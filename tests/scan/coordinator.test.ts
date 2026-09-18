import { describe, expect, it } from "vitest";
import { createScanCoordinator } from "../../src/scan/coordinator.js";
import type { ScanResult } from "../../src/scan/run.js";
import type { GraphClient } from "../../src/graph/client.js";
import type { StateStore } from "../../src/store/types.js";
import type { Profile } from "../../src/domain/profile/schema.js";

const PROFILE = { profileId: "example" } as unknown as Profile;
const OTHER = { profileId: "other" } as unknown as Profile;

function scanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    snapshot: { files: [], folderPaths: [], scannedAt: "2026-09-14T00:00:00Z", searchCrossCheckIncluded: false },
    driveId: "drive-1",
    mode: "incremental",
    resynced: false,
    pages: 1,
    changesApplied: 0,
    graphRequests: 3,
    storeBatches: 0,
    unfilteredFileCount: 0,
    unfilteredFolderCount: 0,
    ...overrides,
  };
}

// Neither is ever called: every test injects `scan`. They exist because the
// coordinator's options are typed and a cast at each call site would hide a
// signature change instead of failing on it.
const client = {} as GraphClient;
const store = {} as StateStore;

describe("createScanCoordinator", () => {
  it("runs one scan for two concurrent calls and tells the joiner it joined", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async () => {
        started += 1;
        await gate;
        return scanResult();
      },
    });

    const first = coordinator.run(PROFILE);
    const second = coordinator.run(PROFILE);
    release?.();
    const [a, b] = await Promise.all([first, second]);

    expect(started).toBe(1);
    expect(a.joined).toBe(false);
    expect(b.joined).toBe(true);
    expect(b.result).toBe(a.result);
  });

  it("scans again for a call that arrives after the first finished, because this is not a cache", async () => {
    let started = 0;
    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async () => {
        started += 1;
        return scanResult();
      },
    });

    await coordinator.run(PROFILE);
    const second = await coordinator.run(PROFILE);

    expect(started).toBe(2);
    expect(second.joined).toBe(false);
  });

  it("does not make a call for one profile wait on a scan of another", async () => {
    const profilesScanned: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async (dependencies) => {
        profilesScanned.push(dependencies.profile.profileId);
        if (dependencies.profile.profileId === "example") await gate;
        return scanResult();
      },
    });

    const blocked = coordinator.run(PROFILE);
    const other = await coordinator.run(OTHER);
    release?.();
    await blocked;

    expect(other.joined).toBe(false);
    expect(profilesScanned).toEqual(["example", "other"]);
  });

  it("settles immediately, reporting nothing awaited, when no scan is in flight", async () => {
    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async () => scanResult(),
    });

    expect(await coordinator.settle(PROFILE)).toEqual({ awaited: false, failed: false });
  });

  it("settle does not return until the scan it waited for has finished its own work", async () => {
    // A `settle` that resolved on the same turn the scan did, rather than
    // after it, would let a reader see the inventory mid-rebuild and still
    // report awaited: true. The flag is set by the scan's last statement, so
    // reading it after settle is what proves the wait covered the whole scan.
    let scanFinished = false;
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
        scanFinished = true;
        return scanResult();
      },
    });

    const scanning = coordinator.run(PROFILE);
    const settling = coordinator.settle(PROFILE);
    expect(scanFinished).toBe(false);

    release?.();
    const settled = await settling;
    await scanning;

    expect(settled).toEqual({ awaited: true, failed: false });
    expect(scanFinished).toBe(true);
  });

  it("does not make a settle for one profile wait on a scan of another", async () => {
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
        return scanResult();
      },
    });

    const scanning = coordinator.run(PROFILE);
    const settled = await coordinator.settle(OTHER);
    release?.();
    await scanning;

    expect(settled).toEqual({ awaited: false, failed: false });
  });

  it("counts the scans it started per profile, and does not count a joiner as one of them", async () => {
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
        return scanResult();
      },
    });

    expect(coordinator.scansStarted(PROFILE)).toBe(0);

    const first = coordinator.run(PROFILE);
    const joiner = coordinator.run(PROFILE);
    expect(coordinator.scansStarted(PROFILE)).toBe(1);

    release?.();
    await Promise.all([first, joiner]);

    // The counter is monotonic rather than a gauge of what is running now: a
    // reader comparing two readings across its own store reads has to see a
    // scan that both started and finished between them, and a gauge would
    // read zero both times.
    expect(coordinator.scansStarted(PROFILE)).toBe(1);
    expect(coordinator.scansStarted(OTHER)).toBe(0);

    await coordinator.run(PROFILE);
    expect(coordinator.scansStarted(PROFILE)).toBe(2);
  });

  it("passes the profile and the injected dependencies straight through to the scan", async () => {
    let seen: { profileId: string; hasClient: boolean; hasStore: boolean } | undefined;
    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async (dependencies) => {
        seen = {
          profileId: dependencies.profile.profileId,
          hasClient: dependencies.client === client,
          hasStore: dependencies.store === store,
        };
        return scanResult();
      },
    });

    await coordinator.run(PROFILE);

    expect(seen).toEqual({ profileId: "example", hasClient: true, hasStore: true });
  });
});
