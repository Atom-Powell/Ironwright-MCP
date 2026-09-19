import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RepositoryFile, RepositorySnapshot, WorkbookSnapshot } from "../../../src/domain/reconcile/index.js";
import { GraphRequestError } from "../../../src/graph/errors.js";
import type { GraphClient } from "../../../src/graph/client.js";
import type { ScanResult } from "../../../src/scan/run.js";
import type { ToolContext } from "../../../src/tools/context.js";
import type { StateStore, StoredPlan } from "../../../src/store/types.js";
import { createFakeToolContext, scanCoordinatorStub } from "../fake-context.js";

/**
 * Derived by hand from the example profile rather than computed, so a change to
 * that profile's taxonomy or template breaks these tests loudly instead of
 * letting them quietly agree with whatever the renderer now produces.
 *
 * The taxonomy is {year}/{client}/{month:02}-{monthName} and the template is
 * {year}-{month:02}_{client}_{deliverable}.xlsx, so September 2026 for ACME is
 * the folder and canonical name below. The misnamed name matches the profile's
 * own vendor-token recognizer, whose declared verdict is "misnamed"; that is
 * what makes the engine classify the file that way rather than as an
 * unrecognized orphan, and it is why an arbitrary wrong name would not work
 * here.
 */
export const FOLDER = "2026/ACME/09-September";
export const CANONICAL_NAME = "2026-09_ACME_MonthlyTraining.xlsx";
export const MISNAMED_NAME = "2026-09_ACME_VendorTraining.xlsx";
export const CANONICAL_PATH = `${FOLDER}/${CANONICAL_NAME}`;
export const MISNAMED_PATH = `${FOLDER}/${MISNAMED_NAME}`;
export const SCANNED_AT = "2026-09-14T09:00:00Z";

export function workbookFixture(clients: readonly string[] = ["ACME"]): WorkbookSnapshot {
  return {
    // monthlyTraining truthy is what makes the MonthlyTraining deliverable
    // apply; no effectiveFrom, so every month of the rolling window is owed.
    rows: clients.map((client) => ({ client, fields: { monthlyTraining: true } })),
    rejectedRows: [],
    source: "/Trackers/Operational Tracking Workbook.xlsx#ClientRoster",
  };
}

export function file(path: string, etag = "inventory-etag"): RepositoryFile {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), size: 1024, modified: SCANNED_AT, etag };
}

export function snapshot(files: RepositoryFile[], folderPaths: string[]): RepositorySnapshot {
  return { files, folderPaths, scannedAt: SCANNED_AT, searchCrossCheckIncluded: false };
}

/** One misnamed September file for ACME, and nothing else. */
export function snapshotWithMisnamedFile(): RepositorySnapshot {
  return snapshot([file(MISNAMED_PATH)], ["2026", "2026/ACME", FOLDER]);
}

export function misnamedPathFor(client: string): string {
  return `2026/${client}/09-September/2026-09_${client}_VendorTraining.xlsx`;
}

/** One misnamed September file for each named client. */
export function snapshotWithMisnamedFilePerClient(clients: readonly string[]): RepositorySnapshot {
  const folderPaths = new Set<string>(["2026"]);
  for (const client of clients) {
    folderPaths.add(`2026/${client}`);
    folderPaths.add(`2026/${client}/09-September`);
  }
  return snapshot(
    clients.map((client) => file(misnamedPathFor(client))),
    [...folderPaths],
  );
}

/** ACME's misnamed file alongside a file already sitting on its canonical path. */
export function snapshotWhereTargetIsOccupied(): RepositorySnapshot {
  return snapshot([file(MISNAMED_PATH), file(CANONICAL_PATH, "other-etag")], ["2026", "2026/ACME", FOLDER]);
}

export function canonicalPathFor(client: string): string {
  return `2026/${client}/09-September/2026-09_${client}_MonthlyTraining.xlsx`;
}

/**
 * One misnamed file for each of `candidateClients`, plus a misnamed file
 * alongside its own canonical-path occupant for each of `excludedClients`, so
 * one scenario produces a plan with both a large item list and a large
 * excluded list at once.
 */
export function snapshotForTruncation(
  candidateClients: readonly string[],
  excludedClients: readonly string[],
): RepositorySnapshot {
  const folderPaths = new Set<string>(["2026"]);
  const files: RepositoryFile[] = [];

  for (const client of candidateClients) {
    folderPaths.add(`2026/${client}`);
    folderPaths.add(`2026/${client}/09-September`);
    files.push(file(misnamedPathFor(client)));
  }
  for (const client of excludedClients) {
    folderPaths.add(`2026/${client}`);
    folderPaths.add(`2026/${client}/09-September`);
    files.push(file(misnamedPathFor(client)));
    files.push(file(canonicalPathFor(client), "occupant-etag"));
  }

  return snapshot(files, [...folderPaths]);
}

export function scanResultFor(snapshotValue: RepositorySnapshot, driveId = "drive-1"): ScanResult {
  return {
    snapshot: snapshotValue,
    driveId,
    mode: "incremental",
    resynced: false,
    pages: 1,
    changesApplied: 0,
    graphRequests: 3,
    storeBatches: 0,
    unfilteredFileCount: snapshotValue.files.length,
    unfilteredFolderCount: snapshotValue.folderPaths.length,
  };
}

export function contextWith(graph: GraphClient, snapshotValue: RepositorySnapshot): ToolContext {
  const result = scanResultFor(snapshotValue);
  return createFakeToolContext({
    graph,
    scans: scanCoordinatorStub(() => Promise.resolve({ result, joined: false })),
  });
}

export function textOf(result: CallToolResult): string {
  return result.content.map((entry) => ("text" in entry ? entry.text : "")).join("\n");
}

/**
 * The ways a Graph response can carry no usable etag. Three shapes rather than
 * one, because they are three different JavaScript values by the time a caller
 * sees them, and code that handles only the first throws on the other two:
 *
 * - `item_without_etag`: an object Graph returned that simply has no `eTag`.
 * - `empty_body`: `createGraphClient`'s `request()` returns `undefined as T`
 *   for a zero-length response body, and a 204 passes its success check, so
 *   this is what a PATCH answered with no body actually looks like.
 * - `null_body`: a body of the four characters `null`, which parses to `null`.
 *
 * Both fakes in this file used to express only the first, which is the shape
 * their author imagined rather than the shape the real client produces. The
 * code they exercised was written against that same imagined shape, so the two
 * agreed with each other while the real client crashed the caller.
 */
export type NoEtagShape = "item_without_etag" | "empty_body" | "null_body";

function bodyFor(shape: NoEtagShape): unknown {
  if (shape === "item_without_etag") return {};
  return shape === "null_body" ? null : undefined;
}

/** An etag string, a Graph status to fail with, or a response carrying no etag. */
export type EtagFixture = string | number | { readonly noEtag: NoEtagShape };

export function noEtag(shape: NoEtagShape): { readonly noEtag: NoEtagShape } {
  return { noEtag: shape };
}

function isNoEtag(value: EtagFixture): value is { readonly noEtag: NoEtagShape } {
  return typeof value === "object";
}

/**
 * Answers the plan-time etag lookups and nothing else. A path maps to an etag
 * string, to a `noEtag(...)` shape for a response Graph returns with no etag in
 * it, or to a number for a Graph status the lookup should fail with. A path
 * with no entry makes the fake throw, so a handler that reached for a call the
 * test did not intend fails loudly instead of receiving a plausible answer.
 *
 * Every method moves the same counter `requests()` reports, the way the real
 * client does. This project's sharpest phase 2 review finding was a cost
 * assertion measured against a counter that could not move.
 */
export function etagGraphClient(etagsByPath: Record<string, EtagFixture>): GraphClient & {
  lookups: string[];
} {
  let requestCount = 0;
  const lookups: string[] = [];
  // A mutable copy, not the caller's own object: a successful patch below
  // updates the recorded etag, the way a real rename invalidates the item's
  // old one, so a caller that reads a path again after patching it sees the
  // new value rather than the fixture it started with.
  const state = new Map<string, EtagFixture>(Object.entries(etagsByPath));

  function findMatch(pathOrUrl: string): [string, EtagFixture] | undefined {
    return [...state.entries()].find(([path]) =>
      pathOrUrl.includes(path.split("/").map(encodeURIComponent).join("/")),
    );
  }

  return {
    lookups,
    async get<T>(pathOrUrl: string): Promise<T> {
      requestCount += 1;
      const match = findMatch(pathOrUrl);
      if (match === undefined) throw new Error(`the fake etag client has no fixture for ${pathOrUrl}`);
      lookups.push(match[0]);
      if (typeof match[1] === "number") {
        throw new GraphRequestError({ method: "GET", path: pathOrUrl, status: match[1], body: "{}" });
      }
      return (isNoEtag(match[1]) ? bodyFor(match[1].noEtag) : { eTag: match[1] }) as T;
    },
    post: () => {
      requestCount += 1;
      return Promise.reject(new Error("the fake etag client does not implement post"));
    },
    /**
     * Working rather than rejecting, unlike the etag-lookup-only fake this was
     * copied from. This fixture is shared by both rename tool suites, and the
     * execute suite exercises a real rename against an If-Match precondition,
     * so a fake that only answered lookups would force that suite to build its
     * own second Graph fake for the same fixture data.
     */
    async patch<T>(pathOrUrl: string, body: unknown, headers?: Record<string, string>): Promise<T> {
      requestCount += 1;
      const match = findMatch(pathOrUrl);
      if (match === undefined) {
        throw new GraphRequestError({ method: "PATCH", path: pathOrUrl, status: 404, body: "{}" });
      }
      const [path, current] = match;
      if (typeof current === "number") {
        throw new GraphRequestError({ method: "PATCH", path: pathOrUrl, status: current, body: "{}" });
      }
      // A path whose fixture carries no etag has nothing an If-Match can match,
      // so any precondition sent for it is refused, exactly as one built on a
      // stale value would be.
      const currentEtag = typeof current === "string" ? current : undefined;
      const ifMatch = headers?.["if-match"];
      if (ifMatch !== undefined && currentEtag !== ifMatch) {
        throw new GraphRequestError({ method: "PATCH", path: pathOrUrl, status: 412, body: "{}" });
      }
      // A rename invalidates the old etag. Bumped deterministically rather
      // than randomized, so a test asserting the returned etag can predict it.
      const nextEtag = `${currentEtag ?? "no-etag"}-renamed`;
      state.set(path, nextEtag);
      return { eTag: nextEtag, name: (body as { name?: unknown }).name } as unknown as T;
    },
    getBytes: () => {
      requestCount += 2;
      return Promise.reject(new Error("the fake etag client does not implement getBytes"));
    },
    requests: () => requestCount,
  };
}

export const ITEM_A = {
  path: "2026/ACME/01-January/wrong-a.xlsx",
  currentName: "wrong-a.xlsx",
  targetName: "2026-01_ACME_MonthlyTraining.xlsx",
  targetPath: "2026/ACME/01-January/2026-01_ACME_MonthlyTraining.xlsx",
  etag: '"{GUID},1"',
  client: "ACME",
};

export const ITEM_B = {
  path: "2026/BETACO/01-January/wrong-b.xlsx",
  currentName: "wrong-b.xlsx",
  targetName: "2026-01_BETACO_MonthlyTraining.xlsx",
  targetPath: "2026/BETACO/01-January/2026-01_BETACO_MonthlyTraining.xlsx",
  etag: '"{GUID},2"',
  client: "BETACO",
};

export function planWith(items: StoredPlan["items"], excluded: StoredPlan["excluded"] = []): StoredPlan {
  return {
    planId: "rnm-2026-09-18-a1b2c3d4",
    profileId: "example",
    kind: "rename",
    driveId: "drive-1",
    createdAt: "2026-09-18T12:00:00Z",
    items,
    excluded,
  };
}

/**
 * `count` distinct rename items, one client each, well under the store's
 * character cap for a count in the tens. Exists so a test can put more items
 * in a plan than `MAX_PLAN_ITEMS_LISTED` shows without tripping
 * `MAX_PLAN_JSON_CHARS`, to prove a count is computed over the whole set
 * before the listing is cut rather than over the cut listing itself.
 */
export function manyRenameItems(count: number): StoredPlan["items"] {
  return Array.from({ length: count }, (_value, index) => {
    const client = `CLIENT${String(index).padStart(4, "0")}`;
    return {
      path: `2026/${client}/01-January/wrong.xlsx`,
      currentName: "wrong.xlsx",
      targetName: `2026-01_${client}_MonthlyTraining.xlsx`,
      targetPath: `2026/${client}/01-January/2026-01_${client}_MonthlyTraining.xlsx`,
      etag: `"{GUID},${String(index)}"`,
      client,
    };
  });
}

/**
 * Wraps a real `StateStore` so its `savePlan` throws on one specific call
 * number, counted from 1 across every call this store instance receives, and
 * behaves exactly like the wrapped store on every other call. Everything but
 * `savePlan` is passed straight through.
 *
 * Wrapping a real store rather than faking every method is what lets a test
 * exercise a persistence failure that happens after a rename has already
 * landed, while `getPlan` afterward still answers with whatever the last
 * successful `savePlan` actually persisted, `structuredClone` and all.
 */
export function storeWithFailingSavePlan(store: StateStore, failOnCall: number): StateStore {
  let calls = 0;
  return {
    ...store,
    async savePlan(profileId, plan) {
      calls += 1;
      if (calls === failOnCall) {
        throw new Error(`simulated failure: savePlan call ${String(calls)} was made to fail on purpose`);
      }
      return store.savePlan(profileId, plan);
    },
  };
}

export interface RenameCall {
  path: string;
  name: string;
  ifMatch: string | undefined;
}

export interface RenamingClientOptions {
  /** Library-relative path to the Graph status its PATCH answers with. Absent means success. */
  patchStatuses?: Record<string, number>;
  /**
   * What a successful PATCH answers with. Anything but "item" carries no etag
   * and forces the follow-up read, and which shape is chosen matters: the real
   * client hands back `undefined` for an empty body, not an empty object.
   */
  patchResponse?: "item" | NoEtagShape;
  /** What a follow-up etag read answers with, in the same three shapes. */
  etagLookupResponse?: "item" | NoEtagShape;
  /** A Graph status for the follow-up etag read, so the unrefreshable case can be exercised. */
  etagLookupStatus?: number;
}

/**
 * Applies renames into nothing at all: it records the calls and answers with a
 * fresh etag each time. That is enough, because what these tests assert is what
 * this server sent and what it recorded, never what SharePoint then held.
 * Proving the latter is the live sitting's job and no fake can stand in for it.
 *
 * Every method moves the same counter `requests()` reports, the way the real
 * client does.
 */
export function renamingGraphClient(options: RenamingClientOptions = {}): GraphClient & { calls: RenameCall[] } {
  const patchStatuses = options.patchStatuses ?? {};
  const patchResponse = options.patchResponse ?? "item";
  const etagLookupResponse = options.etagLookupResponse ?? "item";
  const calls: RenameCall[] = [];
  let requestCount = 0;
  let version = 100;

  function encoded(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  return {
    calls,
    async get<T>(pathOrUrl: string): Promise<T> {
      requestCount += 1;
      if (options.etagLookupStatus !== undefined) {
        throw new GraphRequestError({ method: "GET", path: pathOrUrl, status: options.etagLookupStatus, body: "{}" });
      }
      if (etagLookupResponse !== "item") return bodyFor(etagLookupResponse) as T;
      version += 1;
      return { eTag: `"{GUID},${String(version)}"` } as unknown as T;
    },
    post: () => {
      requestCount += 1;
      return Promise.reject(new Error("the fake renaming client does not implement post"));
    },
    async patch<T>(pathOrUrl: string, body: unknown, headers?: Record<string, string>): Promise<T> {
      requestCount += 1;
      calls.push({ path: pathOrUrl, name: (body as { name: string }).name, ifMatch: headers?.["if-match"] });

      const failing = Object.entries(patchStatuses).find(([path]) => pathOrUrl.includes(encoded(path)));
      if (failing !== undefined) {
        throw new GraphRequestError({ method: "PATCH", path: pathOrUrl, status: failing[1], body: "{}" });
      }
      if (patchResponse !== "item") return bodyFor(patchResponse) as T;
      version += 1;
      return { eTag: `"{GUID},${String(version)}"` } as unknown as T;
    },
    getBytes: () => {
      requestCount += 2;
      return Promise.reject(new Error("the fake renaming client does not implement getBytes"));
    },
    requests: () => requestCount,
  };
}
