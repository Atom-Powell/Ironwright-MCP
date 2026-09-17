import { describe, expect, it } from "vitest";
import { searchDriveItems, SEARCH_PAGE_SIZE } from "../../src/graph/search.js";

function hit(name: string): unknown {
  return {
    resource: {
      name,
      webUrl: `https://contoso.sharepoint.com/sites/Example/Archive/${name}`,
      size: 10,
      lastModifiedDateTime: "2026-01-01T00:00:00Z",
      parentReference: { driveId: "drive-archive" },
    },
  };
}

function page(hits: unknown[], more: boolean): unknown {
  return { value: [{ hitsContainers: [{ hits, moreResultsAvailable: more }] }] };
}

describe("searchDriveItems", () => {
  it("sends the region and a path scope, and returns the hits", async () => {
    const bodies: unknown[] = [];
    const client = {
      post: (async (_path: string, body?: unknown) => {
        bodies.push(body);
        return page([hit("a.xlsx")], false);
      }) as never,
    };

    const result = await searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive" });

    expect(result.complete).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.name).toBe("a.xlsx");
    expect(result.hits[0]?.driveId).toBe("drive-archive");
    const sent = bodies[0] as { requests: Array<{ region: string; query: { queryString: string }; size: number }> };
    expect(sent.requests[0]?.region).toBe("NAM");
    expect(sent.requests[0]?.query.queryString).toContain('path:"https://x/Archive"');
    expect(sent.requests[0]?.size).toBe(SEARCH_PAGE_SIZE);
  });

  it("narrows by file extension when one is given", async () => {
    const bodies: unknown[] = [];
    const client = {
      post: (async (_p: string, body?: unknown) => { bodies.push(body); return page([], false); }) as never,
    };

    await searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive", extension: "xlsx" });

    const sent = bodies[0] as { requests: Array<{ query: { queryString: string } }> };
    expect(sent.requests[0]?.query.queryString).toContain("filetype:xlsx");
  });

  it("pages until the results run out", async () => {
    let call = 0;
    const client = {
      post: (async () => {
        call += 1;
        return call === 1 ? page(Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) => hit(`a${String(i)}.xlsx`)), true)
                          : page([hit("last.xlsx")], false);
      }) as never,
    };

    const result = await searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive" });

    expect(call).toBe(2);
    expect(result.hits).toHaveLength(SEARCH_PAGE_SIZE + 1);
    expect(result.complete).toBe(true);
  });

  it("skips a hit missing a driveId, a name or a webUrl rather than inventing one", async () => {
    const missingDriveId = {
      resource: {
        name: "no-drive.xlsx",
        webUrl: "https://contoso.sharepoint.com/sites/Example/Archive/no-drive.xlsx",
        size: 5,
        lastModifiedDateTime: "2026-01-01T00:00:00Z",
      },
    };
    const missingName = {
      resource: {
        webUrl: "https://contoso.sharepoint.com/sites/Example/Archive/no-name.xlsx",
        size: 5,
        lastModifiedDateTime: "2026-01-01T00:00:00Z",
        parentReference: { driveId: "drive-archive" },
      },
    };
    const missingWebUrl = {
      resource: {
        name: "no-weburl.xlsx",
        size: 5,
        lastModifiedDateTime: "2026-01-01T00:00:00Z",
        parentReference: { driveId: "drive-archive" },
      },
    };
    const client = {
      post: (async () => page([missingDriveId, missingName, missingWebUrl, hit("good.xlsx")], false)) as never,
    };

    const result = await searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive" });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.name).toBe("good.xlsx");
  });

  it("carries a hit with no size or no lastModifiedDateTime as present with the field absent", async () => {
    const missingSize = {
      resource: {
        name: "no-size.xlsx",
        webUrl: "https://contoso.sharepoint.com/sites/Example/Archive/no-size.xlsx",
        lastModifiedDateTime: "2026-01-01T00:00:00Z",
        parentReference: { driveId: "drive-archive" },
      },
    };
    const missingLastModified = {
      resource: {
        name: "no-last-modified.xlsx",
        webUrl: "https://contoso.sharepoint.com/sites/Example/Archive/no-last-modified.xlsx",
        size: 5,
        parentReference: { driveId: "drive-archive" },
      },
    };
    const client = {
      post: (async () => page([missingSize, missingLastModified], false)) as never,
    };

    const result = await searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive" });

    expect(result.hits).toHaveLength(2);
    // Not skipped: name, webUrl and driveId all identify the hit.
    expect(result.hits[0]?.name).toBe("no-size.xlsx");
    // Not defaulted to 0 or "": the field is simply absent from the object.
    expect(result.hits[0]?.size).toBeUndefined();
    expect("size" in (result.hits[0] ?? {})).toBe(false);
    expect(result.hits[1]?.name).toBe("no-last-modified.xlsx");
    expect(result.hits[1]?.lastModified).toBeUndefined();
    expect("lastModified" in (result.hits[1] ?? {})).toBe(false);
  });
});
