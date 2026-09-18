import { readFileSync } from "node:fs";
import { createProfileRegistry } from "../../src/profiles/registry.js";
import { createMemoryStateStore } from "../../src/store/memory.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { GraphClient } from "../../src/graph/client.js";
import type { ScanCoordinator } from "../../src/scan/coordinator.js";
import type { InventoryRecord, ScannedDrive, StateStore } from "../../src/store/types.js";

/**
 * A `ScanCoordinator` whose `run` is whatever the caller supplies and whose
 * other two methods answer for a coordinator that has never started a scan.
 *
 * Those two answers are truthful rather than convenient. `settle` reports
 * nothing in flight because nothing this stub did put anything in flight, and
 * `scansStarted` reports zero for the same reason, so a caller that brackets
 * its store reads with the counter sees an unchanged count and is right to.
 * Rejecting from either, the way `run` does by default here, would make a
 * reader's honest check fail rather than pass truthfully.
 */
export function scanCoordinatorStub(run: ScanCoordinator["run"]): ScanCoordinator {
  return {
    run,
    settle: () => Promise.resolve({ awaited: false, failed: false }),
    scansStarted: () => 0,
  };
}

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

  const scans: ScanCoordinator = scanCoordinatorStub(() =>
    Promise.reject(new Error("the fake scan coordinator was called")),
  );

  return {
    profiles: createProfileRegistry(
      [
        {
          source: "example.json",
          contents: JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
        },
      ],
      "https://contoso.sharepoint.com/sites/Example",
    ),
    graph,
    store: createMemoryStateStore(),
    scans,
    now: () => new Date("2026-09-14T12:00:00Z"),
    grantedSiteUrl: "https://contoso.sharepoint.com/sites/Example",
    ...overrides,
  };
}

export interface FakeWorkbookGraphOptions {
  /** Defaults to matching createFakeToolContext's own example profile's site. */
  siteId?: string;
  library: string;
  driveId?: string;
  /**
   * Workbook bytes keyed by the exact library-relative workbookPath a call
   * names. Matched against the request URL by substring, which is enough
   * because driveItemPath only percent-encodes characters these fixture
   * paths never contain.
   */
  workbooksByPath: Record<string, Uint8Array>;
}

/**
 * A GraphClient that answers resolveDrive's site lookup and drive listing and
 * downloadDriveItem's content read, entirely from fixtures, rather than
 * injecting a bytes reader that bypasses Graph. describe_workbook reports the
 * Graph cost it paid, and this server's sharpest phase 2 review finding was a
 * cost assertion measured against a counter that could not move; every method
 * here increments the same counter requests() reports, the same way the real
 * client does, so that finding cannot recur for this tool.
 */
export function createFakeWorkbookGraphClient(options: FakeWorkbookGraphOptions): GraphClient {
  const driveId = options.driveId ?? "drive-1";
  const siteId = options.siteId ?? "site-1";
  let requestCount = 0;

  return {
    async get<T>(pathOrUrl: string): Promise<T> {
      requestCount += 1;
      if (pathOrUrl.includes("/drives")) {
        return { value: [{ id: driveId, name: options.library }] } as unknown as T;
      }
      return { id: siteId } as unknown as T;
    },
    post: () => {
      requestCount += 1;
      return Promise.reject(new Error("the fake workbook Graph client does not implement post"));
    },
    async getBytes(pathOrUrl: string): Promise<Uint8Array> {
      // Two, not one: the real client's getBytes issues a request to Graph,
      // which answers the content read with a 302, and a second request to
      // the redirect target to actually fetch the bytes (see sendForBytes in
      // src/graph/client.ts). A fake that only charged one made every
      // download-inclusive cost assertion in this suite one request short of
      // what a real tenant pays.
      requestCount += 2;
      const match = Object.entries(options.workbooksByPath).find(([path]) => pathOrUrl.includes(path));
      if (match === undefined) {
        throw new Error(`the fake workbook Graph client has no fixture bytes for ${pathOrUrl}`);
      }
      return match[1];
    },
    requests: () => requestCount,
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
