import { describe, expect, it } from "vitest";
import { createGraphClient } from "../../src/graph/client.js";
import { defaultRetryPolicy } from "../../src/graph/retry.js";

const TOKEN = { getToken: async () => "token-1" };

describe("createGraphClient", () => {
  it("prefixes a relative path with the v1.0 base and sends the bearer token", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response(JSON.stringify({ id: "d1" }), { status: 200 });
      }) as typeof fetch,
    });

    const value = await client.get<{ id: string }>("/drives/d1");

    expect(value.id).toBe("d1");
    expect(seen[0]?.url).toBe("https://graph.microsoft.com/v1.0/drives/d1");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer token-1");
  });

  it("uses an absolute URL as given, which is how a deltaLink is followed", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await client.get("https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=abc");

    expect(seen[0]?.url).toBe("https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=abc");
  });

  it("retries a 429 and counts every request it made", async () => {
    const statuses = [429, 200];
    let call = 0;
    const client = createGraphClient({
      tokenProvider: TOKEN,
      retry: defaultRetryPolicy({ sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => {
        const status = statuses[call] ?? 200;
        call += 1;
        return new Response("{}", { status, headers: status === 429 ? { "retry-after": "1" } : {} });
      }) as typeof fetch,
    });

    await client.get("/drives/d1");

    expect(client.requests()).toBe(2);
  });

  it("sends a POST with a JSON body and the bearer token", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response(JSON.stringify({ id: "session-1" }), { status: 200 });
      }) as typeof fetch,
    });

    const value = await client.post<{ id: string }>("/drives/d1/items/i1/workbook/createSession", {
      persistChanges: false,
    });

    expect(value.id).toBe("session-1");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    await expect(seen[0]?.text()).resolves.toBe(JSON.stringify({ persistChanges: false }));
  });

  it("sends per-call headers alongside the ones it always sets", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await client.get("/drives/d1/items/i1/workbook/tables/T/range", { "workbook-session-id": "s-1" });

    expect(seen[0]?.headers.get("workbook-session-id")).toBe("s-1");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer token-1");
  });

  it("gets bytes without asking for a JSON accept header", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
      }) as typeof fetch,
    });

    const bytes = await client.getBytes("/drives/d1/items/i1/content");

    expect(Array.from(bytes)).toEqual([9, 8, 7]);
    expect(seen[0]?.url).toBe("https://graph.microsoft.com/v1.0/drives/d1/items/i1/content");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(seen[0]?.headers.get("accept")).toBeNull();
  });

  it("retries a 429 on getBytes and counts every request through the same counter", async () => {
    const statuses = [429, 200];
    let call = 0;
    const client = createGraphClient({
      tokenProvider: TOKEN,
      retry: defaultRetryPolicy({ sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => {
        const status = statuses[call] ?? 200;
        call += 1;
        return new Response(new Uint8Array([1]), {
          status,
          headers: status === 429 ? { "retry-after": "0" } : {},
        });
      }) as typeof fetch,
    });

    await client.getBytes("/drives/d1/items/i1/content");

    expect(client.requests()).toBe(2);
  });

  it("omits a body and its content type when a POST has none", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        // A 204 is a null-body status: the Fetch spec throws a TypeError if the
        // Response constructor is given a non-null body (even "") alongside it.
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });

    await client.post("/drives/d1/items/i1/workbook/closeSession", undefined, { "workbook-session-id": "s-1" });

    expect(seen[0]?.headers.get("content-type")).toBeNull();
  });
});
