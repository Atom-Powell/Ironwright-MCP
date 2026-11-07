import { describe, expect, it, vi } from "vitest";
import type { Profile } from "../../../src/domain/profile/schema.js";
import type { RepositoryFile, RepositorySnapshot, WorkbookSnapshot } from "../../../src/domain/reconcile/index.js";

/**
 * `parseFile` and `createFileParser` return identical results for the same
 * file, by construction: `parseFile` is a one-line wrapper that calls
 * `createFileParser` and immediately invokes what it gets back. So no
 * assertion about the report's contents can tell the two call shapes apart.
 * The difference is entirely in how much work is repeated -- one canonical
 * pattern build and one regex compilation per recognizer, per file rather
 * than per scan -- and a timing assertion for that would be a flaky test
 * dressed up as a structural one.
 *
 * What is honestly observable is the call graph itself, so that is what this
 * file observes. The module is spied on rather than replaced: both exports
 * still run their real implementations, so a passing report here is a real
 * report, and the spies only record that `reconcile` asked for a prepared
 * parser once and never reached for the one-shot helper.
 *
 * The spies see only calls made from outside `parse.js`. `parseFile`'s own
 * internal call to `createFileParser` is a module-local binding and does not
 * pass through the spy, which is exactly the property that makes the two
 * shapes distinguishable here: per-file `parseFile` would show up as N calls
 * to `parseFile` and zero to `createFileParser`.
 *
 * This lives in its own file because `vi.mock` is hoisted to the top of the
 * module it appears in and applies to every test in it. Keeping it separate
 * leaves the behavioral suite in `reconcile.test.ts` running against the
 * untouched module.
 */
const parseSpies = vi.hoisted(() => ({
  createFileParser: vi.fn(),
  parseFile: vi.fn(),
}));

vi.mock("../../../src/domain/reconcile/parse.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/domain/reconcile/parse.js")>();
  parseSpies.createFileParser.mockImplementation(original.createFileParser);
  parseSpies.parseFile.mockImplementation(original.parseFile);
  return { createFileParser: parseSpies.createFileParser, parseFile: parseSpies.parseFile };
});

const { reconcile } = await import("../../../src/domain/reconcile/index.js");

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
      recognizers: [
        {
          id: "legacy-monthly",
          pattern: "^(?<client>[A-Z0-9]+) Monthly - (?<monthName>[A-Za-z]+) (?<year>\\d{4})\\.xlsx$",
          deliverable: "monthly-training",
          verdict: "misnamed",
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
    window: { mode: "rolling", months: 3, respectEffectiveFrom: false },
  };
}

function repoFile(path: string): RepositoryFile {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    size: 2048,
    modified: "2026-07-01T00:00:00Z",
    etag: `etag-${path}`,
  };
}

const FILE_PATHS = [
  "2026/CLIENTA/04-April/2026-04_CLIENTA_Training.xlsx",
  "2026/CLIENTA/05-May/2026-05_CLIENTA_Training.xlsx",
  "2026/CLIENTA/06-June/CLIENTA Monthly - June 2026.xlsx",
  "2026/Archive/notes.txt",
];

const workbook: WorkbookSnapshot = {
  rows: [{ client: "CLIENTA", fields: { monthlyTraining: "Yes" } }],
  source: "/Trackers/Tracker.xlsx#ClientRoster",
  rejectedRows: [],
};

const repository: RepositorySnapshot = {
  files: FILE_PATHS.map(repoFile),
  folderPaths: [],
  scannedAt: "2026-07-03T09:00:00Z",
  searchCrossCheckIncluded: true,
};

describe("reconcile: parser preparation", () => {
  it("prepares one parser for the whole scan instead of one per file", () => {
    parseSpies.createFileParser.mockClear();
    parseSpies.parseFile.mockClear();

    const report = reconcile(buildProfile(), workbook, repository, { year: 2026, month: 6 });

    // Guards the assertions below: without this the spies could be counting
    // calls from a run that parsed nothing at all.
    expect(report.artifacts.map((artifact) => artifact.state)).toEqual(["compliant", "compliant", "misnamed"]);
    expect(report.orphans).toHaveLength(1);

    expect(repository.files.length).toBeGreaterThan(1);
    expect(parseSpies.createFileParser).toHaveBeenCalledTimes(1);
    expect(parseSpies.parseFile).not.toHaveBeenCalled();
  });
});
