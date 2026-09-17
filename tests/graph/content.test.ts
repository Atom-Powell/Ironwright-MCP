import { describe, expect, it } from "vitest";
import { createGraphClient } from "../../src/graph/client.js";
import { downloadDriveItem } from "../../src/graph/content.js";

const tokenProvider = { getToken: async (): Promise<string> => "test-token" };

describe("downloadDriveItem", () => {
  it("follows the content redirect and drops the bearer token on the second request", async () => {
    const seen: Array<{ url: string; authorization: string | undefined }> = [];
    const client = createGraphClient({
      tokenProvider,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        seen.push({ url, authorization: headers.get("authorization") ?? undefined });
        if (url.includes("graph.microsoft.com")) {
          return new Response(null, { status: 302, headers: { location: "https://storage.example/blob" } });
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }) as typeof fetch,
    });

    const bytes = await downloadDriveItem(client, { driveId: "d1", workbookPath: "/Trackers/Book.xlsx" });

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.authorization).toBe("Bearer test-token");
    // The whole reason this function follows the redirect itself.
    expect(seen[1]?.authorization).toBeUndefined();
    expect(client.requests()).toBe(2);
  });
});
