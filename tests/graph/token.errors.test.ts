import { describe, expect, it } from "vitest";
import { clientCredentialsTokenProvider, TokenRequestError } from "../../src/graph/token.js";

const CREDENTIALS = { tenantId: "tenant-1", clientId: "client-1", clientSecret: "secret-1" };

describe("clientCredentialsTokenProvider failures", () => {
  it("names the credential rather than the site, and never echoes the secret", async () => {
    const body = JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000215" });
    const provider = clientCredentialsTokenProvider(CREDENTIALS, {
      fetchImpl: (async () => new Response(body, { status: 401 })) as typeof fetch,
    });

    await expect(provider.getToken()).rejects.toThrow(TokenRequestError);
    await expect(provider.getToken()).rejects.toThrow(/client id and secret/i);
    await expect(provider.getToken()).rejects.not.toThrow(/secret-1/);
  });

  it("does not cache a failure, so a transient outage does not poison the process", async () => {
    let calls = 0;
    const provider = clientCredentialsTokenProvider(CREDENTIALS, {
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1
          ? new Response("{}", { status: 503 })
          : new Response(JSON.stringify({ access_token: "later", expires_in: 3600 }), { status: 200 });
      }) as typeof fetch,
    });

    await expect(provider.getToken()).rejects.toThrow(TokenRequestError);
    expect(await provider.getToken()).toBe("later");
  });

  it("refuses a 200 whose body carries no access token", async () => {
    const provider = clientCredentialsTokenProvider(CREDENTIALS, {
      fetchImpl: (async () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 })) as typeof fetch,
    });

    await expect(provider.getToken()).rejects.toThrow(/no access_token/i);
  });
});
