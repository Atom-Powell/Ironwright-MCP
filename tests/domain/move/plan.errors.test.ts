import { describe, expect, it } from "vitest";
import { MisplacedArtifactShapeError, pairMisplacedArtifacts } from "../../../src/domain/move/plan.js";
import type { ReconciliationReport } from "../../../src/domain/reconcile/index.js";

function reportWith(artifact: ReconciliationReport["artifacts"][number]): ReconciliationReport {
  return { artifacts: [artifact], duplicates: [], orphans: [] } as unknown as ReconciliationReport;
}

describe("pairMisplacedArtifacts refusals", () => {
  it("refuses a misplaced finding whose file already sits in its expected folder", () => {
    const report = reportWith({
      client: "C",
      deliverable: "d",
      period: { year: 2026, month: 6 },
      expectedPath: "2026/C/06-June",
      expectedName: "right.xlsx",
      state: "misplaced",
      matched: { path: "2026/C/06-June/right.xlsx", name: "right.xlsx", etag: "e" },
    });

    expect(() => pairMisplacedArtifacts(report, ["2026/C/06-June"])).toThrow(MisplacedArtifactShapeError);
  });
});
