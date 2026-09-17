import { describe, expect, it } from "vitest";
import { runScan } from "../../src/scan/run.js";
import { createMemoryStateStore } from "../../src/store/memory.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import type { GraphClient } from "../../src/graph/client.js";
import { readFileSync } from "node:fs";

const PROFILE = loadProfile(
  JSON.parse(readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8")),
);
const NOW = () => new Date("2026-09-13T12:00:00Z");
const SITE = "/sites/contoso.sharepoint.com:/sites/Example";
const DRIVES = "/sites/site-1/drives?$select=id,name";

describe("runScan when the stored deltaLink is rejected", () => {
  it("clears the inventory, re-enumerates, and reports that it resynced", async () => {
    const store = createMemoryStateStore();
    await store.setDeltaLink("example", "drive-1", "https://graph.microsoft.com/v1.0/stale", "2026-09-12T00:00:00Z");
    await store.applyInventoryChanges("example", "drive-1", [
      {
        kind: "upsert",
        record: {
          itemId: "ghost",
          path: "2026/deleted-while-we-were-away.xlsx",
          name: "deleted-while-we-were-away.xlsx",
          isFolder: false,
          size: 1,
          modified: "2026-08-01T00:00:00Z",
          etag: "e",
        },
      },
    ]);

    let requests = 0;
    const client: GraphClient = {
      requests: () => requests,
      get: async <T,>(path: string): Promise<T> => {
        requests += 1;
        if (path === SITE) return { id: "site-1" } as T;
        if (path === DRIVES) return { value: [{ id: "drive-1", name: "Compliance Reports" }] } as T;
        if (path === "https://graph.microsoft.com/v1.0/stale") {
          throw new GraphRequestError({
            method: "GET",
            path,
            status: 410,
            body: JSON.stringify({ error: { code: "resyncRequired", message: "gone" } }),
          });
        }
        return {
          value: [
            {
              id: "i1",
              name: "fresh.xlsx",
              parentReference: { path: "/drives/drive-1/root:/2026" },
              file: {},
              size: 1,
              lastModifiedDateTime: "2026-09-01T00:00:00Z",
              eTag: "e",
            },
          ],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/after-resync",
        } as T;
      },
      post: async <T,>(): Promise<T> => { throw new Error("this fake does not implement post"); },
      getBytes: async (): Promise<Uint8Array> => { throw new Error("this fake does not implement getBytes"); },
    };

    const result = await runScan({ client, store, profile: PROFILE, now: NOW });

    expect(result.resynced).toBe(true);
    expect(result.mode).toBe("full");
    expect(result.snapshot.files.map((file) => file.path)).toEqual(["2026/fresh.xlsx"]);
  });
});

describe("runScan when a page fails partway", () => {
  it("leaves the previous deltaLink in place, so the next run re-reads rather than skipping", async () => {
    const store = createMemoryStateStore();
    await store.setDeltaLink("example", "drive-1", "https://graph.microsoft.com/v1.0/stored", "2026-09-12T00:00:00Z");

    const client: GraphClient = {
      requests: () => 3,
      get: async <T,>(path: string): Promise<T> => {
        if (path === SITE) return { id: "site-1" } as T;
        if (path === DRIVES) return { value: [{ id: "drive-1", name: "Compliance Reports" }] } as T;
        if (path === "https://graph.microsoft.com/v1.0/stored") {
          return { value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/page-2" } as T;
        }
        throw new GraphRequestError({ method: "GET", path, status: 503, body: "unavailable" });
      },
      post: async <T,>(): Promise<T> => { throw new Error("this fake does not implement post"); },
      getBytes: async (): Promise<Uint8Array> => { throw new Error("this fake does not implement getBytes"); },
    };

    await expect(runScan({ client, store, profile: PROFILE, now: NOW })).rejects.toThrow(GraphRequestError);
    await expect(store.getDeltaLink("example", "drive-1")).resolves.toBe("https://graph.microsoft.com/v1.0/stored");
  });
});

describe("runScan when a resync discards a partially applied first attempt", () => {
  it("counts the work of a discarded first attempt, because the run still paid for it", async () => {
    const store = createMemoryStateStore();
    await store.setDeltaLink("example", "drive-1", "https://graph.microsoft.com/v1.0/stored-multi", "2026-09-12T00:00:00Z");

    let requests = 0;
    const client: GraphClient = {
      requests: () => requests,
      get: async <T,>(path: string): Promise<T> => {
        requests += 1;
        if (path === SITE) return { id: "site-1" } as T;
        if (path === DRIVES) return { value: [{ id: "drive-1", name: "Compliance Reports" }] } as T;
        if (path === "https://graph.microsoft.com/v1.0/stored-multi") {
          // First page of the stored-link attempt: one real item, plus a
          // nextLink so the generator goes back for a second page.
          return {
            value: [
              {
                id: "i1",
                name: "first.xlsx",
                parentReference: { path: "/drives/drive-1/root:/2026" },
                file: {},
                size: 1,
                lastModifiedDateTime: "2026-08-01T00:00:00Z",
                eTag: "e1",
              },
            ],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/page-2",
          } as T;
        }
        if (path === "https://graph.microsoft.com/v1.0/page-2") {
          // The second page of the same enumeration is where the 410 lands,
          // after the first page has already been applied to the store.
          throw new GraphRequestError({
            method: "GET",
            path,
            status: 410,
            body: JSON.stringify({ error: { code: "resyncRequired" } }),
          });
        }
        if (path === "/drives/drive-1/root/delta") {
          // The fresh enumeration after the resync, one complete page.
          return {
            value: [
              {
                id: "i2",
                name: "fresh.xlsx",
                parentReference: { path: "/drives/drive-1/root:/2026" },
                file: {},
                size: 1,
                lastModifiedDateTime: "2026-09-01T00:00:00Z",
                eTag: "e2",
              },
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/after-resync-multi",
          } as T;
        }
        throw new Error(`unexpected path ${path}`);
      },
      post: async <T,>(): Promise<T> => { throw new Error("this fake does not implement post"); },
      getBytes: async (): Promise<Uint8Array> => { throw new Error("this fake does not implement getBytes"); },
    };

    const result = await runScan({ client, store, profile: PROFILE, now: NOW });

    expect(result.resynced).toBe(true);
    expect(result.mode).toBe("full");
    expect(result.snapshot.files.map((file) => file.path)).toEqual(["2026/fresh.xlsx"]);
    // One page from the discarded first attempt (the second page never yields,
    // it throws before yielding), one page from the fresh enumeration.
    expect(result.pages).toBe(2);
    // One upsert applied and discarded by the first attempt, one applied by the
    // fresh enumeration. Both are counted, because the run paid for both.
    expect(result.changesApplied).toBe(2);
    expect(result.storeBatches).toBe(2);
  });
});
