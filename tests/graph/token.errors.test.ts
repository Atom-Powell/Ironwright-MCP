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

  it("stops waiting for a token endpoint that never answers, and asks afresh on the next call", async () => {
    let calls = 0;
    // Answers nothing until its signal aborts, as a connection that was accepted and then went quiet does.
    const hung = ((_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(new Response(JSON.stringify({ access_token: "later", expires_in: 3600 }), { status: 200 }));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      });
    }) as typeof fetch;
    const provider = clientCredentialsTokenProvider(CREDENTIALS, { fetchImpl: hung, requestTimeoutMs: 20 });

    await expect(provider.getToken()).rejects.toThrow("The token endpoint did not answer within 20 ms.");
    // The request that ran out is gone, so a later caller does not queue behind it.
    expect(await provider.getToken()).toBe("later");
    expect(calls).toBe(2);
  });
});
