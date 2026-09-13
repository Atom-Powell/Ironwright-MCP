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
  };
}

const SITE = "/sites/contoso.sharepoint.com:/sites/Example";
const DRIVES = "/sites/site-1/drives?$select=id,name";

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
  });
});
