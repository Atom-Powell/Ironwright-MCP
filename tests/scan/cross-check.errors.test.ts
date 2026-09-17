import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crossCheckOtherLibraries } from "../../src/scan/cross-check.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import type { GraphClient } from "../../src/graph/client.js";

const RAW_PROFILE = JSON.parse(readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8"));

const SITE_PATH = "/sites/contoso.sharepoint.com:/sites/Example";
const DRIVES_PATH = "/sites/site-1/drives?$select=id,name,webUrl";

interface Drive {
  id: string;
  name: string;
  webUrl?: string;
}

function fakeClient(args: {
  drives: Drive[];
  scripts: Record<string, unknown>;
}): Pick<GraphClient, "get" | "post"> {
  return {
    get: async <T,>(path: string): Promise<T> => {
      if (path === SITE_PATH) return { id: "site-1" } as T;
      if (path === DRIVES_PATH) return { value: args.drives } as T;
      throw new Error(`unexpected get ${path}`);
    },
    post: async <T,>(path: string, body?: unknown): Promise<T> => {
      if (path !== "/search/query") throw new Error(`unexpected post ${path}`);
      const b = body as { requests: Array<{ query: { queryString: string } }> };
      const queryString = b.requests[0]?.query.queryString ?? "";
      const scope = Object.keys(args.scripts).find((candidate) => queryString.includes(`path:"${candidate}"`));
      if (scope === undefined) throw new Error(`unscripted search, queryString was: ${queryString}`);
      const entry = args.scripts[scope];
      if (entry instanceof Error) throw entry;
      return entry as T;
    },
  };
}

function hit(name: string, driveId: string, webUrl: string, extra: Record<string, unknown> = {}): unknown {
  return {
    resource: {
      name,
      webUrl,
      size: 10,
      lastModifiedDateTime: "2026-01-01T00:00:00Z",
      parentReference: { driveId },
      ...extra,
    },
  };
}

function page(hits: unknown[], more: boolean): unknown {
  return { value: [{ hitsContainers: [{ hits, moreResultsAvailable: more }] }] };
}

const OWN_DRIVE: Drive = {
  id: "drive-own",
  name: "Compliance Reports",
  webUrl: "https://contoso.sharepoint.com/sites/Example/Compliance Reports",
};
const ARCHIVE_DRIVE: Drive = {
  id: "drive-archive",
  name: "Archive",
  webUrl: "https://contoso.sharepoint.com/sites/Example/Archive",
};

function profileWithoutRegion(): ReturnType<typeof loadProfile> {
  return loadProfile(RAW_PROFILE);
}

function profileWithRegion(): ReturnType<typeof loadProfile> {
  return loadProfile({ ...RAW_PROFILE, identity: { ...RAW_PROFILE.identity, searchRegion: "NAM" } });
}

describe("crossCheckOtherLibraries failures", () => {
  it("issues no search at all when the profile carries no region", async () => {
    let calls = 0;
    const client: Pick<GraphClient, "get" | "post"> = {
      get: (async () => {
        calls += 1;
        return {};
      }) as never,
      post: (async () => {
        calls += 1;
        return {};
      }) as never,
    };

    const result = await crossCheckOtherLibraries(client, profileWithoutRegion());

    expect(result).toEqual({ files: [], complete: false, reason: "no-region" });
    // Not merely "returns incomplete": it must not spend a request either.
    expect(calls).toBe(0);
  });

  it("catches a search failure and reports search-failed rather than throwing", async () => {
    const client = fakeClient({
      drives: [OWN_DRIVE, ARCHIVE_DRIVE],
      scripts: { [ARCHIVE_DRIVE.webUrl!]: new Error("search exploded") },
    });

    const result = await crossCheckOtherLibraries(client, profileWithRegion());

    expect(result.complete).toBe(false);
    expect(result.reason).toBe("search-failed");
    expect(result.files).toEqual([]);
  });

  it("reports search-failed rather than throwing when the site's own drive cannot be resolved", async () => {
    const client: Pick<GraphClient, "get" | "post"> = {
      get: async () => {
        throw new Error("site lookup exploded");
      },
      post: async () => {
        throw new Error("this test does not expect a search");
      },
    };

    const result = await crossCheckOtherLibraries(client, profileWithRegion());

    expect(result).toEqual({ files: [], complete: false, reason: "search-failed" });
  });

  it("skips a hit whose driveId does not match the library actually being searched", async () => {
    const client = fakeClient({
      drives: [OWN_DRIVE, ARCHIVE_DRIVE],
      scripts: {
        [ARCHIVE_DRIVE.webUrl!]: page(
          [
            // The path scope named Archive, but this hit's own driveId names a
            // different drive. The path scope is a filter, not a guarantee.
            hit("impostor.xlsx", "drive-somewhere-else", `${ARCHIVE_DRIVE.webUrl}/impostor.xlsx`),
          ],
          false,
        ),
      },
    });

    const result = await crossCheckOtherLibraries(client, profileWithRegion());

    expect(result.complete).toBe(true);
    expect(result.files).toEqual([]);
  });

  it("skips a hit with no size or no lastModified rather than defaulting either", async () => {
    const missingSize = hit("no-size.xlsx", "drive-archive", `${ARCHIVE_DRIVE.webUrl}/no-size.xlsx`, { size: undefined });
    const missingModified = hit("no-modified.xlsx", "drive-archive", `${ARCHIVE_DRIVE.webUrl}/no-modified.xlsx`, {
      lastModifiedDateTime: undefined,
    });
    const client = fakeClient({
      drives: [OWN_DRIVE, ARCHIVE_DRIVE],
      scripts: { [ARCHIVE_DRIVE.webUrl!]: page([missingSize, missingModified], false) },
    });

    const result = await crossCheckOtherLibraries(client, profileWithRegion());

    expect(result.complete).toBe(true);
    expect(result.files).toEqual([]);
  });
});
