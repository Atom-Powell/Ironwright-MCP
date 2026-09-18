import { describe, expect, it } from "vitest";
import { MAX_CLIENT_DETAIL, clientSegmentIndex, shapeValidateStructure } from "../../../src/tools/validate/shape.js";
import type { Profile } from "../../../src/domain/profile/schema.js";
import type { RepositoryFile, RepositorySnapshot } from "../../../src/domain/reconcile/index.js";

// Deliverable id and token differ deliberately, following the same convention
// tests/domain/structure/conform.test.ts uses: a check that accidentally
// matched on the id instead of the token would be caught by a mismatched path
// rather than passing by coincidence.
function buildProfile(): Profile {
  return {
    profileId: "example",
    identity: {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      library: "Compliance Reports",
      workbookPath: "/Trackers/Tracker.xlsx",
    },
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
    ],
    workbookMapping: {
      source: { kind: "table", name: "ClientRoster" },
      headerRow: 1,
      columns: { client: "Client", monthlyTraining: "Monthly Training" },
    },
    window: { mode: "rolling", months: 12, respectEffectiveFrom: false },
  };
}

function file(path: string, overrides: Partial<RepositoryFile> = {}): RepositoryFile {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    size: 1,
    modified: "2026-09-01T00:00:00.000Z",
    etag: "a",
    ...overrides,
  };
}

function snapshotOf(files: RepositoryFile[], folderPaths: string[]): RepositorySnapshot {
  return { files, folderPaths, scannedAt: "2026-09-17T00:00:00.000Z", searchCrossCheckIncluded: false };
}

const profile = buildProfile();

describe("clientSegmentIndex", () => {
  it("finds the index of the segment carrying {client}", () => {
    expect(clientSegmentIndex(profile)).toBe(1);
  });

  it("returns -1 for a taxonomy with no {client} segment", () => {
    const noClient: Profile = { ...profile, taxonomy: { segments: ["{year}", "{month:02}"] } };
    expect(clientSegmentIndex(noClient)).toBe(-1);
  });
});

describe("shapeValidateStructure", () => {
  it("reports a client whose folders and files all conform as compliant with empty detail lists", () => {
    const snapshot = snapshotOf(
      [file("2026/CLIENTA/09/2026-09_CLIENTA_TRAINING.xlsx")],
      ["2026", "2026/CLIENTA", "2026/CLIENTA/09"],
    );

    const output = shapeValidateStructure("example", "Compliance Reports", profile, snapshot, undefined, 3, false, {});

    expect(output.clients).toEqual([
      {
        client: "CLIENTA",
        verdict: "compliant",
        nonConformingFolders: [],
        nonConformingFoldersOmitted: 0,
        nonConformingFiles: [],
        nonConformingFilesOmitted: 0,
      },
    ]);
    expect(output.totals).toEqual({ clients: 1, compliant: 1, nonCompliant: 0, missing: 0 });
  });

  it("reports non_compliant with the offending folder when one folder matches no taxonomy path", () => {
    const snapshot = snapshotOf(
      [file("2026/CLIENTA/09/2026-09_CLIENTA_TRAINING.xlsx")],
      ["2026", "2026/CLIENTA", "2026/CLIENTA/Sept"],
    );

    const output = shapeValidateStructure("example", "Compliance Reports", profile, snapshot, undefined, 3, false, {});
    const clienta = output.clients.find((client) => client.client === "CLIENTA");

    expect(clienta?.verdict).toBe("non_compliant");
    expect(clienta?.nonConformingFolders).toEqual(["2026/CLIENTA/Sept"]);
    expect(clienta?.nonConformingFiles).toEqual([]);
  });

  it("reports non_compliant with the offending file and a reason naming the template when one file does not parse", () => {
    const snapshot = snapshotOf(
      [file("2026/CLIENTA/09/not-a-real-name.xlsx")],
      ["2026", "2026/CLIENTA", "2026/CLIENTA/09"],
    );

    const output = shapeValidateStructure("example", "Compliance Reports", profile, snapshot, undefined, 3, false, {});
    const clienta = output.clients.find((client) => client.client === "CLIENTA");

    expect(clienta?.verdict).toBe("non_compliant");
    expect(clienta?.nonConformingFolders).toEqual([]);
    expect(clienta?.nonConformingFiles).toEqual([
      {
        path: "2026/CLIENTA/09/not-a-real-name.xlsx",
        reason:
          'This name does not match the profile\'s filename template "{year}-{month:02}_{client}_{deliverable}.xlsx" or any of its 0 recognizers.',
      },
    ]);
  });

  it("reports missing for a client named explicitly with no folder at all", () => {
    const snapshot = snapshotOf([], ["2026"]);

    const output = shapeValidateStructure("example", "Compliance Reports", profile, snapshot, ["CLIENTZ"], 3, false, {});

    expect(output.clients).toEqual([
      {
        client: "CLIENTZ",
        verdict: "missing",
        nonConformingFolders: [],
        nonConformingFoldersOmitted: 0,
        nonConformingFiles: [],
        nonConformingFilesOmitted: 0,
      },
    ]);
    expect(output.totals).toEqual({ clients: 1, compliant: 0, nonCompliant: 0, missing: 1 });
  });

  it("omits a client that is neither named nor present in the library", () => {
    const snapshot = snapshotOf([], ["2026", "2026/CLIENTA"]);

    const output = shapeValidateStructure("example", "Compliance Reports", profile, snapshot, undefined, 3, false, {});

    expect(output.clients.map((client) => client.client)).toEqual(["CLIENTA"]);
  });

  it("counts every client evaluated even when the client listing truncates", () => {
    const snapshot = snapshotOf([], ["2026", "2026/CLIENTA", "2026/CLIENTB", "2026/CLIENTC"]);

    const output = shapeValidateStructure("example", "Compliance Reports", profile, snapshot, undefined, 3, false, {
      maxClients: 2,
    });

    expect(output.totals).toEqual({ clients: 3, compliant: 3, nonCompliant: 0, missing: 0 });
    expect(output.clients).toHaveLength(2);
    expect(output.listing).toEqual({ returned: 2, omitted: 1, cap: 2, truncated: true });
  });

  it("lists 50 non-conforming files for a client with 60 and reports the other 10 omitted", () => {
    const files = Array.from({ length: 60 }, (_, index) =>
      file(`2026/CLIENTA/09/bad-${String(index).padStart(2, "0")}.xlsx`),
    );
    const snapshot = snapshotOf(files, ["2026", "2026/CLIENTA", "2026/CLIENTA/09"]);

    const output = shapeValidateStructure("example", "Compliance Reports", profile, snapshot, undefined, 3, false, {});
    const clienta = output.clients.find((client) => client.client === "CLIENTA");

    expect(clienta?.verdict).toBe("non_compliant");
    expect(clienta?.nonConformingFiles).toHaveLength(MAX_CLIENT_DETAIL);
    expect(clienta?.nonConformingFilesOmitted).toBe(10);
  });

  it("excludes a file the Search cross-check found in a different library from every client's evaluation", () => {
    const snapshot = snapshotOf(
      [file("2026/CLIENTA/09/2026-09_CLIENTA_TRAINING.xlsx"), file("2026/CLIENTA/09/foreign.xlsx", { library: "Other Library" })],
      ["2026", "2026/CLIENTA", "2026/CLIENTA/09"],
    );

    const output = shapeValidateStructure("example", "Compliance Reports", profile, snapshot, undefined, 3, false, {});
    const clienta = output.clients.find((client) => client.client === "CLIENTA");

    expect(clienta?.verdict).toBe("compliant");
  });

  it("reports the graphRequests it was given", () => {
    const snapshot = snapshotOf([], ["2026", "2026/CLIENTA"]);

    const output = shapeValidateStructure("example", "Compliance Reports", profile, snapshot, undefined, 7, false, {});

    expect(output.graphRequests).toBe(7);
  });
});
