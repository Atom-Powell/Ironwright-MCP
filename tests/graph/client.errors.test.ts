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

  it("names the method in a failed POST, not GET", async () => {
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => new Response(JSON.stringify({ error: { code: "itemNotFound" } }), { status: 404 })) as typeof fetch,
    });

    await expect(client.post("/drives/d1/items/i1/workbook/createSession", {})).rejects.toMatchObject({
      name: "GraphRequestError",
      method: "POST",
      status: 404,
    });
  });

  it("does not retry a POST that rejects at the transport, because it may have reached the server", async () => {
    let attempts = 0;
    const client = createGraphClient({
      tokenProvider: TOKEN,
      retry: defaultRetryPolicy({ maxAttempts: 4, sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => {
        attempts += 1;
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });

    await expect(client.post("/drives/d1/items/i1/workbook/createSession", {})).rejects.toThrow(/fetch failed/);
    expect(attempts).toBe(1);
  });

  it("names the method the caller actually used in the non-JSON refusal", async () => {
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => new Response("<html>proxy</html>", { status: 200 })) as typeof fetch,
    });

    await expect(client.post("/drives/d1/items/i1/workbook/createSession", {})).rejects.toThrow(/Graph POST/);
  });

  it("still retries a POST that returns a retriable status", async () => {
    const statuses = [429, 200];
    let call = 0;
    const client = createGraphClient({
      tokenProvider: TOKEN,
      retry: defaultRetryPolicy({ sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => {
        const status = statuses[call] ?? 200;
        call += 1;
        return new Response("{}", { status, headers: status === 429 ? { "retry-after": "0" } : {} });
      }) as typeof fetch,
    });

    await client.post("/drives/d1/items/i1/workbook/createSession", {});

    expect(client.requests()).toBe(2);
  });

  it("refuses to let a per-call header shadow the bearer token", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await client.get("/drives/d1", { authorization: "Bearer attacker", accept: "text/html" });

    // The failure this pins is silent: a shadowed bearer token surfaces as a
    // 401 that names no cause, and reads as an expired credential rather than
    // as a caller passing the wrong header.
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(seen[0]?.headers.get("accept")).toBe("application/json");
  });
});
