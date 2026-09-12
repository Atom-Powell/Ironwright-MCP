import { describe, expect, it } from "vitest";
import { acquireTokenWithRetry, describeSetupFailure, extractAccessToken, parseArgs } from "../../src/setup/cli.js";
import { GraphRequestError } from "../../src/setup/graph-error.js";
import { SetupFailedError } from "../../src/setup/run.js";

const baseArgv = ["node", "main.js", "--tenant=tenant-1", "--site=https://contoso.sharepoint.com/sites/Example"];

describe("parseArgs failures", () => {
  it("rejects a missing --tenant", () => {
    const argv = baseArgv.filter((arg) => !arg.startsWith("--tenant="));
    expect(() => parseArgs(argv)).toThrow(/missing required argument --tenant=<value>/);
  });

  it("rejects a missing --site", () => {
    const argv = baseArgv.filter((arg) => !arg.startsWith("--site="));
    expect(() => parseArgs(argv)).toThrow(/missing required argument --site=<value>/);
  });

  it("rejects an empty --tenant= with the same message as a missing one", () => {
    const argv = ["node", "main.js", "--tenant=", "--site=https://contoso.sharepoint.com/sites/Example"];
    expect(() => parseArgs(argv)).toThrow(/missing required argument --tenant=<value>/);
  });

  it("rejects an empty --site= with the same message as a missing one", () => {
    const argv = ["node", "main.js", "--tenant=tenant-1", "--site="];
    expect(() => parseArgs(argv)).toThrow(/missing required argument --site=<value>/);
  });
});

describe("extractAccessToken failures", () => {
  it("surfaces error_description when Entra returns one", () => {
    const body = JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret." });
    expect(() => extractAccessToken(401, body)).toThrow(/AADSTS7000215: Invalid client secret\./);
  });

  it("keeps the raw response text available when there is no error_description", () => {
    expect(() => extractAccessToken(400, "not json")).toThrow(/not json/);
  });

  it("fails rather than returning undefined when the response has no access_token", () => {
    expect(() => extractAccessToken(200, JSON.stringify({}))).toThrow(/200/);
  });
});

describe("acquireTokenWithRetry failures", () => {
  it("does not retry a failure that is not a propagation delay", async () => {
    let attempts = 0;

    await expect(
      acquireTokenWithRetry(
        async () => {
          attempts += 1;
          throw new Error("client credentials request failed with 400: AADSTS90002: Tenant not found.");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/AADSTS90002/);

    expect(attempts).toBe(1);
  });

  it("gives up rather than retrying a genuinely wrong secret forever", async () => {
    let attempts = 0;

    await expect(
      acquireTokenWithRetry(
        async () => {
          attempts += 1;
          throw new Error("AADSTS7000215: Invalid client secret.");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/AADSTS7000215/);

    expect(attempts).toBe(3);
  });
});

describe("describeSetupFailure", () => {
  it("reports a verification failure as the setup failing, with its own message", () => {
    const message = describeSetupFailure(
      new SetupFailedError({ ok: false, reason: "grant-missing", message: "the per-site grant is missing" }),
    );

    expect(message).toContain("Setup failed");
    expect(message).toContain("the per-site grant is missing");
  });

  it("names the directory role behind a refused app registration", () => {
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "POST",
        path: "/applications",
        status: 403,
        body: '{"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges."}}',
      }),
    );

    expect(message).toContain("403");
    expect(message).toContain("Authorization_RequestDenied");
    expect(message).toContain("Application Administrator");
  });

  it("names the different directory role behind a refused admin consent", () => {
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "POST",
        path: "/servicePrincipals/graph-sp-1/appRoleAssignedTo",
        status: 403,
        body: '{"error":{"code":"Authorization_RequestDenied"}}',
      }),
    );

    expect(message).toContain("Privileged Role Administrator");
    expect(message).toContain("admin consent");
  });

  it("names throttling as worth retrying", () => {
    const message = describeSetupFailure(
      new GraphRequestError({ method: "POST", path: "/applications", status: 429, body: "throttled" }),
    );

    expect(message).toContain("retry");
  });

  it("still reports a failure that is not a Graph call at all", () => {
    const message = describeSetupFailure(new Error("missing required argument --tenant=<value>"));

    expect(message).toContain("Setup failed");
    expect(message).toContain("missing required argument --tenant=<value>");
  });

  it("never carries a stack trace into its output", () => {
    const error = new Error("something broke");
    const message = describeSetupFailure(error);

    expect(error.stack).toBeDefined();
    expect(message).not.toMatch(/\bat\s+\S+\s+\(.*:\d+:\d+\)/);
    expect(message).not.toContain("node_modules");
  });
});
