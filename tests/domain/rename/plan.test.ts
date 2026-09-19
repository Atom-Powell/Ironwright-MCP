import { describe, expect, it } from "vitest";
import { pairMisnamedArtifacts } from "../../../src/domain/rename/plan.js";
import type { ArtifactFinding, ReconciliationReport } from "../../../src/domain/reconcile/index.js";

export function report(artifacts: ArtifactFinding[], overrides: Partial<ReconciliationReport> = {}): ReconciliationReport {
  return {
    profileId: "example",
    window: { from: { year: 2026, month: 1 }, to: { year: 2026, month: 1 } },
    provenance: { scannedAt: "2026-09-18T12:00:00Z", searchCrossCheckIncluded: true, workbookSource: "w.xlsx" },
    artifacts,
    duplicates: [],
    orphans: [],
    emptyFolders: [],
    clients: [],
    rejectedWorkbookRows: [],
    ...overrides,
  };
}

export function misnamed(client: string, currentName: string, expectedName: string): ArtifactFinding {
  const folder = `2026/${client}/01-January`;
  return {
    client,
    deliverable: "MonthlyTraining",
    period: { year: 2026, month: 1 },
    expectedPath: `${folder}/${expectedName}`,
    expectedName,
    state: "misnamed",
    matched: { path: `${folder}/${currentName}`, name: currentName, etag: "inventory-etag" },
  };
}

describe("pairMisnamedArtifacts", () => {
  it("pairs a misnamed file with its canonical name in the same folder", () => {
    const pairing = pairMisnamedArtifacts(
      report([misnamed("CLIENTA", "vendor training.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx")]),
    );

    expect(pairing.collisions).toEqual([]);
    expect(pairing.candidates).toEqual([
      {
        path: "2026/CLIENTA/01-January/vendor training.xlsx",
        currentName: "vendor training.xlsx",
        targetName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
        targetPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
        client: "CLIENTA",
      },
    ]);
  });

  it("ignores every artifact state other than misnamed", () => {
    const compliant: ArtifactFinding = {
      ...misnamed("CLIENTA", "a.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx"),
      state: "compliant",
    };
    const misplaced: ArtifactFinding = {
      ...misnamed("CLIENTB", "b.xlsx", "2026-01_CLIENTB_MonthlyTraining.xlsx"),
      state: "misnamed_and_misplaced",
    };
    const missing: ArtifactFinding = {
      client: "CLIENTC",
      deliverable: "MonthlyTraining",
      period: { year: 2026, month: 1 },
      expectedPath: "2026/CLIENTC/01-January/2026-01_CLIENTC_MonthlyTraining.xlsx",
      expectedName: "2026-01_CLIENTC_MonthlyTraining.xlsx",
      state: "missing",
    };

    const pairing = pairMisnamedArtifacts(report([compliant, misplaced, missing]));

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions).toEqual([]);
  });

  it("carries every client through, since scoping is the caller's job", () => {
    const pairing = pairMisnamedArtifacts(
      report([
        misnamed("CLIENTA", "a.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx"),
        misnamed("CLIENTB", "b.xlsx", "2026-01_CLIENTB_MonthlyTraining.xlsx"),
      ]),
    );

    expect(pairing.candidates.map((candidate) => candidate.client)).toEqual(["CLIENTA", "CLIENTB"]);
  });
});
