import { describe, expect, it } from "vitest";
import { createFileParser } from "../../../src/domain/reconcile/parse.js";
import type { Profile } from "../../../src/domain/profile/schema.js";
import { matchArtifacts } from "../../../src/domain/reconcile/match.js";
import type { RepositoryFile } from "../../../src/domain/reconcile/types.js";

// The rule that makes this tool usable at a customer with more than one
// library. A file the Microsoft Search cross-check found in another library
// carries `library`, and such a file must never become an orphan: it
// participates only as a candidate for an expected slot, and is discarded,
// not reported, when it matches none. Without this, every unrelated document
// in every other library of the site -- HR documents, meeting notes, scanned
// invoices -- would land in the compliance report.
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
    taxonomy: { segments: ["{year}", "{client}", "{month:02}-{monthName}"] },
    naming: {
      template: "{year}-{month:02}_{client}_{deliverable}.xlsx",
      recognizers: [],
    },
    deliverables: [
      {
        id: "monthly-training",
        token: "Training",
        cadence: "monthly",
        periodAnchor: "last",
        appliesTo: { workbookField: "monthlyTraining", truthy: true },
      },
    ],
    workbookMapping: {
      source: { kind: "table", name: "ClientRoster" },
      headerRow: 1,
      columns: { client: "Client", monthlyTraining: "Monthly Training" },
    },
    window: { mode: "rolling", months: 7, respectEffectiveFrom: false },
  };
}

const profile = buildProfile();
const parse = createFileParser(profile);

describe("matchArtifacts: the library qualifier excludes a file from orphan reporting", () => {
  it("never reports a file from another library as an unrecognized orphan", () => {
    const stranger: RepositoryFile = {
      path: "Policies/handbook.xlsx",
      name: "handbook.xlsx",
      size: 1,
      modified: "2026-01-01T00:00:00Z",
      etag: '"{e}"',
      library: "Archive",
    };

    const result = matchArtifacts(profile, [], [parse(stranger)]);

    expect(result.orphans).toEqual([]);
  });

  it("never reports a file from another library as an unexpected orphan either", () => {
    // Parses cleanly against the canonical template, naming a client no
    // finding was ever built for, so it would be an "unexpected" orphan if
    // filed in the profile's own library. Both orphan push sites must skip a
    // qualified file, not just the unrecognized one, or this path stays open.
    const fileNamingAnUnownedSlot: RepositoryFile = {
      path: "2026/CLIENTX/05-May/2026-05_CLIENTX_Training.xlsx",
      name: "2026-05_CLIENTX_Training.xlsx",
      size: 1,
      modified: "2026-01-01T00:00:00Z",
      etag: '"{e2}"',
      library: "Archive",
    };

    const result = matchArtifacts(profile, [], [parse(fileNamingAnUnownedSlot)]);

    expect(result.orphans).toEqual([]);
  });

  it("still reports an unrecognized file in the profile's own library as an orphan", () => {
    // The negative case: the exclusion must not have widened past a
    // qualified file to swallow orphans in the profile's own library too.
    const stranger: RepositoryFile = {
      path: "handbook.xlsx",
      name: "handbook.xlsx",
      size: 1,
      modified: "2026-01-01T00:00:00Z",
      etag: '"{e}"',
    };

    const result = matchArtifacts(profile, [], [parse(stranger)]);

    expect(result.orphans).toHaveLength(1);
  });
});
