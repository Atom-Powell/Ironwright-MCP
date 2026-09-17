import { describe, expect, it } from "vitest";
import { runScan } from "../../src/scan/run.js";
import { createMemoryStateStore } from "../../src/store/memory.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import type { GraphClient } from "../../src/graph/client.js";
import { readFileSync } from "node:fs";

const PROFILE = loadProfile(
  JSON.parse(readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8")),
);
const NOW = () => new Date("2026-09-13T12:00:00Z");

function scriptedClient(responses: Record<string, unknown>): GraphClient {
  let requests = 0;
  return {
    requests: () => requests,
    get: async <T,>(path: string): Promise<T> => {
      requests += 1;
      if (!(path in responses)) throw new Error(`unexpected path ${path}`);
      return responses[path] as T;
    },
    post: async <T,>(): Promise<T> => { throw new Error("this fake does not implement post"); },
    getBytes: async (): Promise<Uint8Array> => { throw new Error("this fake does not implement getBytes"); },
  };
}

const SITE = "/sites/contoso.sharepoint.com:/sites/Example";
const DRIVES = "/sites/site-1/drives?$select=id,name,webUrl";

function baseResponses(delta: unknown): Record<string, unknown> {
  return {
    [SITE]: { id: "site-1" },
    [DRIVES]: { value: [{ id: "drive-1", name: "Compliance Reports" }] },
    "/drives/drive-1/root/delta": delta,
  };
}

describe("runScan", () => {
  it("enumerates a cold store in full and stores the deltaLink", async () => {
    const store = createMemoryStateStore();
    const client = scriptedClient(
      baseResponses({
        value: [
          { id: "r", root: {}, name: "root", folder: {} },
          { id: "f1", name: "2026", parentReference: { path: "/drives/drive-1/root:" }, folder: {} },
          {
            id: "i1",
            name: "2026-08_CLIENTA_MonthlyTraining.xlsx",
            parentReference: { path: "/drives/drive-1/root:/2026" },
            file: {},
            size: 10,
            lastModifiedDateTime: "2026-08-31T00:00:00Z",
            eTag: "e1",
          },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/next-link",
      }),
    );

    const result = await runScan({ client, store, profile: PROFILE, now: NOW });

    expect(result.mode).toBe("full");
    expect(result.resynced).toBe(false);
    expect(result.snapshot.files.map((file) => file.path)).toEqual(["2026/2026-08_CLIENTA_MonthlyTraining.xlsx"]);
    expect(result.snapshot.folderPaths).toEqual(["2026"]);
    expect(result.snapshot.scannedAt).toBe("2026-09-13T12:00:00.000Z");
    await expect(store.getDeltaLink("example", "drive-1")).resolves.toBe("https://graph.microsoft.com/v1.0/next-link");
    // One page. The root item is skipped, leaving two upserts (the folder and
    // the file), applied as a single store batch since both fit in one chunk.
    expect(result.pages).toBe(1);
    expect(result.changesApplied).toBe(2);
    expect(result.storeBatches).toBe(1);
  });

  it("runs incrementally from a stored link and keeps items it did not see again", async () => {
    const store = createMemoryStateStore();
    await store.setDeltaLink("example", "drive-1", "https://graph.microsoft.com/v1.0/stored", "2026-09-12T00:00:00Z");
    await store.applyInventoryChanges("example", "drive-1", [
      {
        kind: "upsert",
        record: {
          itemId: "i1",
          path: "2026/old.xlsx",
          name: "old.xlsx",
          isFolder: false,
          size: 1,
          modified: "2026-08-01T00:00:00Z",
          etag: "e",
        },
      },
    ]);

    const client = scriptedClient({
      [SITE]: { id: "site-1" },
      [DRIVES]: { value: [{ id: "drive-1", name: "Compliance Reports" }] },
      "https://graph.microsoft.com/v1.0/stored": {
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/newer",
      },
    });

    const result = await runScan({ client, store, profile: PROFILE, now: NOW });

    expect(result.mode).toBe("incremental");
    expect(result.snapshot.files.map((file) => file.path)).toEqual(["2026/old.xlsx"]);
    expect(result.graphRequests).toBe(3);
    // One page with no items, so nothing is applied and no store batch is issued.
    expect(result.pages).toBe(1);
    expect(result.changesApplied).toBe(0);
    expect(result.storeBatches).toBe(0);
  });

  it("merges a multi-page enumeration that completes, using the final page's deltaLink", async () => {
    const store = createMemoryStateStore();
    const client = scriptedClient({
      [SITE]: { id: "site-1" },
      [DRIVES]: { value: [{ id: "drive-1", name: "Compliance Reports" }] },
      "/drives/drive-1/root/delta": {
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
      },
      "https://graph.microsoft.com/v1.0/page-2": {
        value: [
          {
            id: "i2",
            name: "second.xlsx",
            parentReference: { path: "/drives/drive-1/root:/2026" },
            file: {},
            size: 2,
            lastModifiedDateTime: "2026-08-02T00:00:00Z",
            eTag: "e2",
          },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/final",
      },
    });

    const result = await runScan({ client, store, profile: PROFILE, now: NOW });

    expect(result.snapshot.files.map((file) => file.path)).toEqual(["2026/first.xlsx", "2026/second.xlsx"]);
    expect(result.pages).toBe(2);
    // One upsert per page, applied as its own store batch.
    expect(result.changesApplied).toBe(2);
    expect(result.storeBatches).toBe(2);
    await expect(store.getDeltaLink("example", "drive-1")).resolves.toBe("https://graph.microsoft.com/v1.0/final");
  });

  it("reports only this call's own requests when the client is reused across scans", async () => {
    // client.requests() is cumulative since the client was constructed. Reusing
    // one client across two runScan calls -- as a tool wiring a Graph client
    // once and calling runScan per invocation would -- must not let the second
    // call's report include requests the first call already paid for.
    const store = createMemoryStateStore();
    const client = scriptedClient({
      [SITE]: { id: "site-1" },
      [DRIVES]: { value: [{ id: "drive-1", name: "Compliance Reports" }] },
      "/drives/drive-1/root/delta": {
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/second",
      },
      "https://graph.microsoft.com/v1.0/second": {
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/third",
      },
    });

    const first = await runScan({ client, store, profile: PROFILE, now: NOW });
    const second = await runScan({ client, store, profile: PROFILE, now: NOW });

    // Each call costs 2 requests to resolve the drive plus 1 delta page.
    expect(first.graphRequests).toBe(3);
    expect(second.graphRequests).toBe(3);
    expect(client.requests()).toBe(6);
  });

  it("wires the Search cross-check into the assembled snapshot", async () => {
    // A wiring test rather than a duplicate of cross-check.test.ts's own
    // coverage: this proves runScan actually calls crossCheckOtherLibraries
    // and passes its result on to assembleSnapshot, which a unit test of
    // either function alone cannot catch if the two are wired together
    // wrong or not wired together at all.
    const rawProfile = JSON.parse(
      readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8"),
    );
    const profileWithRegion = loadProfile({
      ...rawProfile,
      identity: { ...rawProfile.identity, searchRegion: "NAM" },
    });

    const store = createMemoryStateStore();
    const drives = [
      {
        id: "drive-1",
        name: "Compliance Reports",
        webUrl: "https://contoso.sharepoint.com/sites/Example/Compliance Reports",
      },
      { id: "drive-2", name: "Archive", webUrl: "https://contoso.sharepoint.com/sites/Example/Archive" },
    ];

    let requests = 0;
    const client: GraphClient = {
      requests: () => requests,
      get: async <T,>(path: string): Promise<T> => {
        requests += 1;
        if (path === SITE) return { id: "site-1" } as T;
        if (path === DRIVES) return { value: drives } as T;
        if (path === "/drives/drive-1/root/delta") {
          return { value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/next-link" } as T;
        }
        throw new Error(`unexpected get ${path}`);
      },
      post: async <T,>(path: string): Promise<T> => {
        requests += 1;
        if (path !== "/search/query") throw new Error(`unexpected post ${path}`);
        return {
          value: [
            {
              hitsContainers: [
                {
                  hits: [
                    {
                      resource: {
                        name: "2026-08_CLIENTA_MonthlyTraining.xlsx",
                        webUrl:
                          "https://contoso.sharepoint.com/sites/Example/Archive/2026-08_CLIENTA_MonthlyTraining.xlsx",
                        size: 10,
                        lastModifiedDateTime: "2026-08-01T00:00:00Z",
                        parentReference: { driveId: "drive-2" },
                      },
                    },
                  ],
                  moreResultsAvailable: false,
                },
              ],
            },
          ],
        } as T;
      },
      getBytes: async (): Promise<Uint8Array> => {
        throw new Error("this fake does not implement getBytes");
      },
    };

    const result = await runScan({ client, store, profile: profileWithRegion, now: NOW });

    expect(result.snapshot.searchCrossCheckIncluded).toBe(true);
    expect(result.searchCrossCheckSkipReason).toBeUndefined();
    const found = result.snapshot.files.find((file) => file.library === "Archive");
    expect(found?.name).toBe("2026-08_CLIENTA_MonthlyTraining.xlsx");
  });
});
