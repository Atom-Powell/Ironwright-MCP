import { describe, expect, it } from "vitest";
import { parseFile } from "../../../src/domain/reconcile/parse.js";
import type { Profile } from "../../../src/domain/profile/schema.js";
import type { RepositoryFile } from "../../../src/domain/reconcile/types.js";

// A file parsed into a period nobody can own would be reported as an orphan
// against a slot that cannot exist, which reads as a repository problem when
// it is actually the filename (or a misconfigured recognizer) that is wrong.
// Both tests below make a recognizer match structurally, then fail on the
// month it captured, and expect the file to come back unrecognized rather
// than carrying a period built out of nonsense.
function buildProfile(namingOverrides: Partial<Profile["naming"]> = {}): Profile {
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
      recognizers: [
        {
          id: "legacy-monthly-name",
          pattern: "^(?<client>[A-Z0-9]+) Monthly - (?<monthName>[A-Za-z]+) (?<year>\\d{4})\\.xlsx$",
          deliverable: "monthly-training",
          verdict: "misnamed",
        },
      ],
      ...namingOverrides,
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
    window: { mode: "rolling", months: 6, respectEffectiveFrom: false },
  };
}

function buildFile(name: string): RepositoryFile {
  return { path: `2026/CLIENTA/${name}`, name, size: 1024, modified: "2026-06-01T00:00:00Z", etag: "etag-1" };
}

describe("parseFile rejections for an impossible parsed month", () => {
  it("treats a recognizer match capturing an out-of-range numeric month (13) as unrecognized", () => {
    const profile = buildProfile({
      recognizers: [
        {
          id: "numeric-legacy",
          pattern: "^(?<client>[A-Z0-9]+)_(?<year>\\d{4})-(?<month>\\d{2})_Training\\.xlsx$",
          deliverable: "monthly-training",
          verdict: "misnamed",
        },
      ],
    });
    const file = buildFile("CLIENTA_2026-13_Training.xlsx");

    expect(parseFile(profile, file)).toEqual({ recognized: false, file });
  });

  it("treats a recognizer match capturing a misspelled month name as unrecognized", () => {
    const profile = buildProfile();
    const file = buildFile("CLIENTA Monthly - Mayz 2026.xlsx");

    expect(parseFile(profile, file)).toEqual({ recognized: false, file });
  });
});
