import { describe, expect, it } from "vitest";
import { resolveBootstrapCredentials } from "../../src/setup/cli.js";

const base = ["node", "main.js", "--tenant=contoso.onmicrosoft.com", "--site=https://contoso.sharepoint.com/sites/X"];

describe("resolveBootstrapCredentials rejections", () => {
  it("returns undefined when only the id is supplied", () => {
    expect(resolveBootstrapCredentials(base, { IW_BOOTSTRAP_CLIENT_ID: "env-id" })).toBeUndefined();
  });

  it("returns undefined when only the secret is supplied", () => {
    expect(resolveBootstrapCredentials(base, { IW_BOOTSTRAP_CLIENT_SECRET: "env-secret" })).toBeUndefined();
  });

  it("treats an empty environment value as absent", () => {
    expect(
      resolveBootstrapCredentials(base, { IW_BOOTSTRAP_CLIENT_ID: "", IW_BOOTSTRAP_CLIENT_SECRET: "env-secret" }),
    ).toBeUndefined();
  });

  it("treats an empty flag value as absent rather than overriding the environment", () => {
    const argv = [...base, "--bootstrap-client-id="];
    expect(
      resolveBootstrapCredentials(argv, { IW_BOOTSTRAP_CLIENT_ID: "env-id", IW_BOOTSTRAP_CLIENT_SECRET: "s" }),
    ).toEqual({ clientId: "env-id", clientSecret: "s" });
  });
});
