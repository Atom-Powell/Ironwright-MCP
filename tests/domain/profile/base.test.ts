import { describe, expect, it } from "vitest";
import { normalizeProfileSites, SiteEntrySchema } from "../../../src/domain/profile/base.js";
import { loadAnyProfile } from "../../../src/domain/profile/library.js";
import { readFileSync } from "node:fs";

const example = () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;
const libraryExample = () => JSON.parse(readFileSync("examples/profiles/library-example.json", "utf8")) as Record<string, unknown>;

describe("normalizeProfileSites", () => {
  it("turns a legacy identity into a one-entry sites list and keeps identity", () => {
    const out = normalizeProfileSites(example()) as { identity: unknown; sites: unknown[] };
    expect(out.sites).toEqual([out.identity]);
  });

  it("derives identity from the first site when only sites is given", () => {
    const input = { ...example() };
    const identity = input.identity;
    delete input.identity;
    input.sites = [identity, { ...(identity as object), siteUrl: "https://contoso.sharepoint.com/sites/Second" }];
    const out = normalizeProfileSites(input) as { identity: unknown; sites: unknown[] };
    expect(out.identity).toEqual(identity);
    expect(out.sites).toHaveLength(2);
  });

  it("leaves a non-object alone for the schema to reject", () => {
    expect(normalizeProfileSites("nope")).toBe("nope");
  });
});

describe("profiles with sites", () => {
  it("a compliance profile written with sites loads, and identity is its first site", () => {
    const input = { ...example() };
    const identity = input.identity;
    delete input.identity;
    input.sites = [identity];
    const profile = loadAnyProfile(input);
    expect(profile.identity).toEqual(identity);
    expect((profile as { sites: unknown[] }).sites).toEqual([identity]);
  });

  it("a library profile written with two sites loads with both", () => {
    const input = { ...libraryExample() };
    const identity = input.identity as { siteUrl: string; library: string };
    delete input.identity;
    input.sites = [identity, { siteUrl: "https://contoso.sharepoint.com/sites/Two", library: "Documents", clientId: "24001.10" }];
    const profile = loadAnyProfile(input) as { sites: Array<{ clientId?: string }> };
    expect(profile.sites).toHaveLength(2);
    expect(profile.sites[1]!.clientId).toBe("24001.10");
  });

  it("the two example profiles load exactly as before, with a one-entry sites list added", () => {
    for (const input of [example(), libraryExample()]) {
      const profile = loadAnyProfile(input) as { identity: unknown; sites: unknown[] };
      expect(profile.sites).toEqual([profile.identity]);
    }
  });

  it("a site entry accepts an optional clientId and searchRegion", () => {
    expect(SiteEntrySchema.safeParse({ siteUrl: "https://c.sharepoint.com/sites/A", library: "Docs", clientId: "1", searchRegion: "NAM" }).success).toBe(true);
  });
});
