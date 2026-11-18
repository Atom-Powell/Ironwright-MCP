import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createProfileRegistry, ProfileRegistryError, loadAnyProfile } from "../../src/profiles/registry.js";

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

  it("loads profiles on different sites when each site is among those granted", () => {
    const other = "https://contoso.sharepoint.com/sites/ServiceDesk";
    const second = { ...example(), profileId: "desk", identity: { ...(example().identity as object), siteUrl: other } };

    const registry = createProfileRegistry(
      [
        { source: "one.json", contents: example() },
        { source: "two.json", contents: second },
      ],
      [SITE, other],
    );

    expect(registry.ids().sort()).toEqual(["desk", (example() as { profileId: string }).profileId].sort());
  });

  it("refuses a profile on a site that is not among those granted, naming every granted site", () => {
    const other = "https://contoso.sharepoint.com/sites/ServiceDesk";
    const stray = { ...example(), identity: { ...(example().identity as object), siteUrl: "https://contoso.sharepoint.com/sites/Elsewhere" } };
    let caught: unknown;
    try {
      createProfileRegistry([{ source: "stray.json", contents: stray }], [SITE, other]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProfileRegistryError);
    expect((caught as ProfileRegistryError).issues[0]).toMatch(/sites\/Elsewhere.*grant covers .*sites\/Example and .*sites\/ServiceDesk/);
  });

  it("names three granted sites as a list, not as a chain of and", () => {
    const desk = "https://contoso.sharepoint.com/sites/ServiceDesk";
    const success = "https://contoso.sharepoint.com/sites/TechnologySuccess";
    const stray = { ...example(), identity: { ...(example().identity as object), siteUrl: "https://contoso.sharepoint.com/sites/Elsewhere" } };
    let caught: unknown;
    try {
      createProfileRegistry([{ source: "stray.json", contents: stray }], [SITE, desk, success]);
    } catch (error) {
      caught = error;
    }
    expect((caught as ProfileRegistryError).issues[0]).toContain(`grant covers ${SITE}, ${desk} and ${success}.`);
  });

  it("refuses a null kind, at the registry and at the loader the registry calls", () => {
    const input = { ...example(), kind: null };
    expect(() => createProfileRegistry([{ source: "x.json", contents: input }], SITE)).toThrow(/null/);
    expect(() => loadAnyProfile(input)).toThrow(/null/);
  });
});
