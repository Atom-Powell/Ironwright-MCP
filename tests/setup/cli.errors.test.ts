import { describe, expect, it } from "vitest";
import { extractAccessToken, parseArgs } from "../../src/setup/cli.js";

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
