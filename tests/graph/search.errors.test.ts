import { describe, expect, it } from "vitest";
import { searchDriveItems, SEARCH_PAGE_CAP, SEARCH_PAGE_SIZE } from "../../src/graph/search.js";

describe("searchDriveItems limits and failures", () => {
  it("reports incomplete rather than truncating silently when the cap is reached", async () => {
    let call = 0;
    const client = {
      post: (async () => {
        call += 1;
        return {
          value: [{ hitsContainers: [{
            hits: Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) => ({
              resource: {
                name: `f${String(i)}.xlsx`,
                webUrl: "https://x/Archive/f.xlsx",
                size: 1,
                lastModifiedDateTime: "2026-01-01T00:00:00Z",
                parentReference: { driveId: "drive-archive" },
              },
            })),
            moreResultsAvailable: true,
          }] }],
        };
      }) as never,
    };

    const result = await searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive" });

    // The cap is a refusal to claim completeness, not a quiet truncation.
    expect(call).toBe(SEARCH_PAGE_CAP);
    expect(result.complete).toBe(false);
    expect(result.hits).toHaveLength(SEARCH_PAGE_CAP * SEARCH_PAGE_SIZE);
  });

  it("propagates a failure rather than returning a partial success", async () => {
    const client = { post: (async () => { throw new Error("search exploded"); }) as never };
    await expect(searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive" })).rejects.toThrow(/search exploded/);
  });

  it("treats a response with no hits container as an empty complete result", async () => {
    const client = { post: (async () => ({ value: [] })) as never };
    const result = await searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive" });
    expect(result).toEqual({ hits: [], complete: true });
  });
});
