import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { crossCheckOtherLibraries } from "../../src/scan/cross-check.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import type { GraphClient } from "../../src/graph/client.js";
import { SEARCH_PAGE_CAP, SEARCH_PAGE_SIZE } from "../../src/graph/search.js";

const RAW_PROFILE = JSON.parse(readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8"));

function profileWithRegion(overrides: Record<string, unknown> = {}): ReturnType<typeof loadProfile> {
  return loadProfile({
    ...RAW_PROFILE,
    ...overrides,
    identity: { ...RAW_PROFILE.identity, searchRegion: "NAM", ...(overrides.identity as object | undefined) },
  });
}

interface Drive {
  id: string;
  name: string;
  webUrl?: string;
}

type SearchScript = unknown | ((call: number) => unknown);

/**
 * Keyed by the library's own webUrl, which is exactly the pathScope
 * `crossCheckOtherLibraries` must send for that library. A script entry not
 * present here means that library must never be searched at all: any
 * queryString this fake cannot match throws, which is what lets a test prove
 * a library, such as the profile's own, was never queried.
 *
 * Only `post` is faked: `crossCheckOtherLibraries` no longer lists a site's
 * drives itself, since `runScan` already does that once through
 * `resolveDrive` and threads the listing and the resolved own-drive id
 * through, so there is nothing here for a `get` to serve.
 */
function fakeClient(args: {
  scripts: Record<string, SearchScript>;
  onSearch?: (pathScope: string, body: unknown) => void;
}): Pick<GraphClient, "post"> {
  const callCounts = new Map<string, number>();
  return {
    post: async <T,>(path: string, body?: unknown): Promise<T> => {
      if (path !== "/search/query") throw new Error(`unexpected post ${path}`);
      const b = body as { requests: Array<{ query: { queryString: string } }> };
      const queryString = b.requests[0]?.query.queryString ?? "";
      const scope = Object.keys(args.scripts).find((candidate) => queryString.includes(`path:"${candidate}"`));
      if (scope === undefined) throw new Error(`unscripted search, queryString was: ${queryString}`);
      args.onSearch?.(scope, body);

      const call = callCounts.get(scope) ?? 0;
      callCounts.set(scope, call + 1);
      const entry = args.scripts[scope];
      return (typeof entry === "function" ? (entry as (call: number) => unknown)(call) : entry) as T;
    },
  };
}

function hit(name: string, driveId: string, webUrl: string): unknown {
  return {
    resource: {
      name,
      webUrl,
      size: 10,
      lastModifiedDateTime: "2026-01-01T00:00:00Z",
      parentReference: { driveId },
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

describe("crossCheckOtherLibraries", () => {
  it("returns complete with no files when the site carries only the profile's own library", async () => {
    const client = fakeClient({ scripts: {} });

    const result = await crossCheckOtherLibraries(client, profileWithRegion(), [OWN_DRIVE], OWN_DRIVE.id);

    expect(result).toEqual({ files: [], complete: true });
  });

  it("qualifies a hit from another library with that library's name and a path relative to it", async () => {
    const client = fakeClient({
      scripts: {
        [ARCHIVE_DRIVE.webUrl!]: page(
          [
            hit(
              "2026-01_CLIENTA_MonthlyTraining.xlsx",
              "drive-archive",
              `${ARCHIVE_DRIVE.webUrl}/2026/CLIENTA/2026-01_CLIENTA_MonthlyTraining.xlsx`,
            ),
          ],
          false,
        ),
      },
    });

    const result = await crossCheckOtherLibraries(client, profileWithRegion(), [OWN_DRIVE, ARCHIVE_DRIVE], OWN_DRIVE.id);

    expect(result.complete).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.files).toEqual([
      {
        path: "2026/CLIENTA/2026-01_CLIENTA_MonthlyTraining.xlsx",
        name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
        size: 10,
        modified: "2026-01-01T00:00:00Z",
        etag: "",
        library: "Archive",
      },
    ]);
  });

  it("never searches the profile's own library and never lets it contribute a file", async () => {
    // A trap: if the own library were ever searched, this hit would come
    // back as a plausible, well-formed file. The whole point of the test is
    // that this scope is never in `scripts` at all, so a search sent to it
    // throws, and the search cross-check must never trigger that throw.
    const searchedScopes: string[] = [];
    const client = fakeClient({
      scripts: {
        [ARCHIVE_DRIVE.webUrl!]: page([], false),
      },
      onSearch: (scope) => searchedScopes.push(scope),
    });

    const result = await crossCheckOtherLibraries(client, profileWithRegion(), [OWN_DRIVE, ARCHIVE_DRIVE], OWN_DRIVE.id);

    expect(searchedScopes).toEqual([ARCHIVE_DRIVE.webUrl]);
    expect(searchedScopes).not.toContain(OWN_DRIVE.webUrl);
    expect(result.files).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("excludes the profile's own library by the given id, not by a name comparison that a same-named decoy would also match", async () => {
    // Two drives share the exact display name "Compliance Reports", the
    // profile's own library name, but carry different ids. `runScan` resolves
    // which one is genuinely the profile's own through `resolveDrive`'s
    // exact-then-case-insensitive rule before this function ever runs, so
    // this function is handed that one id directly; ownNameDecoy is a second,
    // genuinely different library that happens to share the display name.
    //
    // A filter that excluded by comparing `drive.name` against
    // `profile.identity.library` directly, instead of comparing ids against
    // the given `ownDriveId`, would exclude both drives: ownNameDecoy's name
    // matches the profile's library name too. That would make this test
    // fail, because ownNameDecoy would then never be searched and its file
    // would never appear below. The correct, id-based exclusion searches
    // ownNameDecoy, since its id is not the given own id.
    const ownPrimary: Drive = {
      id: "drive-own-primary",
      name: "Compliance Reports",
      webUrl: "https://contoso.sharepoint.com/sites/Example/Compliance Reports",
    };
    const ownNameDecoy: Drive = {
      id: "drive-own-name-decoy",
      name: "Compliance Reports",
      webUrl: "https://contoso.sharepoint.com/sites/Example/Compliance Reports Decoy",
    };
    const searchedScopes: string[] = [];
    const client = fakeClient({
      scripts: {
        [ownNameDecoy.webUrl!]: page(
          [hit("2026-01_CLIENTA_MonthlyTraining.xlsx", ownNameDecoy.id, `${ownNameDecoy.webUrl}/2026-01_CLIENTA_MonthlyTraining.xlsx`)],
          false,
        ),
      },
      onSearch: (scope) => searchedScopes.push(scope),
    });

    const result = await crossCheckOtherLibraries(client, profileWithRegion(), [ownPrimary, ownNameDecoy], ownPrimary.id);

    expect(searchedScopes).toEqual([ownNameDecoy.webUrl]);
    expect(searchedScopes).not.toContain(ownPrimary.webUrl);
    expect(result.files).toEqual([
      {
        path: "2026-01_CLIENTA_MonthlyTraining.xlsx",
        name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
        size: 10,
        modified: "2026-01-01T00:00:00Z",
        etag: "",
        library: "Compliance Reports",
      },
    ]);
    expect(result.complete).toBe(true);
  });

  it("issues an unnarrowed search rather than failing when the template's extension is not literal", async () => {
    // The final template segment is "{deliverable}", a placeholder rather
    // than a literal suffix, so no filetype narrowing can be derived from it.
    const profile = profileWithRegion({ naming: { ...RAW_PROFILE.naming, template: "{year}-{month:02}_{client}.{deliverable}" } });
    let sentQueryString = "";
    const client = fakeClient({
      scripts: { [ARCHIVE_DRIVE.webUrl!]: page([], false) },
      onSearch: (_scope, body) => {
        const b = body as { requests: Array<{ query: { queryString: string } }> };
        sentQueryString = b.requests[0]?.query.queryString ?? "";
      },
    });

    const result = await crossCheckOtherLibraries(client, profile, [OWN_DRIVE, ARCHIVE_DRIVE], OWN_DRIVE.id);

    expect(sentQueryString).not.toContain("filetype:");
    expect(result.complete).toBe(true);
  });

  it("stays incomplete with page-cap-reached when one library hits the cap, even though another library completed", async () => {
    const cappedDrive: Drive = { id: "drive-capped", name: "Capped", webUrl: "https://contoso.sharepoint.com/sites/Example/Capped" };
    const fullPage = Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) => hit(`f${String(i)}.xlsx`, "drive-capped", `${cappedDrive.webUrl}/f${String(i)}.xlsx`));

    const client = fakeClient({
      scripts: {
        [ARCHIVE_DRIVE.webUrl!]: page([], false),
        [cappedDrive.webUrl!]: () => page(fullPage, true),
      },
    });

    const result = await crossCheckOtherLibraries(
      client,
      profileWithRegion(),
      [OWN_DRIVE, ARCHIVE_DRIVE, cappedDrive],
      OWN_DRIVE.id,
    );

    expect(result.complete).toBe(false);
    expect(result.reason).toBe("page-cap-reached");
    // The completed library's own outcome is not discarded just because a
    // sibling library was incomplete.
    expect(result.files.every((file) => file.library === "Capped")).toBe(true);
    expect(result.files).toHaveLength(SEARCH_PAGE_CAP * SEARCH_PAGE_SIZE);
  });
});
