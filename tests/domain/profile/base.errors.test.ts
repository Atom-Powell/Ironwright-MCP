import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadAnyProfile } from "../../../src/domain/profile/library.js";
import { ProfileValidationError } from "../../../src/domain/profile/load.js";

const example = () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;

describe("site sets, refused", () => {
  it("refuses a profile whose identity and first site disagree, naming both", () => {
    const input = { ...example() };
    const identity = input.identity as { siteUrl: string };
    input.sites = [{ ...identity, siteUrl: "https://contoso.sharepoint.com/sites/Other" }];
    expect(() => loadAnyProfile(input)).toThrow(ProfileValidationError);
    expect(() => loadAnyProfile(input)).toThrow(/identity.*sites\[0\]/);
  });

  it("refuses an empty sites list", () => {
    const input = { ...example() };
    delete input.identity;
    input.sites = [];
    expect(() => loadAnyProfile(input)).toThrow(/sites/);
  });

  it("refuses a compliance profile whose second site has no workbookPath", () => {
    const input = { ...example() };
    const identity = input.identity as { siteUrl: string; library: string; workbookPath: string };
    delete input.identity;
    input.sites = [identity, { siteUrl: "https://contoso.sharepoint.com/sites/Two", library: identity.library }];
    expect(() => loadAnyProfile(input)).toThrow(/sites\.1\.workbookPath/);
  });
});
