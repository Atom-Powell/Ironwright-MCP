import { describe, expect, it } from "vitest";
import { createGraphClient } from "../../src/graph/client.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { defaultRetryPolicy } from "../../src/graph/retry.js";
import { TokenRequestError } from "../../src/graph/token.js";

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

  it("retries a thrown transport rejection and succeeds once the connection recovers", async () => {
    // A DNS failure, a socket reset, or a TLS error makes fetch reject rather
    // than resolve with a status. A couple of hundred sequential requests over
    // a real library makes one of these likely, and it must not throw the
    // whole run away.
    let calls = 0;
    const client = createGraphClient({
      tokenProvider: TOKEN,
      retry: defaultRetryPolicy({ maxAttempts: 3, sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => {
        calls += 1;
        if (calls < 2) throw new TypeError("fetch failed: socket hang up");
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await expect(client.get("/drives/d1")).resolves.toEqual({});
    expect(calls).toBe(2);
    expect(client.requests()).toBe(2);
  });

  it("surfaces the original transport rejection once retries are exhausted", async () => {
    const original = new TypeError("fetch failed: socket hang up");
    const client = createGraphClient({
      tokenProvider: TOKEN,
      retry: defaultRetryPolicy({ maxAttempts: 2, sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => {
        throw original;
      }) as typeof fetch,
    });

    await expect(client.get("/drives/d1")).rejects.toBe(original);
  });

  it("does not retry a GraphRequestError, since its status is already a decided outcome", async () => {
    let calls = 0;
    const client = createGraphClient({
      tokenProvider: TOKEN,
      retry: defaultRetryPolicy({ maxAttempts: 3, sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: "itemNotFound" } }), { status: 404 });
      }) as typeof fetch,
    });

    await expect(client.get("/drives/d1")).rejects.toThrow(GraphRequestError);
    expect(calls).toBe(1);
  });

  it("does not retry a 401 from the token endpoint, which a second attempt cannot fix", async () => {
    const tokenFailure = { getToken: async () => { throw new TokenRequestError({ status: 401, body: "invalid_client" }); } };
    let fetchCalls = 0;
    const client = createGraphClient({
      tokenProvider: tokenFailure,
      retry: defaultRetryPolicy({ maxAttempts: 3, sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await expect(client.get("/drives/d1")).rejects.toThrow(TokenRequestError);
    expect(fetchCalls).toBe(0);
  });
});
