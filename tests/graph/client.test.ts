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
});
