import type { ArtifactFinding, DuplicateFinding, ReconciliationReport } from "../../../src/domain/reconcile/index.js";

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
    // expectedPath is the expected folder, not a full file path; see the
    // comment in src/domain/rename/plan.ts's candidateFrom for why the two
    // are distinct and how this project mistook them once already.
    expectedPath: folder,
    expectedName,
    state: "misnamed",
    matched: { path: `${folder}/${currentName}`, name: currentName, etag: "inventory-etag" },
  };
}

/**
 * A losing candidate for the same slot `misnamed` above names, matching what
 * `matchArtifacts` actually produces for a second file competing for one
 * slot: the winner becomes the slot's one `ArtifactFinding`, and everything
 * else that also matched becomes a `DuplicateFinding` naming the slot it
 * lost. There is deliberately no "duplicate whose canonical name differs from
 * the slot's winner" helper: the canonical name is a pure function of the
 * slot, so every candidate for one slot shares one canonical name and no
 * other is reachable.
 */
export function misnamedDuplicate(client: string, currentName: string): DuplicateFinding {
  return {
    path: `2026/${client}/01-January/${currentName}`,
    name: currentName,
    slot: { client, deliverable: "MonthlyTraining", period: { year: 2026, month: 1 } },
    state: "misnamed",
  };
}
