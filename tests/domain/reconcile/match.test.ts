import { describe, expect, it } from "vitest";
import { createFileParser } from "../../../src/domain/reconcile/parse.js";
import type { Profile } from "../../../src/domain/profile/schema.js";
import { matchArtifacts } from "../../../src/domain/reconcile/match.js";
import type { ArtifactFinding, DuplicateFinding, OrphanFinding, RepositoryFile } from "../../../src/domain/reconcile/types.js";

// Deliverable id and token are deliberately different strings ("monthly-training"
// vs "Training"), following the convention already established in
// expected.test.ts and parse.test.ts: a matcher that accidentally swapped one
// for the other (for example, rendering the expected folder with the id
// instead of the token) would be caught by a mismatched folder path rather
// than passing by coincidence.
function buildProfile(): Profile {
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
          id: "legacy-name",
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

function finding(client: string, period: { year: number; month: number }, expectedPath: string, expectedName: string): ArtifactFinding {
  return { client, deliverable: "monthly-training", period, expectedPath, expectedName, state: "missing" };
}

function repoFile(name: string, folder: string, modified: string, etag: string): RepositoryFile {
  return { path: `${folder}/${name}`, name, size: 1024, modified, etag };
}

const profile = buildProfile();
const parse = createFileParser(profile);
const period = { year: 2026, month: 5 };
const expectedPath = "2026/CLIENTA/05-May";
const expectedName = "2026-05_CLIENTA_Training.xlsx";

describe("matchArtifacts: the five states", () => {
  it("marks a canonical file sitting in the correct folder as compliant", () => {
    const file = repoFile(expectedName, expectedPath, "2026-06-01T00:00:00Z", "etag-1");
    const result = matchArtifacts(profile, [finding("CLIENTA", period, expectedPath, expectedName)], [parse(file)]);

    expect(result.artifacts).toEqual([
      {
        client: "CLIENTA",
        deliverable: "monthly-training",
        period,
        expectedPath,
        expectedName,
        state: "compliant",
        matched: { path: file.path, name: file.name, etag: file.etag },
      },
    ]);
    expect(result.duplicates).toEqual([]);
    expect(result.orphans).toEqual([]);
  });

  it("marks a recognizer-misnamed file sitting in the correct folder as misnamed", () => {
    const name = "CLIENTB Monthly - May 2026.xlsx";
    const path = `${expectedPath.replace("CLIENTA", "CLIENTB")}/${name}`;
    const file: RepositoryFile = { path, name, size: 512, modified: "2026-06-01T00:00:00Z", etag: "etag-2" };
    const findings = [finding("CLIENTB", period, expectedPath.replace("CLIENTA", "CLIENTB"), expectedName.replace("CLIENTA", "CLIENTB"))];

    const result = matchArtifacts(profile, findings, [parse(file)]);

    expect(result.artifacts[0]?.state).toBe("misnamed");
    expect(result.artifacts[0]?.matched).toEqual({ path, name, etag: "etag-2", recognizerId: "legacy-name" });
  });

  it("marks a canonical file sitting at the client root (wrong folder) as misplaced", () => {
    const name = expectedName.replace("CLIENTA", "CLIENTC");
    const path = `2026/CLIENTC/${name}`; // client root, missing the month segment
    const file: RepositoryFile = { path, name, size: 512, modified: "2026-06-01T00:00:00Z", etag: "etag-3" };
    const findings = [finding("CLIENTC", period, "2026/CLIENTC/05-May", name)];

    const result = matchArtifacts(profile, findings, [parse(file)]);

    expect(result.artifacts[0]?.state).toBe("misplaced");
    expect(result.artifacts[0]?.matched).toEqual({ path, name, etag: "etag-3" });
  });

  it("marks a misnamed file sitting at the wrong folder as misnamed_and_misplaced", () => {
    const name = "CLIENTD Monthly - May 2026.xlsx";
    const path = `2026/CLIENTD/${name}`; // client root, missing the month segment
    const file: RepositoryFile = { path, name, size: 512, modified: "2026-06-01T00:00:00Z", etag: "etag-4" };
    const findings = [finding("CLIENTD", period, "2026/CLIENTD/05-May", "2026-05_CLIENTD_Training.xlsx")];

    const result = matchArtifacts(profile, findings, [parse(file)]);

    expect(result.artifacts[0]?.state).toBe("misnamed_and_misplaced");
    expect(result.artifacts[0]?.matched).toEqual({ path, name, etag: "etag-4", recognizerId: "legacy-name" });
  });

  it("leaves a slot with no candidate missing, with no matched file", () => {
    const target = finding("CLIENTE", period, "2026/CLIENTE/05-May", "2026-05_CLIENTE_Training.xlsx");

    const result = matchArtifacts(profile, [target], []);

    expect(result.artifacts).toEqual([target]);
  });
});

describe("matchArtifacts: duplicates", () => {
  it("picks the better-ranked candidate and reports the other as a duplicate naming the slot it collides with", () => {
    const winnerName = expectedName.replace("CLIENTA", "CLIENTF");
    const winnerPath = `2026/CLIENTF/05-May/${winnerName}`;
    const winner: RepositoryFile = { path: winnerPath, name: winnerName, size: 512, modified: "2026-06-01T00:00:00Z", etag: "etag-win" };

    // Same canonical name, but filed at the client root: correct name, wrong
    // folder, so it ranks as misplaced -- worse than the winner's compliant.
    const loserPath = `2026/CLIENTF/${winnerName}`;
    const loser: RepositoryFile = { path: loserPath, name: winnerName, size: 512, modified: "2026-05-01T00:00:00Z", etag: "etag-lose" };

    const slotFinding = finding("CLIENTF", period, "2026/CLIENTF/05-May", winnerName);
    const result = matchArtifacts(profile, [slotFinding], [parse(winner), parse(loser)]);

    expect(result.artifacts[0]?.state).toBe("compliant");
    expect(result.artifacts[0]?.matched?.path).toBe(winnerPath);

    const expectedDuplicate: DuplicateFinding = {
      path: loserPath,
      name: winnerName,
      slot: { client: "CLIENTF", deliverable: "monthly-training", period },
      state: "misplaced",
    };
    expect(result.duplicates).toEqual([expectedDuplicate]);
  });

  it("ranks misplaced above misnamed, which is the opposite of their alphabetical order", () => {
    // "misnamed" sorts before "misplaced" alphabetically, but the spec's
    // explicit rank puts misplaced (correct name, wrong folder) ahead of
    // misnamed (wrong name, correct folder). A sort keyed on the state
    // string itself, rather than an explicit rank table, would pick the
    // misnamed candidate here and fail this assertion.
    const properName = "2026-05_CLIENTK_Training.xlsx";
    const misplacedPath = `2026/CLIENTK/${properName}`; // client root: correct name, wrong folder
    const misplaced: RepositoryFile = { path: misplacedPath, name: properName, size: 512, modified: "2026-06-01T00:00:00Z", etag: "etag-misplaced" };

    const misnamedName = "CLIENTK Monthly - May 2026.xlsx";
    const misnamedPath = `2026/CLIENTK/05-May/${misnamedName}`; // correct folder, wrong (legacy) name
    const misnamed: RepositoryFile = { path: misnamedPath, name: misnamedName, size: 512, modified: "2026-06-01T00:00:00Z", etag: "etag-misnamed" };

    const slotFinding = finding("CLIENTK", period, "2026/CLIENTK/05-May", properName);
    const result = matchArtifacts(profile, [slotFinding], [parse(misnamed), parse(misplaced)]);

    expect(result.artifacts[0]?.state).toBe("misplaced");
    expect(result.artifacts[0]?.matched?.path).toBe(misplacedPath);
    expect(result.duplicates).toEqual([
      { path: misnamedPath, name: misnamedName, slot: { client: "CLIENTK", deliverable: "monthly-training", period }, state: "misnamed" },
    ]);
  });

  it("breaks a tie between two equally-ranked candidates by most recently modified", () => {
    // Both candidates are canonical name at the client root: both misplaced,
    // so the state ranking alone cannot pick a winner and the tiebreak must
    // actually run.
    const name = expectedName.replace("CLIENTA", "CLIENTG");
    const older: RepositoryFile = { path: `2026/CLIENTG/older/${name}`, name, size: 512, modified: "2026-05-01T00:00:00Z", etag: "etag-older" };
    const newer: RepositoryFile = { path: `2026/CLIENTG/newer/${name}`, name, size: 512, modified: "2026-06-15T00:00:00Z", etag: "etag-newer" };

    const slotFinding = finding("CLIENTG", period, "2026/CLIENTG/05-May", name);
    const result = matchArtifacts(profile, [slotFinding], [parse(older), parse(newer)]);

    expect(result.artifacts[0]?.state).toBe("misplaced");
    expect(result.artifacts[0]?.matched?.path).toBe(newer.path);
    expect(result.duplicates).toEqual([
      { path: older.path, name, slot: { client: "CLIENTG", deliverable: "monthly-training", period }, state: "misplaced" },
    ]);
  });

  it("breaks a tie on state and modified time alphabetically by path", () => {
    const name = expectedName.replace("CLIENTA", "CLIENTH");
    const sameModified = "2026-06-01T00:00:00Z";
    const pathA: RepositoryFile = { path: `2026/CLIENTH/aaa/${name}`, name, size: 512, modified: sameModified, etag: "etag-a" };
    const pathB: RepositoryFile = { path: `2026/CLIENTH/bbb/${name}`, name, size: 512, modified: sameModified, etag: "etag-b" };

    const slotFinding = finding("CLIENTH", period, "2026/CLIENTH/05-May", name);
    // Pass the alphabetically-later file first, so a correct implementation
    // must actually compare paths rather than accidentally preserving input order.
    const result = matchArtifacts(profile, [slotFinding], [parse(pathB), parse(pathA)]);

    expect(result.artifacts[0]?.matched?.path).toBe(pathA.path);
    expect(result.duplicates).toEqual([
      { path: pathB.path, name, slot: { client: "CLIENTH", deliverable: "monthly-training", period }, state: "misplaced" },
    ]);
  });
});

describe("matchArtifacts: orphans", () => {
  it("classifies a file that does not parse at all as an unrecognized orphan", () => {
    const file = repoFile("readme.txt", "2026/CLIENTA", "2026-06-01T00:00:00Z", "etag-5");

    const result = matchArtifacts(profile, [], [parse(file)]);

    const expectedOrphan: OrphanFinding = { path: file.path, name: file.name, kind: "unrecognized" };
    expect(result.orphans).toEqual([expectedOrphan]);
  });

  it("classifies a file that parses cleanly but names a client nobody owes as an unexpected orphan", () => {
    const name = expectedName.replace("CLIENTA", "CLIENTUNKNOWN");
    const file = repoFile(name, "2026/CLIENTUNKNOWN/05-May", "2026-06-01T00:00:00Z", "etag-6");

    // No finding at all exists for CLIENTUNKNOWN: the workbook does not carry
    // this client, so the parsed file matches no slot.
    const result = matchArtifacts(profile, [], [parse(file)]);

    expect(result.orphans).toEqual([
      { path: file.path, name, kind: "unexpected", parsed: { client: "CLIENTUNKNOWN", deliverable: "monthly-training", period } },
    ]);
  });

  it("classifies a file whose client exists but whose period falls outside the window as an unexpected orphan, not a silent drop", () => {
    // CLIENTI owes monthly-training, but the workbook-derived window only
    // produced a finding for month 5. This file parses to month 1, a real
    // client and deliverable, but a period nobody in the expected set owns.
    const outOfWindowPeriod = { year: 2026, month: 1 };
    const name = "2026-01_CLIENTI_Training.xlsx";
    const file = repoFile(name, "2026/CLIENTI/01-January", "2026-06-01T00:00:00Z", "etag-7");
    const findings = [finding("CLIENTI", period, "2026/CLIENTI/05-May", "2026-05_CLIENTI_Training.xlsx")];

    const result = matchArtifacts(profile, findings, [parse(file)]);

    // The in-window slot stays missing: this file did not satisfy it.
    expect(result.artifacts[0]?.state).toBe("missing");
    expect(result.orphans).toEqual([
      { path: file.path, name, kind: "unexpected", parsed: { client: "CLIENTI", deliverable: "monthly-training", period: outOfWindowPeriod } },
    ]);
  });
});

describe("matchArtifacts: the library qualifier", () => {
  it("treats a correctly named file in another library as misplaced, not compliant", () => {
    // Its path inside that other library is identical to the expected one.
    // The location is wrong because the library is wrong, and a library
    // relative path alone cannot express that.
    const file: RepositoryFile = { ...repoFile(expectedName, expectedPath, "2026-06-01T00:00:00Z", "etag-lib-1"), library: "Archive" };
    const result = matchArtifacts(profile, [finding("CLIENTA", period, expectedPath, expectedName)], [parse(file)]);

    expect(result.artifacts[0]?.state).toBe("misplaced");
  });

  it("treats a misnamed file in another library as misnamed and misplaced", () => {
    const name = "CLIENTB Monthly - May 2026.xlsx";
    const file: RepositoryFile = { ...repoFile(name, expectedPath.replace("CLIENTA", "CLIENTB"), "2026-06-01T00:00:00Z", "etag-lib-2"), library: "Archive" };
    const findings = [finding("CLIENTB", period, expectedPath.replace("CLIENTA", "CLIENTB"), expectedName.replace("CLIENTA", "CLIENTB"))];

    const result = matchArtifacts(profile, findings, [parse(file)]);

    expect(result.artifacts[0]?.state).toBe("misnamed_and_misplaced");
  });

  it("keeps today's meaning for a file with no library qualifier", () => {
    const file = repoFile(expectedName, expectedPath, "2026-06-01T00:00:00Z", "etag-lib-3");
    const result = matchArtifacts(profile, [finding("CLIENTA", period, expectedPath, expectedName)], [parse(file)]);

    expect(result.artifacts[0]?.state).toBe("compliant");
  });
});

describe("matchArtifacts: accepted alias", () => {
  it("marks a file recognized as a compliant alias, correctly filed, as compliant", () => {
    const name = "CLIENTJ-202605-Training.xlsx";
    const path = `2026/CLIENTJ/05-May/${name}`;
    const file: RepositoryFile = { path, name, size: 512, modified: "2026-06-01T00:00:00Z", etag: "etag-8" };
    const findings = [finding("CLIENTJ", period, "2026/CLIENTJ/05-May", "2026-05_CLIENTJ_Training.xlsx")];

    const result = matchArtifacts(profile, findings, [parse(file)]);

    expect(result.artifacts[0]?.state).toBe("compliant");
    expect(result.artifacts[0]?.matched).toEqual({ path, name, etag: "etag-8", recognizerId: "compact-alias" });
  });
});
