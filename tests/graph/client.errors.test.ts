import { describe, expect, it } from "vitest";
import { createGraphClient } from "../../src/graph/client.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { defaultRetryPolicy } from "../../src/graph/retry.js";

const TOKEN = { getToken: async () => "token-1" };

describe("createGraphClient failures", () => {
  it("throws a GraphRequestError carrying Graph's own code", async () => {
    const body = JSON.stringify({ error: { code: "resyncRequired", message: "gone" } });
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => new Response(body, { status: 410 })) as typeof fetch,
    });

    await expect(client.get("/drives/d1/root/delta")).rejects.toMatchObject({
      name: "GraphRequestError",
      status: 410,
      code: "resyncRequired",
    });
  });

  it("throws after exhausting retries rather than returning a throttled body", async () => {
    const client = createGraphClient({
      tokenProvider: TOKEN,
      retry: defaultRetryPolicy({ maxAttempts: 3, sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => new Response("{}", { status: 429, headers: { "retry-after": "0" } })) as typeof fetch,
    });

    await expect(client.get("/drives/d1")).rejects.toThrow(GraphRequestError);
    expect(client.requests()).toBe(3);
  });

  it("refuses a 2xx body that is not JSON, because a proxy answered rather than Graph", async () => {
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => new Response("<html>sign in</html>", { status: 200 })) as typeof fetch,
    });

    await expect(client.get("/drives/d1")).rejects.toThrow(/not JSON/);
  });

  it("labels an absolute URL from outside the v1.0 base with the whole URL, not a mis-sliced fragment", async () => {
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    });

    await expect(client.get("https://example.invalid/some/other/endpoint")).rejects.toThrow(
      "https://example.invalid/some/other/endpoint",
    );
  });
});
