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

const libraryExample = () => JSON.parse(readFileSync("examples/profiles/library-example.json", "utf8")) as Record<string, unknown>;

describe("site sets, refused (fix round 1)", () => {
  it("refuses a library profile whose second site carries a workbookPath", () => {
    const input = { ...libraryExample() };
    const identity = input.identity as object;
    delete input.identity;
    input.sites = [identity, { siteUrl: "https://contoso.sharepoint.com/sites/Two", library: "Documents", workbookPath: "/x.xlsx" }];
    expect(() => loadAnyProfile(input)).toThrow(/sites\.1\.workbookPath/);
  });

  it("refuses a library profile whose identity and first site disagree", () => {
    const input = { ...libraryExample() };
    const identity = input.identity as object;
    input.sites = [{ ...identity, siteUrl: "https://contoso.sharepoint.com/sites/Other" }];
    expect(() => loadAnyProfile(input)).toThrow(/identity.*sites\[0\]/);
  });

  it("accepts identity and first site that differ only in key order", () => {
    const input = { ...example() };
    const identity = input.identity as Record<string, unknown>;
    input.sites = [Object.fromEntries(Object.entries(identity).reverse())];
    expect(() => loadAnyProfile(input)).not.toThrow();
  });

  it("refuses a malformed sites beside a valid identity instead of discarding it", () => {
    const input = { ...example(), sites: "x" };
    expect(() => loadAnyProfile(input)).toThrow(/sites/);
  });
});
