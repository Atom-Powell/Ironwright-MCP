import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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

const SITE_PATH = "/sites/contoso.sharepoint.com:/sites/Example";
const DRIVES_PATH = "/sites/site-1/drives?$select=id,name,webUrl";

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
 */
function fakeClient(args: {
  drives: Drive[];
  scripts: Record<string, SearchScript>;
  onSearch?: (pathScope: string, body: unknown) => void;
}): Pick<GraphClient, "get" | "post"> {
  const callCounts = new Map<string, number>();
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
    const client = fakeClient({ drives: [OWN_DRIVE], scripts: {} });

    const result = await crossCheckOtherLibraries(client, profileWithRegion());

    expect(result).toEqual({ files: [], complete: true });
  });

  it("qualifies a hit from another library with that library's name and a path relative to it", async () => {
    const client = fakeClient({
      drives: [OWN_DRIVE, ARCHIVE_DRIVE],
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

    const result = await crossCheckOtherLibraries(client, profileWithRegion());

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
      drives: [OWN_DRIVE, ARCHIVE_DRIVE],
      scripts: {
        [ARCHIVE_DRIVE.webUrl!]: page([], false),
      },
      onSearch: (scope) => searchedScopes.push(scope),
    });

    const result = await crossCheckOtherLibraries(client, profileWithRegion());

    expect(searchedScopes).toEqual([ARCHIVE_DRIVE.webUrl]);
    expect(searchedScopes).not.toContain(OWN_DRIVE.webUrl);
    expect(result.files).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("issues an unnarrowed search rather than failing when the template's extension is not literal", async () => {
    // The final template segment is "{deliverable}", a placeholder rather
    // than a literal suffix, so no filetype narrowing can be derived from it.
    const profile = profileWithRegion({ naming: { ...RAW_PROFILE.naming, template: "{year}-{month:02}_{client}.{deliverable}" } });
    let sentQueryString = "";
    const client = fakeClient({
      drives: [OWN_DRIVE, ARCHIVE_DRIVE],
      scripts: { [ARCHIVE_DRIVE.webUrl!]: page([], false) },
      onSearch: (_scope, body) => {
        const b = body as { requests: Array<{ query: { queryString: string } }> };
        sentQueryString = b.requests[0]?.query.queryString ?? "";
      },
    });

    const result = await crossCheckOtherLibraries(client, profile);

    expect(sentQueryString).not.toContain("filetype:");
    expect(result.complete).toBe(true);
  });

  it("stays incomplete with page-cap-reached when one library hits the cap, even though another library completed", async () => {
    const cappedDrive: Drive = { id: "drive-capped", name: "Capped", webUrl: "https://contoso.sharepoint.com/sites/Example/Capped" };
    const fullPage = Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) => hit(`f${String(i)}.xlsx`, "drive-capped", `${cappedDrive.webUrl}/f${String(i)}.xlsx`));

    const client = fakeClient({
      drives: [OWN_DRIVE, ARCHIVE_DRIVE, cappedDrive],
      scripts: {
        [ARCHIVE_DRIVE.webUrl!]: page([], false),
        [cappedDrive.webUrl!]: () => page(fullPage, true),
      },
    });

    const result = await crossCheckOtherLibraries(client, profileWithRegion());

    expect(result.complete).toBe(false);
    expect(result.reason).toBe("page-cap-reached");
    // The completed library's own outcome is not discarded just because a
    // sibling library was incomplete.
    expect(result.files.every((file) => file.library === "Capped")).toBe(true);
    expect(result.files).toHaveLength(SEARCH_PAGE_CAP * SEARCH_PAGE_SIZE);
  });
});
