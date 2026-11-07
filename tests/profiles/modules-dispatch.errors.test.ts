import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadAnyProfile } from "../../src/domain/profile/library.js";
import { createProfileRegistry, ProfileRegistryError } from "../../src/profiles/registry.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";
const example = () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;

describe("registry dispatch by kind, refused", () => {
  it("names the configured kinds when a profile declares one no module owns", () => {
    expect(() => createProfileRegistry([{ source: "x.json", contents: { ...example(), kind: "vendor-risk" } }], SITE)).toThrow(
      /kind "vendor-risk".*compliance.*library/,
    );
  });

  it("refuses a profile when any site in its set is not the granted site, naming the index", () => {
    const input = example();
    const identity = input.identity as object;
    delete input.identity;
    input.sites = [identity, { ...identity, siteUrl: "https://contoso.sharepoint.com/sites/Other" }];
    let caught: unknown;
    try {
      createProfileRegistry([{ source: "two.json", contents: input }], SITE);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProfileRegistryError);
    expect((caught as ProfileRegistryError).issues[0]).toMatch(/sites\[1\].*sites\/Other.*grant covers/);
  });

  it("refuses a null kind through both dispatchers, so they agree", () => {
    const input = { ...example(), kind: null };
    expect(() => createProfileRegistry([{ source: "x.json", contents: input }], SITE)).toThrow(/null/);
    expect(() => loadAnyProfile(input)).toThrow(/null/);
  });
});
