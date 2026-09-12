import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_CODE_CLIENT_ID,
  acquireTokenWithRetry,
  describeSignInFailure,
  extractAccessToken,
  once,
  parseArgs,
} from "../../src/setup/cli.js";

const baseArgv = ["node", "main.js", "--tenant=tenant-1", "--site=https://contoso.sharepoint.com/sites/Example"];

describe("parseArgs", () => {
  it("uses the default display name when --name is absent", () => {
    expect(parseArgs(baseArgv).displayName).toBe("Ironwright Repository Reconciliation");
  });

  it("uses a custom display name when --name=<value> is provided", () => {
    const argv = [...baseArgv, "--name=Custom Name"];
    expect(parseArgs(argv).displayName).toBe("Custom Name");
  });

  it("uses Microsoft's Graph Command Line Tools application id by default", () => {
    // Pinned as a literal: this is the Graph Command Line Tools id, not the
    // Azure CLI's, and the two were confused here once already.
    expect(DEFAULT_DEVICE_CODE_CLIENT_ID).toBe("14d82eec-204b-4c2f-b7e8-296a70dab67e");
    expect(parseArgs(baseArgv).clientId).toBe(DEFAULT_DEVICE_CODE_CLIENT_ID);
  });

  it("uses a custom client id when --client-id=<value> is provided", () => {
    const argv = [...baseArgv, "--client-id=my-bootstrap-app"];
    expect(parseArgs(argv).clientId).toBe("my-bootstrap-app");
  });

  it("defaults write to false", () => {
    expect(parseArgs(baseArgv).write).toBe(false);
  });

  it("sets write to true when --write is present", () => {
    expect(parseArgs([...baseArgv, "--write"]).write).toBe(true);
  });

  it("parses the required tenant and site values", () => {
    const parsed = parseArgs(baseArgv);
    expect(parsed.tenantId).toBe("tenant-1");
    expect(parsed.siteUrl).toBe("https://contoso.sharepoint.com/sites/Example");
  });
});

describe("extractAccessToken", () => {
  it("returns the access token on a successful response", () => {
    expect(extractAccessToken(200, JSON.stringify({ access_token: "token-1" }))).toBe("token-1");
  });
});

describe("describeSignInFailure", () => {
  it("points at the --client-id escape hatch without misnaming the default application", () => {
    const message = describeSignInFailure(new Error("Conditional Access blocked this client"));

    expect(message).toContain("--client-id");
    expect(message).toContain("Conditional Access blocked this client");
    expect(message).toContain("Graph Command Line Tools");
    expect(message).not.toContain("Azure CLI");
  });

  it("does not call the sign-in application a bootstrap application", () => {
    // "Bootstrap application" names the grant issuer, a confidential client
    // with no public client flows. An operator who read this message as being
    // about that application would pass IW_BOOTSTRAP_CLIENT_ID to --client-id
    // and get a device-code failure with no obvious cause.
    const message = describeSignInFailure(new Error("Conditional Access blocked this client"));

    expect(message).not.toMatch(/register a bootstrap/i);
    expect(message).toContain("public-client sign-in application");
    expect(message).toContain("not the bootstrap application");
  });
});

describe("acquireTokenWithRetry", () => {
  it("returns the token on the first attempt when nothing is wrong", async () => {
    let attempts = 0;
    const slept: number[] = [];

    const token = await acquireTokenWithRetry(
      async () => {
        attempts += 1;
        return "token-1";
      },
      { sleep: async (ms) => void slept.push(ms) },
    );

    expect(token).toBe("token-1");
    expect(attempts).toBe(1);
    expect(slept).toEqual([]);
  });

  it("retries a secret that has not propagated yet and returns the token", async () => {
    let attempts = 0;
    const slept: number[] = [];

    const token = await acquireTokenWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("client credentials request failed with 401: AADSTS7000215: Invalid client secret.");
        return "token-1";
      },
      { sleep: async (ms) => void slept.push(ms) },
    );

    expect(token).toBe("token-1");
    expect(attempts).toBe(3);
    expect(slept).toEqual([3000, 6000]);
  });

  it("retries a service principal that has not propagated yet", async () => {
    let attempts = 0;

    const token = await acquireTokenWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("AADSTS700016: Application with identifier was not found.");
        return "token-1";
      },
      { sleep: async () => {} },
    );

    expect(token).toBe("token-1");
    expect(attempts).toBe(2);
  });

  it("spends about ten seconds at most on propagation, across three attempts", async () => {
    const slept: number[] = [];

    await expect(
      acquireTokenWithRetry(
        async () => {
          throw new Error("AADSTS7000215: Invalid client secret.");
        },
        { sleep: async (ms) => void slept.push(ms) },
      ),
    ).rejects.toThrow(/AADSTS7000215/);

    expect(slept).toHaveLength(2);
    expect(slept.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(10_000);
  });
});

describe("once", () => {
  it("acquires a value one time and reuses it for every later caller", async () => {
    let acquisitions = 0;
    const acquire = once(async () => {
      acquisitions += 1;
      return `token-${acquisitions}`;
    });

    expect(await acquire()).toBe("token-1");
    expect(await acquire()).toBe("token-1");
    expect(acquisitions).toBe(1);
  });

  it("shares one acquisition between callers that overlap", async () => {
    let acquisitions = 0;
    const acquire = once(async () => {
      acquisitions += 1;
      return "token-1";
    });

    const [first, second] = await Promise.all([acquire(), acquire()]);

    expect(first).toBe("token-1");
    expect(second).toBe("token-1");
    expect(acquisitions).toBe(1);
  });
});
