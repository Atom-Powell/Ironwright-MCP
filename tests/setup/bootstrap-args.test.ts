import { describe, expect, it } from "vitest";
import { parseArgs, resolveBootstrapCredentials } from "../../src/setup/cli.js";

const base = ["node", "main.js", "--tenant=contoso.onmicrosoft.com", "--site=https://contoso.sharepoint.com/sites/X"];

describe("resolveBootstrapCredentials", () => {
  it("reads the environment when no flags are given", () => {
    expect(
      resolveBootstrapCredentials(base, { IW_BOOTSTRAP_CLIENT_ID: "env-id", IW_BOOTSTRAP_CLIENT_SECRET: "env-secret" }),
    ).toEqual({ clientId: "env-id", clientSecret: "env-secret" });
  });

  it("prefers explicit flags over the environment", () => {
    const argv = [...base, "--bootstrap-client-id=flag-id", "--bootstrap-client-secret=flag-secret"];
    expect(
      resolveBootstrapCredentials(argv, { IW_BOOTSTRAP_CLIENT_ID: "env-id", IW_BOOTSTRAP_CLIENT_SECRET: "env-secret" }),
    ).toEqual({ clientId: "flag-id", clientSecret: "flag-secret" });
  });

  it("returns undefined when neither source supplies anything", () => {
    expect(resolveBootstrapCredentials(base, {})).toBeUndefined();
  });

  it("prefers an explicit flag even when the environment variable is empty", () => {
    const argv = [...base, "--bootstrap-client-id=flag-id", "--bootstrap-client-secret=flag-secret"];
    expect(
      resolveBootstrapCredentials(argv, { IW_BOOTSTRAP_CLIENT_ID: "", IW_BOOTSTRAP_CLIENT_SECRET: "" }),
    ).toEqual({ clientId: "flag-id", clientSecret: "flag-secret" });
  });
});

describe("parseArgs bootstrap mode", () => {
  it("defaults createBootstrap to false", () => {
    expect(parseArgs(base).createBootstrap).toBe(false);
  });

  it("sets createBootstrap when the flag is present", () => {
    expect(parseArgs([...base, "--create-bootstrap"]).createBootstrap).toBe(true);
  });

  it("does not require a site when creating the bootstrap application", () => {
    const argv = ["node", "main.js", "--tenant=contoso.onmicrosoft.com", "--create-bootstrap"];
    expect(() => parseArgs(argv)).not.toThrow();
  });
});
