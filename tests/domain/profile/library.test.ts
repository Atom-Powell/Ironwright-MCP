import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isLibraryProfile, loadAnyProfile } from "../../../src/domain/profile/library.js";

const example = JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown;

describe("loadAnyProfile", () => {
  it("loads a library profile carrying identity only", () => {
    const profile = loadAnyProfile({
      kind: "library",
      profileId: "shared-docs",
      identity: { siteUrl: "https://contoso.sharepoint.com/sites/Example", library: "Shared Documents" },
    });

    expect(isLibraryProfile(profile)).toBe(true);
    expect(profile.identity.library).toBe("Shared Documents");
  });

  it("loads an existing profile with no kind as a compliance profile, unchanged", () => {
    const profile = loadAnyProfile(example);

    expect(isLibraryProfile(profile)).toBe(false);
    expect(profile.profileId).toBe((example as { profileId: string }).profileId);
  });

  it("accepts an explicit compliance kind", () => {
    expect(isLibraryProfile(loadAnyProfile({ ...(example as object), kind: "compliance" }))).toBe(false);
  });

  it("loads the committed library example", () => {
    const profile = loadAnyProfile(JSON.parse(readFileSync("examples/profiles/library-example.json", "utf8")));
    expect(isLibraryProfile(profile)).toBe(true);
  });
});
