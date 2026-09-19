import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RepositoryFile, RepositorySnapshot, WorkbookSnapshot } from "../../../src/domain/reconcile/index.js";
import { GraphRequestError } from "../../../src/graph/errors.js";
import type { GraphClient } from "../../../src/graph/client.js";
import type { ScanResult } from "../../../src/scan/run.js";
import type { ToolContext } from "../../../src/tools/context.js";
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
 * Answers the plan-time etag lookups and nothing else. A path maps to an etag
 * string, to `null` for an item Graph returns with no etag at all, or to a
 * number for a Graph status the lookup should fail with. A path with no entry
 * makes the fake throw, so a handler that reached for a call the test did not
 * intend fails loudly instead of receiving a plausible answer.
 *
 * Every method moves the same counter `requests()` reports, the way the real
 * client does. This project's sharpest phase 2 review finding was a cost
 * assertion measured against a counter that could not move.
 */
export function etagGraphClient(etagsByPath: Record<string, string | null | number>): GraphClient & {
  lookups: string[];
} {
  let requestCount = 0;
  const lookups: string[] = [];
  // A mutable copy, not the caller's own object: a successful patch below
  // updates the recorded etag, the way a real rename invalidates the item's
  // old one, so a caller that reads a path again after patching it sees the
  // new value rather than the fixture it started with.
  const state = new Map<string, string | null | number>(Object.entries(etagsByPath));

  function findMatch(pathOrUrl: string): [string, string | null | number] | undefined {
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
      return (match[1] === null ? {} : { eTag: match[1] }) as unknown as T;
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
      const ifMatch = headers?.["if-match"];
      if (ifMatch !== undefined && current !== ifMatch) {
        throw new GraphRequestError({ method: "PATCH", path: pathOrUrl, status: 412, body: "{}" });
      }
      // A rename invalidates the old etag. Bumped deterministically rather
      // than randomized, so a test asserting the returned etag can predict it.
      const nextEtag = `${current ?? "no-etag"}-renamed`;
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
