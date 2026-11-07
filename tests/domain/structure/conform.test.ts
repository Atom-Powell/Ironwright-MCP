import { describe, expect, it } from "vitest";
import { buildTaxonomyMatcher } from "../../../src/domain/structure/conform.js";
import type { Profile } from "../../../src/domain/profile/schema.js";

// Deliverable id and token differ deliberately, following the convention in
// tests/domain/reconcile/match.test.ts: a matcher that accidentally matched
// on the id instead of the token would be caught by a mismatched path rather
// than passing by coincidence.
function buildProfile(): Profile {
  return {
    profileId: "example",
    identity: {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      library: "Compliance Reports",
      workbookPath: "/Trackers/Tracker.xlsx",
    },
    sites: [{
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      library: "Compliance Reports",
      workbookPath: "/Trackers/Tracker.xlsx",
    }],
    taxonomy: { segments: ["{year}", "{client}", "{month:02}"] },
    naming: {
      template: "{year}-{month:02}_{client}_{deliverable}.xlsx",
      recognizers: [],
    },
    deliverables: [
      {
        id: "monthly-training",
        token: "TRAINING",
        cadence: "monthly",
        periodAnchor: "last",
        appliesTo: { workbookField: "monthlyTraining", truthy: true },
      },
      {
        id: "monthly-safety",
        token: "SAFETY",
        cadence: "monthly",
        periodAnchor: "last",
        appliesTo: { workbookField: "monthlySafety", truthy: true },
      },
    ],
    workbookMapping: {
      source: { kind: "table", name: "ClientRoster" },
      headerRow: 1,
      columns: { client: "Client", monthlyTraining: "Monthly Training", monthlySafety: "Monthly Safety" },
    },
    window: { mode: "rolling", months: 12, respectEffectiveFrom: false },
  };
}

const profile = buildProfile();

describe("buildTaxonomyMatcher", () => {
  it("accepts a path that matches every segment to its depth", () => {
    const matches = buildTaxonomyMatcher(profile);
    expect(matches("2026")).toBe(true);
    expect(matches("2026/CLIENTA")).toBe(true);
    expect(matches("2026/CLIENTA/09")).toBe(true);
  });

  it("rejects a segment that is not the right shape", () => {
    const matches = buildTaxonomyMatcher(profile);
    expect(matches("twenty-twenty-six")).toBe(false);
    expect(matches("2026/CLIENTA/13")).toBe(false);
    expect(matches("2026/CLIENTA/September")).toBe(false);
  });

  it("rejects a path deeper than the taxonomy allows", () => {
    expect(buildTaxonomyMatcher(profile)("2026/CLIENTA/09/extra")).toBe(false);
  });

  it("anchors each segment so a longer segment cannot pass", () => {
    expect(buildTaxonomyMatcher(profile)("2026x/CLIENTA")).toBe(false);
  });

  it("rejects an empty client segment", () => {
    // "[^/]+" requires at least one character, so "2026//09" (an empty
    // client) must not slip through as a taxonomy path.
    expect(buildTaxonomyMatcher(profile)("2026//09")).toBe(false);
  });

  it("accepts an unpadded month token and rejects an out of range one", () => {
    const unpadded: Profile = {
      ...buildProfile(),
      taxonomy: { segments: ["{year}", "{client}", "{month}"] },
    };
    const matches = buildTaxonomyMatcher(unpadded);
    expect(matches("2026/CLIENTA/9")).toBe(true);
    expect(matches("2026/CLIENTA/09")).toBe(false);
    expect(matches("2026/CLIENTA/13")).toBe(false);
    expect(matches("2026/CLIENTA/0")).toBe(false);
  });

  it("accepts every declared month name and rejects one that is not English", () => {
    const monthName: Profile = {
      ...buildProfile(),
      taxonomy: { segments: ["{year}", "{client}", "{monthName}"] },
    };
    const matches = buildTaxonomyMatcher(monthName);
    expect(matches("2026/CLIENTA/January")).toBe(true);
    expect(matches("2026/CLIENTA/December")).toBe(true);
    expect(matches("2026/CLIENTA/Janvier")).toBe(false);
  });

  it("accepts a deliverable token declared on the profile and rejects one that is not", () => {
    const deliverable: Profile = {
      ...buildProfile(),
      taxonomy: { segments: ["{year}", "{client}", "{deliverable}"] },
    };
    const matches = buildTaxonomyMatcher(deliverable);
    expect(matches("2026/CLIENTA/TRAINING")).toBe(true);
    expect(matches("2026/CLIENTA/SAFETY")).toBe(true);
    expect(matches("2026/CLIENTA/AUDIT")).toBe(false);
  });

  it("treats literal text around a token as a literal, dots and all", () => {
    const literal: Profile = {
      ...buildProfile(),
      taxonomy: { segments: ["{year}", "{client}", "{month:02}.report"] },
    };
    const matches = buildTaxonomyMatcher(literal);
    expect(matches("2026/CLIENTA/09.report")).toBe(true);
    // A dot in the taxonomy segment must be a literal dot, not "any
    // character", or this would also accept a "09Xreport" segment.
    expect(matches("2026/CLIENTA/09Xreport")).toBe(false);
  });

  it("throws when a segment carries a token outside the closed placeholder set", () => {
    // The profile validator already rejects an unknown token, so a profile
    // reaching this function with one is an upstream bug rather than a bad
    // profile, and throwing rather than silently accepting is correct.
    const bogus = {
      ...buildProfile(),
      taxonomy: { segments: ["{year}", "{quarter}"] },
    } as Profile;
    expect(() => buildTaxonomyMatcher(bogus)).toThrow(/unknown placeholder/);
  });
});
