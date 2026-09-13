import { describe, expect, it } from "vitest";
import type { Profile } from "../../../src/domain/profile/schema.js";
import { reconcile } from "../../../src/domain/reconcile/index.js";
import type {
  ArtifactState,
  ClientRecord,
  Period,
  RepositoryFile,
  RepositorySnapshot,
  WorkbookSnapshot,
} from "../../../src/domain/reconcile/types.js";

// Deliverable ids and tokens are deliberately different strings, and the
// profile declares its deliverables in an order that is not their sorted
// order, so a report that simply echoed profile order rather than sorting
// would be caught here rather than passing by coincidence.
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
          id: "legacy-monthly",
          pattern: "^(?<client>[A-Z0-9]+) Monthly - (?<monthName>[A-Za-z]+) (?<year>\\d{4})\\.xlsx$",
          deliverable: "monthly-training",
          verdict: "misnamed",
        },
        {
          id: "alias-training",
          pattern: "^(?<client>[A-Z0-9]+)-(?<year>\\d{4})(?<month>\\d{2})-Training\\.xlsx$",
          deliverable: "monthly-training",
          verdict: "compliant",
        },
        {
          id: "legacy-review",
          pattern: "^(?<client>[A-Z0-9]+) Review (?<year>\\d{4})-(?<month>\\d{2})\\.xlsx$",
          deliverable: "quarterly-review",
          verdict: "misnamed",
        },
      ],
    },
    deliverables: [
      {
        id: "quarterly-review",
        token: "Review",
        cadence: "quarterly",
        periodAnchor: "last",
        appliesTo: { workbookField: "quarterlyReview", truthy: true },
      },
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
      columns: { client: "Client", monthlyTraining: "Monthly Training", quarterlyReview: "Quarterly Review" },
    },
    window: { mode: "rolling", months: 3, respectEffectiveFrom: false },
  };
}

function row(client: string, monthlyTraining: string, quarterlyReview: string): ClientRecord {
  return { client, fields: { monthlyTraining, quarterlyReview } };
}

// Rows are supplied in an order that is not sorted, so the report's own
// ordering has to come from sorting rather than from input order.
function buildWorkbook(): WorkbookSnapshot {
  return {
    rows: [row("CLIENTB", "Yes", "No"), row("CLIENTC", "No", "No"), row("CLIENTA", "Yes", "Yes")],
    source: "/Trackers/Tracker.xlsx#ClientRoster",
  };
}

function repoFile(path: string, modified: string, etag: string): RepositoryFile {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), size: 2048, modified, etag };
}

const FILES: RepositoryFile[] = [
  // CLIENTA monthly training: April is canonical and correctly filed.
  repoFile("2026/CLIENTA/04-April/2026-04_CLIENTA_Training.xlsx", "2026-05-02T00:00:00Z", "etag-a04"),
  // May has two candidates. The correctly filed one wins the slot and the
  // stray copy in Archive becomes a duplicate naming that same slot.
  repoFile("2026/CLIENTA/05-May/2026-05_CLIENTA_Training.xlsx", "2026-06-02T00:00:00Z", "etag-a05"),
  repoFile("2026/Archive/2026-05_CLIENTA_Training.xlsx", "2026-06-03T00:00:00Z", "etag-a05-copy"),
  // June is absent everywhere, so its slot stays missing.
  // CLIENTA quarterly review: a legacy name in the right folder. The
  // recognizer captures month 05 and the quarterly anchor moves it to June.
  repoFile("2026/CLIENTA/06-June/CLIENTA Review 2026-05.xlsx", "2026-07-01T00:00:00Z", "etag-a-review"),
  // CLIENTB monthly training: one of each remaining state.
  repoFile("2026/CLIENTB/04-April/CLIENTB Monthly - April 2026.xlsx", "2026-05-02T00:00:00Z", "etag-b04"),
  repoFile("2026/Archive/CLIENTB Monthly - May 2026.xlsx", "2026-06-02T00:00:00Z", "etag-b05"),
  repoFile("2026/CLIENTB/06-June/CLIENTB-202606-Training.xlsx", "2026-07-02T00:00:00Z", "etag-b06"),
  // An unparseable name, and a name that parses cleanly for a client who owes
  // nothing at all.
  repoFile("2026/Archive/notes.txt", "2026-01-04T00:00:00Z", "etag-notes"),
  repoFile("2026/CLIENTC/03-March/2026-03_CLIENTC_Training.xlsx", "2026-04-01T00:00:00Z", "etag-c03"),
];

const FOLDERS = [
  "2026/CLIENTB/05-May",
  "2026",
  "2026/CLIENTA",
  "2026/CLIENTA/04-April",
  "2026/CLIENTA/05-May",
  "2026/CLIENTA/06-June",
  "2026/CLIENTB",
  "2026/CLIENTB/04-April",
  "2026/CLIENTB/06-June",
  "2026/CLIENTC",
  "2026/CLIENTC/03-March",
  "2026/Archive",
  "2025/CLIENTA",
];

function buildRepository(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    files: FILES,
    folderPaths: FOLDERS,
    scannedAt: "2026-07-03T09:00:00Z",
    searchCrossCheckIncluded: true,
    ...overrides,
  };
}

const profile = buildProfile();
const workbook = buildWorkbook();
const asOf: Period = { year: 2026, month: 6 };

const EMPTY_COUNTS: Record<ArtifactState, number> = {
  compliant: 0,
  misnamed: 0,
  misplaced: 0,
  misnamed_and_misplaced: 0,
  missing: 0,
};

describe("reconcile: the assembled report", () => {
  it("composes the stages into one report", () => {
    const report = reconcile(profile, workbook, buildRepository(), asOf);

    expect(report).toEqual({
      profileId: "example",
      window: { from: { year: 2026, month: 4 }, to: { year: 2026, month: 6 } },
      provenance: {
        scannedAt: "2026-07-03T09:00:00Z",
        searchCrossCheckIncluded: true,
        workbookSource: "/Trackers/Tracker.xlsx#ClientRoster",
      },
      artifacts: [
        {
          client: "CLIENTA",
          deliverable: "monthly-training",
          period: { year: 2026, month: 4 },
          expectedPath: "2026/CLIENTA/04-April",
          expectedName: "2026-04_CLIENTA_Training.xlsx",
          state: "compliant",
          matched: {
            path: "2026/CLIENTA/04-April/2026-04_CLIENTA_Training.xlsx",
            name: "2026-04_CLIENTA_Training.xlsx",
            etag: "etag-a04",
          },
        },
        {
          client: "CLIENTA",
          deliverable: "monthly-training",
          period: { year: 2026, month: 5 },
          expectedPath: "2026/CLIENTA/05-May",
          expectedName: "2026-05_CLIENTA_Training.xlsx",
          state: "compliant",
          matched: {
            path: "2026/CLIENTA/05-May/2026-05_CLIENTA_Training.xlsx",
            name: "2026-05_CLIENTA_Training.xlsx",
            etag: "etag-a05",
          },
        },
        {
          client: "CLIENTA",
          deliverable: "monthly-training",
          period: { year: 2026, month: 6 },
          expectedPath: "2026/CLIENTA/06-June",
          expectedName: "2026-06_CLIENTA_Training.xlsx",
          state: "missing",
        },
        {
          client: "CLIENTA",
          deliverable: "quarterly-review",
          period: { year: 2026, month: 6 },
          expectedPath: "2026/CLIENTA/06-June",
          expectedName: "2026-06_CLIENTA_Review.xlsx",
          state: "misnamed",
          matched: {
            path: "2026/CLIENTA/06-June/CLIENTA Review 2026-05.xlsx",
            name: "CLIENTA Review 2026-05.xlsx",
            etag: "etag-a-review",
            recognizerId: "legacy-review",
          },
        },
        {
          client: "CLIENTB",
          deliverable: "monthly-training",
          period: { year: 2026, month: 4 },
          expectedPath: "2026/CLIENTB/04-April",
          expectedName: "2026-04_CLIENTB_Training.xlsx",
          state: "misnamed",
          matched: {
            path: "2026/CLIENTB/04-April/CLIENTB Monthly - April 2026.xlsx",
            name: "CLIENTB Monthly - April 2026.xlsx",
            etag: "etag-b04",
            recognizerId: "legacy-monthly",
          },
        },
        {
          client: "CLIENTB",
          deliverable: "monthly-training",
          period: { year: 2026, month: 5 },
          expectedPath: "2026/CLIENTB/05-May",
          expectedName: "2026-05_CLIENTB_Training.xlsx",
          state: "misnamed_and_misplaced",
          matched: {
            path: "2026/Archive/CLIENTB Monthly - May 2026.xlsx",
            name: "CLIENTB Monthly - May 2026.xlsx",
            etag: "etag-b05",
            recognizerId: "legacy-monthly",
          },
        },
        {
          client: "CLIENTB",
          deliverable: "monthly-training",
          period: { year: 2026, month: 6 },
          expectedPath: "2026/CLIENTB/06-June",
          expectedName: "2026-06_CLIENTB_Training.xlsx",
          state: "compliant",
          matched: {
            path: "2026/CLIENTB/06-June/CLIENTB-202606-Training.xlsx",
            name: "CLIENTB-202606-Training.xlsx",
            etag: "etag-b06",
            recognizerId: "alias-training",
          },
        },
      ],
      duplicates: [
        {
          path: "2026/Archive/2026-05_CLIENTA_Training.xlsx",
          name: "2026-05_CLIENTA_Training.xlsx",
          slot: { client: "CLIENTA", deliverable: "monthly-training", period: { year: 2026, month: 5 } },
          state: "misplaced",
        },
      ],
      orphans: [
        { path: "2026/Archive/notes.txt", name: "notes.txt", kind: "unrecognized" },
        {
          path: "2026/CLIENTC/03-March/2026-03_CLIENTC_Training.xlsx",
          name: "2026-03_CLIENTC_Training.xlsx",
          kind: "unexpected",
          parsed: { client: "CLIENTC", deliverable: "monthly-training", period: { year: 2026, month: 3 } },
        },
      ],
      emptyFolders: ["2025/CLIENTA", "2026/CLIENTB/05-May"],
      clients: [
        { client: "CLIENTA", counts: { ...EMPTY_COUNTS, compliant: 2, misnamed: 1, missing: 1 }, compliant: false },
        {
          client: "CLIENTB",
          counts: { ...EMPTY_COUNTS, compliant: 1, misnamed: 1, misnamed_and_misplaced: 1 },
          compliant: false,
        },
        { client: "CLIENTC", counts: { ...EMPTY_COUNTS }, compliant: true },
      ],
    });
  });

  it("carries no generatedAt field, so two runs over the same inputs are byte-identical", () => {
    const first = reconcile(profile, workbook, buildRepository(), asOf);
    const second = reconcile(profile, workbook, buildRepository(), asOf);

    expect(Object.keys(first)).not.toContain("generatedAt");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("reports the window it was asked for rather than one derived from a clock", () => {
    const report = reconcile(profile, workbook, buildRepository(), { year: 2025, month: 2 });

    // February 2025 back three months crosses a year boundary, which is where
    // an off-by-one in the window arithmetic would show.
    expect(report.window).toEqual({ from: { year: 2024, month: 12 }, to: { year: 2025, month: 2 } });
  });

  it("carries an absent Search cross-check through to provenance unchanged", () => {
    const report = reconcile(profile, workbook, buildRepository({ searchCrossCheckIncluded: false }), asOf);

    expect(report.provenance.searchCrossCheckIncluded).toBe(false);
  });
});

describe("reconcile: ordering", () => {
  it("sorts artifacts by client, then deliverable, then period", () => {
    const report = reconcile(profile, workbook, buildRepository(), asOf);
    const keys = report.artifacts.map(
      (artifact) => `${artifact.client}|${artifact.deliverable}|${artifact.period.year}-${artifact.period.month}`,
    );

    expect(keys).toEqual([
      "CLIENTA|monthly-training|2026-4",
      "CLIENTA|monthly-training|2026-5",
      "CLIENTA|monthly-training|2026-6",
      "CLIENTA|quarterly-review|2026-6",
      "CLIENTB|monthly-training|2026-4",
      "CLIENTB|monthly-training|2026-5",
      "CLIENTB|monthly-training|2026-6",
    ]);
  });

  it("sorts duplicates, orphans and empty folders by path", () => {
    // Two more strays, appended last so input order is the reverse of the
    // order the report has to produce.
    const files = [
      ...FILES,
      repoFile("2026/Archive/2026-04_CLIENTA_Training.xlsx", "2026-05-01T00:00:00Z", "etag-a04-copy"),
      repoFile("2026/Archive/aaa-unreadable.xlsx", "2026-01-01T00:00:00Z", "etag-aaa"),
    ];
    const report = reconcile(profile, workbook, buildRepository({ files }), asOf);

    expect(report.duplicates.map((duplicate) => duplicate.path)).toEqual([
      "2026/Archive/2026-04_CLIENTA_Training.xlsx",
      "2026/Archive/2026-05_CLIENTA_Training.xlsx",
    ]);
    expect(report.orphans.map((orphan) => orphan.path)).toEqual([
      "2026/Archive/aaa-unreadable.xlsx",
      "2026/Archive/notes.txt",
      "2026/CLIENTC/03-March/2026-03_CLIENTC_Training.xlsx",
    ]);
    expect(report.emptyFolders).toEqual(["2025/CLIENTA", "2026/CLIENTB/05-May"]);
  });

  it("does not depend on the order the workbook rows arrived in", () => {
    const reversed: WorkbookSnapshot = { ...workbook, rows: [...workbook.rows].reverse() };

    expect(reconcile(profile, reversed, buildRepository(), asOf)).toEqual(
      reconcile(profile, workbook, buildRepository(), asOf),
    );
  });
});

describe("reconcile: the per-client rollup", () => {
  it("counts the states the artifacts actually resolved to, not the states they were derived as", () => {
    const report = reconcile(profile, workbook, buildRepository(), asOf);
    const clientA = report.clients.find((summary) => summary.client === "CLIENTA");

    // Every finding leaves deriveExpected as "missing" and only matching
    // promotes it. A rollup recomputed from the workbook instead of read off
    // the artifacts would report four missing here and nothing else.
    expect(clientA).toEqual({
      client: "CLIENTA",
      counts: { ...EMPTY_COUNTS, compliant: 2, misnamed: 1, missing: 1 },
      compliant: false,
    });
  });

  it("agrees with its own artifact findings for every client", () => {
    const report = reconcile(profile, workbook, buildRepository(), asOf);

    for (const summary of report.clients) {
      const own = report.artifacts.filter((artifact) => artifact.client === summary.client);
      const tallied: Record<ArtifactState, number> = { ...EMPTY_COUNTS };
      for (const artifact of own) {
        tallied[artifact.state] += 1;
      }

      expect(summary.counts).toEqual(tallied);
      expect(Object.values(summary.counts).reduce((total, count) => total + count, 0)).toBe(own.length);
      expect(summary.compliant).toBe(own.every((artifact) => artifact.state === "compliant"));
    }
  });

  it("covers every client the report has an artifact for, and every client the workbook lists", () => {
    const report = reconcile(profile, workbook, buildRepository(), asOf);
    const summarized = report.clients.map((summary) => summary.client);

    expect(summarized).toEqual(["CLIENTA", "CLIENTB", "CLIENTC"]);
    for (const artifact of report.artifacts) {
      expect(summarized).toContain(artifact.client);
    }
  });

  it("does not count duplicates or orphans against a client", () => {
    // CLIENTA has one duplicate and CLIENTC has one orphan naming it. Neither
    // is an expected artifact, so neither may appear in a rollup whose totals
    // are supposed to equal the artifact count.
    const report = reconcile(profile, workbook, buildRepository(), asOf);
    const totalCounted = report.clients
      .flatMap((summary) => Object.values(summary.counts))
      .reduce((total, count) => total + count, 0);

    expect(report.duplicates.length).toBeGreaterThan(0);
    expect(report.orphans.length).toBeGreaterThan(0);
    expect(totalCounted).toBe(report.artifacts.length);
  });

  it("marks a client compliant only when every one of its artifacts is compliant", () => {
    const compliantOnly: WorkbookSnapshot = { rows: [row("CLIENTA", "Yes", "No")], source: workbook.source };
    const files = [
      repoFile("2026/CLIENTA/04-April/2026-04_CLIENTA_Training.xlsx", "2026-05-02T00:00:00Z", "etag-a04"),
      repoFile("2026/CLIENTA/05-May/2026-05_CLIENTA_Training.xlsx", "2026-06-02T00:00:00Z", "etag-a05"),
      repoFile("2026/CLIENTA/06-June/2026-06_CLIENTA_Training.xlsx", "2026-07-02T00:00:00Z", "etag-a06"),
    ];
    const report = reconcile(profile, compliantOnly, buildRepository({ files, folderPaths: [] }), asOf);

    expect(report.clients).toEqual([
      { client: "CLIENTA", counts: { ...EMPTY_COUNTS, compliant: 3 }, compliant: true },
    ]);
  });
});
