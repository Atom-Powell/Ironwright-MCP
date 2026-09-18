import { readFileSync } from "node:fs";
import { createProfileRegistry } from "../../src/profiles/registry.js";
import { createMemoryStateStore } from "../../src/store/memory.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { GraphClient } from "../../src/graph/client.js";
import type { ScanCoordinator } from "../../src/scan/coordinator.js";
import type { InventoryRecord, ScannedDrive, StateStore } from "../../src/store/types.js";

/**
 * A context whose dependencies do nothing useful, for suites that exercise the
 * wiring rather than the work. The Graph client and the scan coordinator reject
 * rather than returning plausible empty data, so a test that accidentally
 * depends on one fails loudly instead of asserting against a fabricated result.
 * An empty file list is the single most dangerous fake this project could hold,
 * because it is also what a correct scan of an empty library returns, and a
 * report built on it would name every expected file as missing while looking
 * entirely well formed.
 */
export function createFakeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  // A real counter rather than a hardcoded zero: a test that asserts "no Graph
  // request happened" by reading this count must be able to fail, and a
  // constant can't. Each method increments before it rejects, so a caller
  // that reaches any of the three still gets charged for it even though the
  // call never completes.
  let requestCount = 0;

  const graph: GraphClient = {
    get: () => {
      requestCount += 1;
      return Promise.reject(new Error("the fake Graph client was called"));
    },
    post: () => {
      requestCount += 1;
      return Promise.reject(new Error("the fake Graph client was called"));
    },
    getBytes: () => {
      requestCount += 1;
      return Promise.reject(new Error("the fake Graph client was called"));
    },
    requests: () => requestCount,
  };

  const scans: ScanCoordinator = {
    run: () => Promise.reject(new Error("the fake scan coordinator was called")),
  };

  return {
    profiles: createProfileRegistry([
      {
        source: "example.json",
        contents: JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
      },
    ]),
    graph,
    store: createMemoryStateStore(),
    scans,
    now: () => new Date("2026-09-14T12:00:00Z"),
    ...overrides,
  };
}

export interface FakeQueryContextOptions {
  /** Empty means the profile has never been scanned, per `getScannedDrives`'s own contract. */
  scannedDrives?: ScannedDrive[];
  /** Records returned by `listInventory` for whichever drive `query_repository` chooses. */
  inventory?: InventoryRecord[];
}

/**
 * A context for `query_repository`'s own tests, built on `createFakeToolContext`
 * rather than duplicating its Graph and scan fakes. `getScannedDrives` answers
 * from a fixed list instead of the real memory store's delta-link bookkeeping,
 * and `listInventory` records which drive it was asked for on `lastListedDrive`,
 * so a test can prove the tool chose the drive the store reported rather than
 * one it worked out itself.
 */
export function makeFakeContext(options: FakeQueryContextOptions = {}): ToolContext & { store: StateStore & { lastListedDrive?: string } } {
  const scannedDrives = options.scannedDrives ?? [];
  const inventory = options.inventory ?? [];
  const base = createFakeToolContext();

  const store: StateStore & { lastListedDrive?: string } = {
    ...base.store,
    lastListedDrive: undefined,
    async getScannedDrives() {
      return scannedDrives;
    },
    async listInventory(_profileId: string, driveId: string) {
      store.lastListedDrive = driveId;
      return inventory;
    },
  };

  return { ...base, store };
}
