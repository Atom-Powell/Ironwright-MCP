import type { RepositorySnapshot } from "../../../src/domain/reconcile/index.js";
import { file, snapshot } from "../rename/fixtures.js";
import { GraphRequestError } from "../../../src/graph/errors.js";
import type { GraphClient } from "../../../src/graph/client.js";
import type { StoredPlan } from "../../../src/store/types.js";

export const SEPT = "2026/ACME/09-September";
export const AUG = "2026/ACME/08-August";
export const CANONICAL_NAME = "2026-09_ACME_MonthlyTraining.xlsx";
export const MISNAMED_NAME = "2026-09_ACME_VendorTraining.xlsx";
export const MISPLACED_PATH = `${AUG}/${CANONICAL_NAME}`;
export const BOTH_WRONG_PATH = `${AUG}/${MISNAMED_NAME}`;
export const TARGET_PATH = `${SEPT}/${CANONICAL_NAME}`;

const FOLDERS = ["2026", "2026/ACME", AUG, SEPT];

/** September's report filed in August's folder under its canonical name. */
export function snapshotWithMisplacedFile(folders: string[] = FOLDERS): RepositorySnapshot {
  return snapshot([file(MISPLACED_PATH)], folders);
}

/** September's report filed in August's folder under the vendor-token name. */
export function snapshotWithBothWrong(): RepositorySnapshot {
  return snapshot([file(BOTH_WRONG_PATH)], FOLDERS);
}

/**
 * A library holding files and folders that applies a PATCH the way the
 * 2026-09-24 probe measured Graph applying it: 412 on a stale If-Match, 400
 * for an absent target folder, 409 nameAlreadyExists for an occupied target
 * name, and otherwise the file relocated under a fresh etag naming its new
 * path. What it cannot prove is what SharePoint holds afterward; the live
 * sitting is the only evidence of that.
 */
export function movingLibraryGraphClient(files: Record<string, string>, folders: string[]): GraphClient & {
  paths: () => string[];
} {
  const state = new Map<string, string>(Object.entries(files));
  const folderSet = new Set(folders);
  let requestCount = 0;
  let version = 0;

  const encodedOf = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  const pathIn = (url: string) => [...state.keys()].find((path) => url.includes(`root:/${encodedOf(path)}:`));
  const parentOf = (path: string) => (path.lastIndexOf("/") === -1 ? "" : path.slice(0, path.lastIndexOf("/")));
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const fail = (url: string, status: number, code: string) =>
    new GraphRequestError({ method: "PATCH", path: url, status, body: JSON.stringify({ error: { code } }) });

  return {
    paths: () => [...state.keys()].sort(),
    async get<T>(url: string): Promise<T> {
      requestCount += 1;
      const path = pathIn(url);
      if (path === undefined) throw new GraphRequestError({ method: "GET", path: url, status: 404, body: "{}" });
      return { eTag: state.get(path) } as unknown as T;
    },
    post: () => {
      requestCount += 1;
      return Promise.reject(new Error("the fake moving library does not implement post"));
    },
    async patch<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T> {
      requestCount += 1;
      const path = pathIn(url);
      if (path === undefined) throw fail(url, 404, "itemNotFound");
      if (headers?.["if-match"] !== state.get(path)) throw fail(url, 412, "resourceModified");

      const request = body as { name?: string; parentReference?: { path: string } };
      let folder = parentOf(path);
      if (request.parentReference !== undefined) {
        // Raw, as Graph requires; see parentReferencePath.
        folder = request.parentReference.path.replace(/^\/drives\/[^/]+\/root:\/?/, "");
        if (folder !== "" && !folderSet.has(folder)) throw fail(url, 400, "invalidRequest");
      }
      const target = folder === "" ? (request.name ?? nameOf(path)) : `${folder}/${request.name ?? nameOf(path)}`;
      if (target !== path && state.has(target)) throw fail(url, 409, "nameAlreadyExists");

      version += 1;
      const etag = `etag-${String(version)}-for-${target}`;
      state.delete(path);
      state.set(target, etag);
      return { eTag: etag } as unknown as T;
    },
    putBytes: () => {
      requestCount += 1;
      return Promise.reject(new Error("this fake Graph client does not implement putBytes"));
    },
    getBytes: () => {
      requestCount += 2;
      return Promise.reject(new Error("the fake moving library does not implement getBytes"));
    },
    requests: () => requestCount,
  };
}

export const MOVE_ITEM = {
  path: MISPLACED_PATH,
  currentName: CANONICAL_NAME,
  targetName: CANONICAL_NAME,
  targetPath: TARGET_PATH,
  etag: "etag-0",
  client: "ACME",
};

export function movePlanWith(items: StoredPlan["items"], excluded: StoredPlan["excluded"] = []): StoredPlan {
  return {
    planId: "mov-2026-09-14-a1b2c3d4",
    profileId: "example",
    kind: "move",
    driveId: "drive-1",
    createdAt: "2026-09-14T12:00:00Z",
    items,
    excluded,
  };
}
