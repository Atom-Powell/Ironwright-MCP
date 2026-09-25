import { describe, expect, it } from "vitest";
import { createProfileRegistry, LibraryProfileError, ProfileRegistryError } from "../../src/profiles/registry.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";

describe("profile registry refusals for library profiles", () => {
  it("refuses a library profile through get, naming it and why", () => {
    const registry = createProfileRegistry(
      [{ source: "d.json", contents: { kind: "library", profileId: "docs", identity: { siteUrl: SITE, library: "Docs" } } }],
      SITE,
    );

    expect(() => registry.get("docs")).toThrow(LibraryProfileError);
    expect(() => registry.get("docs")).toThrow(/library-only/);
  });

  it("applies the granted-site check to a library profile too", () => {
    expect(() =>
      createProfileRegistry(
        [
          {
            source: "d.json",
            contents: { kind: "library", profileId: "docs", identity: { siteUrl: "https://contoso.sharepoint.com/sites/Other", library: "Docs" } },
          },
        ],
        SITE,
      ),
    ).toThrow(ProfileRegistryError);
  });
});
