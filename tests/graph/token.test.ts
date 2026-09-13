import { describe, expect, it } from "vitest";
import { clientCredentialsTokenProvider } from "../../src/graph/token.js";

const CREDENTIALS = { tenantId: "tenant-1", clientId: "client-1", clientSecret: "secret-1" };

function fakeFetch(tokens: string[], seen: Request[] = []): typeof fetch {
  let index = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seen.push(new Request(input as string, init));
    const token = tokens[index] ?? tokens[tokens.length - 1] ?? "t";
    index += 1;
    return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;
}

describe("clientCredentialsTokenProvider", () => {
  it("requests the Graph .default scope against the tenant's token endpoint", async () => {
    const seen: Request[] = [];
    const provider = clientCredentialsTokenProvider(CREDENTIALS, { fetchImpl: fakeFetch(["first"], seen) });

    expect(await provider.getToken()).toBe("first");
    expect(seen[0]?.url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    expect(await seen[0]?.text()).toContain("scope=https%3A%2F%2Fgraph.microsoft.com%2F.default");
  });

  it("caches until the token is within the skew margin of expiry", async () => {
    const seen: Request[] = [];
    let clock = 0;
    const provider = clientCredentialsTokenProvider(CREDENTIALS, {
      fetchImpl: fakeFetch(["first", "second"], seen),
      now: () => clock,
      skewSeconds: 120,
    });

    expect(await provider.getToken()).toBe("first");
    clock = 3_000_000; // 3000s in: still outside the 3600 - 120 boundary
    expect(await provider.getToken()).toBe("first");
    clock = 3_500_000;
    expect(await provider.getToken()).toBe("second");
    expect(seen).toHaveLength(2);
  });

  it("collapses concurrent cold-start callers into one request", async () => {
    const seen: Request[] = [];
    const provider = clientCredentialsTokenProvider(CREDENTIALS, { fetchImpl: fakeFetch(["only"], seen) });

    const tokens = await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);

    expect(tokens).toEqual(["only", "only", "only"]);
    expect(seen).toHaveLength(1);
  });
});
