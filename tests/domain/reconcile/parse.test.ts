import { describe, expect, it } from "vitest";
import { parseFile } from "../../../src/domain/reconcile/parse.js";
import type { Profile } from "../../../src/domain/profile/schema.js";
import type { RepositoryFile } from "../../../src/domain/reconcile/types.js";

// Two deliverables whose tokens are a genuine prefix pair ("Training" is a
// strict prefix of "TrainingAdvanced"), and ids spelled differently from
// their tokens throughout. Both facts matter: the prefix pair proves the
// deliverable capture cannot just grab the first token that fits, and the
// id/token split proves a canonical match reverse-maps the captured token
// rather than assuming the two strings are interchangeable.
function buildProfile(namingOverrides: Partial<Profile["naming"]> = {}): Profile {
  return {
    profileId: "example",
    identity: {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      library: "Compliance Reports",
      workbookPath: "/Trackers/Tracker.xlsx",
    },
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
        {
          id: "compact-alias",
          pattern: "^(?<client>[A-Z0-9]+)-(?<year>\\d{4})(?<month>\\d{2})-Training\\.xlsx$",
          deliverable: "monthly-training",
          verdict: "compliant",
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
      {
        id: "advanced-training",
        token: "TrainingAdvanced",
        cadence: "monthly",
        periodAnchor: "last",
        appliesTo: { workbookField: "advancedTraining", truthy: true },
      },
    ],
    workbookMapping: {
      source: { kind: "table", name: "ClientRoster" },
      headerRow: 1,
      columns: { client: "Client", monthlyTraining: "Monthly Training", advancedTraining: "Advanced Training" },
    },
    window: { mode: "rolling", months: 6, respectEffectiveFrom: false },
  };
}

function buildFile(name: string, path?: string): RepositoryFile {
  return {
    path: path ?? `2026/CLIENTA/05-May/${name}`,
    name,
    size: 1024,
    modified: "2026-06-01T00:00:00Z",
    etag: "etag-1",
  };
}

describe("parseFile: canonical matching", () => {
  it("parses a canonical filename, reverse-mapping its token to the deliverable id even though a client name contains the template's own separator character", () => {
    const profile = buildProfile();
    const file = buildFile("2026-05_CLIENT_A_TrainingAdvanced.xlsx", "2026/CLIENT_A/05-May/2026-05_CLIENT_A_TrainingAdvanced.xlsx");

    expect(parseFile(profile, file)).toEqual({
      recognized: true,
      file,
      client: "CLIENT_A",
      deliverable: "advanced-training",
      period: { year: 2026, month: 5 },
      nameVerdict: "canonical",
    });
  });

  it("resolves the shorter deliverable token correctly, not confusing it with a longer token that has it as a prefix", () => {
    const profile = buildProfile();
    const file = buildFile("2026-05_CLIENTB_Training.xlsx", "2026/CLIENTB/05-May/2026-05_CLIENTB_Training.xlsx");

    expect(parseFile(profile, file)).toEqual({
      recognized: true,
      file,
      client: "CLIENTB",
      deliverable: "monthly-training",
      period: { year: 2026, month: 5 },
      nameVerdict: "canonical",
    });
  });

  it("treats a filename that nearly matches the canonical form, but with the wrong extension, as unrecognized rather than partially matching", () => {
    const profile = buildProfile();
    const file = buildFile("2026-05_CLIENTA_Training.xls", "2026/CLIENTA/05-May/2026-05_CLIENTA_Training.xls");

    expect(parseFile(profile, file)).toEqual({ recognized: false, file });
  });
});

describe("parseFile: recognizers", () => {
  it("parses a misnamed recognizer match, carrying its verdict and id, and normalizes a captured month name to the same period a numeric canonical filename produces", () => {
    const profile = buildProfile();
    const legacyFile = buildFile("CLIENTA Monthly - May 2026.xlsx", "2026/CLIENTA/05-May/CLIENTA Monthly - May 2026.xlsx");
    const canonicalFile = buildFile("2026-05_CLIENTA_Training.xlsx", "2026/CLIENTA/05-May/2026-05_CLIENTA_Training.xlsx");

    const legacyResult = parseFile(profile, legacyFile);
    const canonicalResult = parseFile(profile, canonicalFile);

    expect(legacyResult).toEqual({
      recognized: true,
      file: legacyFile,
      client: "CLIENTA",
      deliverable: "monthly-training",
      period: { year: 2026, month: 5 },
      nameVerdict: "misnamed",
      recognizerId: "legacy-monthly-name",
    });
    if (!legacyResult.recognized || !canonicalResult.recognized) {
      throw new Error("expected both files to parse");
    }
    expect(legacyResult.period).toEqual(canonicalResult.period);
  });

  it("normalizes a three-letter month abbreviation, case-insensitively", () => {
    const profile = buildProfile();
    const file = buildFile("CLIENTA Monthly - jun 2026.xlsx", "2026/CLIENTA/06-June/CLIENTA Monthly - jun 2026.xlsx");

    const result = parseFile(profile, file);

    expect(result).toMatchObject({ recognized: true, period: { year: 2026, month: 6 } });
  });

  it("parses a compliant recognizer match as an accepted alias, falling back to the recognizer's declared deliverable id when its pattern captures no deliverable", () => {
    const profile = buildProfile();
    const file = buildFile("CLIENTA-202605-Training.xlsx", "2026/CLIENTA/05-May/CLIENTA-202605-Training.xlsx");

    expect(parseFile(profile, file)).toEqual({
      recognized: true,
      file,
      client: "CLIENTA",
      deliverable: "monthly-training",
      period: { year: 2026, month: 5 },
      nameVerdict: "compliant",
      recognizerId: "compact-alias",
    });
  });

  it("tries recognizers in profile order and stops at the first match", () => {
    const profile = buildProfile({
      recognizers: [
        {
          id: "first-legacy",
          pattern: "^(?<client>[A-Z0-9]+)_LegacyReport_(?<year>\\d{4})-(?<month>\\d{2})\\.xlsx$",
          deliverable: "monthly-training",
          verdict: "misnamed",
        },
        {
          id: "second-legacy",
          pattern: "^(?<client>[A-Z0-9]+)_LegacyReport_(?<year>\\d{4})-(?<month>\\d{2})\\.xlsx$",
          deliverable: "monthly-training",
          verdict: "compliant",
        },
      ],
    });
    const file = buildFile("CLIENTA_LegacyReport_2026-05.xlsx", "2026/CLIENTA/05-May/CLIENTA_LegacyReport_2026-05.xlsx");

    const result = parseFile(profile, file);

    expect(result).toMatchObject({ recognized: true, nameVerdict: "misnamed", recognizerId: "first-legacy" });
  });
});

describe("parseFile: unrecognized", () => {
  it("marks a filename matching neither the canonical template nor any recognizer as unrecognized", () => {
    const profile = buildProfile();
    const file = buildFile("readme.txt", "2026/CLIENTA/readme.txt");

    expect(parseFile(profile, file)).toEqual({ recognized: false, file });
  });
});
