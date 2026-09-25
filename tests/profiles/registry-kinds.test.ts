import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createProfileRegistry } from "../../src/profiles/registry.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";
const compliance = JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown;
const library = { kind: "library", profileId: "shared-docs", identity: { siteUrl: SITE, library: "Shared Documents" } };

describe("profile registry with two kinds", () => {
  const registry = createProfileRegistry(
    [
      { source: "example.json", contents: compliance },
      { source: "shared-docs.json", contents: library },
    ],
    SITE,
  );

  it("lists both kinds", () => {
    expect(registry.ids()).toContain("shared-docs");
  });

  it("returns either kind from getAny", () => {
    expect(registry.getAny("shared-docs").identity.library).toBe("Shared Documents");
  });

  it("still returns a compliance profile from get", () => {
    const id = (compliance as { profileId: string }).profileId;
    expect(registry.get(id).taxonomy.segments.length).toBeGreaterThan(0);
  });
});
