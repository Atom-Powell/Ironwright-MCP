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

describe("parseArgs display name", () => {
  it("defaults a normal run to the server application's name", () => {
    expect(parseArgs(base).displayName).toBe("Ironwright Repository Reconciliation");
  });

  it("defaults bootstrap mode to a different name, so the two applications are told apart", () => {
    // Two identically named applications, one holding Sites.FullControl.All
    // and one holding Sites.Selected, is how the wrong secret gets rotated or
    // the wrong application revoked.
    const parsed = parseArgs([...base, "--create-bootstrap"]);

    expect(parsed.displayName).toBe("Ironwright Grant Issuer");
    expect(parsed.displayName).not.toBe(parseArgs(base).displayName);
  });

  it("still honors an explicit --name in bootstrap mode", () => {
    expect(parseArgs([...base, "--create-bootstrap", "--name=Contoso Grant Issuer"]).displayName).toBe(
      "Contoso Grant Issuer",
    );
  });
});

