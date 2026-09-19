import { describe, expect, it } from "vitest";
import { deltaPages } from "../../src/graph/delta.js";
import type { GraphClient } from "../../src/graph/client.js";

function fakeClient(responses: Record<string, unknown>, seen: string[] = []): GraphClient {
  return {
    requests: () => seen.length,
    get: async <T,>(path: string): Promise<T> => {
      seen.push(path);
      if (!(path in responses)) throw new Error(`unexpected path ${path}`);
      return responses[path] as T;
    },
    post: async <T,>(): Promise<T> => { throw new Error("this fake does not implement post"); },
    patch: () => Promise.reject(new Error("this fake Graph client does not implement patch")),
    getBytes: async (): Promise<Uint8Array> => { throw new Error("this fake does not implement getBytes"); },
  };
}

describe("deltaPages", () => {
  it("starts at the drive root when there is no stored link, and follows nextLink to the end", async () => {
    const seen: string[] = [];
    const client = fakeClient(
      {
        "/drives/d1/root/delta": {
          value: [{ id: "1" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=p2",
        },
        "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=p2": {
          value: [{ id: "2" }],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=final",
        },
      },
      seen,
    );

    const pages = [];
    for await (const page of deltaPages(client, "d1")) pages.push(page);

    expect(pages.map((page) => page.items.map((item) => item.id))).toEqual([["1"], ["2"]]);
    expect(pages[0]?.deltaLink).toBeUndefined();
    expect(pages[1]?.deltaLink).toBe("https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=final");
    expect(seen).toHaveLength(2);
  });

  it("starts at a stored deltaLink when one is given", async () => {
    const seen: string[] = [];
    const client = fakeClient(
      {
        "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=stored": {
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=next",
        },
      },
      seen,
    );

    const pages = [];
    for await (const page of deltaPages(client, "d1", "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=stored")) {
      pages.push(page);
    }

    expect(seen).toEqual(["https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=stored"]);
    expect(pages[0]?.items).toEqual([]);
  });
});
