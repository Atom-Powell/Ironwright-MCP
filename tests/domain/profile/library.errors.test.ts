import { describe, expect, it } from "vitest";
import { loadAnyProfile } from "../../../src/domain/profile/library.js";
import { ProfileValidationError } from "../../../src/domain/profile/load.js";

const identity = { siteUrl: "https://contoso.sharepoint.com/sites/Example", library: "Docs" };

describe("loadAnyProfile refusals", () => {
  it("refuses a library profile carrying compliance fields, rather than silently ignoring them", () => {
    expect(() =>
      loadAnyProfile({ kind: "library", profileId: "docs", identity, taxonomy: { segments: ["{year}"] } }),
    ).toThrow(ProfileValidationError);
  });

  it("refuses a library profile with a workbookPath in its identity", () => {
    expect(() =>
      loadAnyProfile({ kind: "library", profileId: "docs", identity: { ...identity, workbookPath: "/x.xlsx" } }),
    ).toThrow(ProfileValidationError);
  });

  it("refuses an unknown kind", () => {
    expect(() => loadAnyProfile({ kind: "archive", profileId: "docs", identity })).toThrow(ProfileValidationError);
  });
});
