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
