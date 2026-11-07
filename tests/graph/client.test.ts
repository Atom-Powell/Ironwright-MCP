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
        return new Response(JSON.stringify({ id: "copy-job-1" }), { status: 200 });
      }) as typeof fetch,
    });

    const value = await client.post<{ id: string }>("/drives/d1/items/i1/copy", {
      name: "renamed.txt",
    });

    expect(value.id).toBe("copy-job-1");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    await expect(seen[0]?.text()).resolves.toBe(JSON.stringify({ name: "renamed.txt" }));
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

    await client.get("/drives/d1/items/i1/thumbnails", { "x-test-trace-id": "trace-1" });

    expect(seen[0]?.headers.get("x-test-trace-id")).toBe("trace-1");
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

    await client.post("/drives/d1/items/i1/checkin", undefined, { "x-test-trace-id": "trace-1" });

    expect(seen[0]?.headers.get("content-type")).toBeNull();
  });

  it("sends a PATCH with a JSON body and the caller's if-match header", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response(JSON.stringify({ id: "i1", eTag: '"{GUID},2"' }), { status: 200 });
      }) as typeof fetch,
    });

    const result = await client.patch<{ eTag: string }>(
      "/drives/d1/root:/a.xlsx:",
      { name: "b.xlsx" },
      { "if-match": '"{GUID},1"' },
    );

    expect(result.eTag).toBe('"{GUID},2"');
    expect(seen[0]?.method).toBe("PATCH");
    await expect(seen[0]?.text()).resolves.toBe(JSON.stringify({ name: "b.xlsx" }));
    expect(seen[0]?.headers.get("if-match")).toBe('"{GUID},1"');
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
  });

  it("does not replay a PATCH that rejected at the transport, since the mutation may already have applied", async () => {
    let attempts = 0;
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => {
        attempts += 1;
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
    });

    await expect(client.patch("/drives/d1/root:/a.xlsx:", { name: "b.xlsx" })).rejects.toThrow("network down");
    expect(attempts).toBe(1);
  });
});

describe("createGraphClient putBytes", () => {
  it("sends the bytes as they are with the caller's content type and keeps a caller header", async () => {
    const bytes = new Uint8Array([35, 32, 112, 114, 111, 98, 101, 10]);
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push({ url: input as string, init });
        return new Response(JSON.stringify({ id: "i1", eTag: "<etag-3>" }), { status: 200 });
      }) as typeof fetch,
    });

    const value = await client.putBytes<{ id: string }>("/drives/d1/root:/a.md:/content", bytes, "text/markdown", { "if-match": "<etag-3>" });

    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(value.id).toBe("i1");
    expect(seen[0]?.url).toBe("https://graph.microsoft.com/v1.0/drives/d1/root:/a.md:/content");
    expect(seen[0]?.init?.method).toBe("PUT");
    expect(seen[0]?.init?.body).toBe(bytes);
    expect(headers["content-type"]).toBe("text/markdown");
    expect(headers.accept).toBe("application/json");
    expect(headers.authorization).toBe("Bearer token-1");
    expect(headers["if-match"]).toBe("<etag-3>");
  });
});
