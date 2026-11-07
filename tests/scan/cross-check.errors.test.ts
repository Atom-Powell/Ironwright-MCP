import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crossCheckOtherLibraries } from "../../src/scan/cross-check.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import type { GraphClient } from "../../src/graph/client.js";
import { UnexpectedTokenRolesError } from "../../src/graph/token.js";

const RAW_PROFILE = JSON.parse(readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8"));

interface Drive {
  id: string;
  name: string;
  webUrl?: string;
}

/**
 * Only `post` is faked. `crossCheckOtherLibraries` no longer resolves the
 * site's drives itself; `runScan` does that once through `resolveDrive` and
 * hands the listing and the resolved own-drive id in, so there is no `get`
 * for this cross-check to make and nothing here for one to serve.
 */
function fakeClient(args: { scripts: Record<string, unknown> }): Pick<GraphClient, "post"> {
  return {
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
    const client: Pick<GraphClient, "post"> = {
      post: (async () => {
        calls += 1;
        return {};
      }) as never,
    };

    const result = await crossCheckOtherLibraries(client, profileWithoutRegion(), [OWN_DRIVE, ARCHIVE_DRIVE], OWN_DRIVE.id);

    expect(result).toEqual({ files: [], complete: false, reason: "no-region" });
    // Not merely "returns incomplete": it must not spend a request either.
    expect(calls).toBe(0);
  });

  it("catches a search failure and reports search-failed rather than throwing", async () => {
    const client = fakeClient({
      scripts: { [ARCHIVE_DRIVE.webUrl!]: new Error("search exploded") },
    });

    const result = await crossCheckOtherLibraries(client, profileWithRegion(), [OWN_DRIVE, ARCHIVE_DRIVE], OWN_DRIVE.id);

    expect(result.complete).toBe(false);
    expect(result.reason).toBe("search-failed");
    expect(result.files).toEqual([]);
  });

  it("propagates a token refused for its roles rather than reporting it as search-failed", async () => {
    // search-failed sends the operator to investigate a Graph or network
    // failure. A refused token is neither, and it refuses every other call in
    // the same tool too, so it must reach the tool's own message instead.
    const refusal = new UnexpectedTokenRolesError({
      found: ["Sites.Selected", "Files.Read.All"],
      extra: ["Files.Read.All"],
      missing: [],
    });
    const client = fakeClient({ scripts: { [ARCHIVE_DRIVE.webUrl!]: refusal } });

    await expect(
      crossCheckOtherLibraries(client, profileWithRegion(), [OWN_DRIVE, ARCHIVE_DRIVE], OWN_DRIVE.id),
    ).rejects.toBe(refusal);
  });

  it("skips a hit whose driveId does not match the library actually being searched", async () => {
    const client = fakeClient({
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

    const result = await crossCheckOtherLibraries(client, profileWithRegion(), [OWN_DRIVE, ARCHIVE_DRIVE], OWN_DRIVE.id);

    expect(result.complete).toBe(true);
    expect(result.files).toEqual([]);
  });

  it("skips a hit with no size or no lastModified rather than defaulting either", async () => {
    const missingSize = hit("no-size.xlsx", "drive-archive", `${ARCHIVE_DRIVE.webUrl}/no-size.xlsx`, { size: undefined });
    const missingModified = hit("no-modified.xlsx", "drive-archive", `${ARCHIVE_DRIVE.webUrl}/no-modified.xlsx`, {
      lastModifiedDateTime: undefined,
    });
    const client = fakeClient({
      scripts: { [ARCHIVE_DRIVE.webUrl!]: page([missingSize, missingModified], false) },
    });

    const result = await crossCheckOtherLibraries(client, profileWithRegion(), [OWN_DRIVE, ARCHIVE_DRIVE], OWN_DRIVE.id);

    expect(result.complete).toBe(true);
    expect(result.files).toEqual([]);
  });

  it("reports library-not-addressable, not search-failed, for a listed library with no webUrl", async () => {
    // No request was ever sent for this library: it never reached
    // searchDriveItems at all, because there is no webUrl to send as a path
    // scope. Reporting "search-failed" here would tell an operator to
    // investigate a Graph or network failure that never happened; the real,
    // different problem is that the drive listing itself did not describe
    // this library well enough to search it.
    const noWebUrlDrive: Drive = { id: "drive-no-weburl", name: "No Url" };
    let searchCalls = 0;
    const client = fakeClient({ scripts: {} });
    const countingClient: Pick<GraphClient, "post"> = {
      post: async <T,>(path: string, body?: unknown): Promise<T> => {
        searchCalls += 1;
        return client.post<T>(path, body);
      },
    };

    const result = await crossCheckOtherLibraries(countingClient, profileWithRegion(), [OWN_DRIVE, noWebUrlDrive], OWN_DRIVE.id);

    expect(result).toEqual({ files: [], complete: false, reason: "library-not-addressable" });
    expect(searchCalls).toBe(0);
  });

  it("still reports search-failed, not library-not-addressable, when a different library both lacks a webUrl and another one fails", async () => {
    // Both conditions occurred in the same run, which is exactly the case
    // this cross-check's own precedence comment describes rather than a
    // hypothetical: search-failed is reported because it is the more
    // directly actionable of the two, pointing at a request that actually
    // broke, which a retry might resolve and which could otherwise be masking
    // whether the unaddressable library would have been reachable at all.
    const noWebUrlDrive: Drive = { id: "drive-no-weburl", name: "No Url" };
    const client = fakeClient({
      scripts: { [ARCHIVE_DRIVE.webUrl!]: new Error("search exploded") },
    });

    const result = await crossCheckOtherLibraries(
      client,
      profileWithRegion(),
      [OWN_DRIVE, noWebUrlDrive, ARCHIVE_DRIVE],
      OWN_DRIVE.id,
    );

    expect(result.complete).toBe(false);
    expect(result.reason).toBe("search-failed");
  });

  it("skips a library profile with its own reason and spends no request", async () => {
    let posts = 0;
    const client = { post: () => { posts += 1; return Promise.reject(new Error("must not search")); } };
    const library = {
      kind: "library" as const,
      profileId: "docs",
      identity: { siteUrl: "https://contoso.sharepoint.com/sites/Example", library: "Docs", searchRegion: "NAM" },
      sites: [{ siteUrl: "https://contoso.sharepoint.com/sites/Example", library: "Docs", searchRegion: "NAM" }],
    };

    const result = await crossCheckOtherLibraries(client, library, [], "drive-1");

    expect(result).toEqual({ files: [], complete: false, reason: "library-profile" });
    expect(posts).toBe(0);
  });
});
