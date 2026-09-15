/**
 * Predicts the report the live tool should return over what this seed just
 * wrote, by running the engine over in-memory snapshots of it.
 *
 * This asks the engine to predict itself, so the two sides agree by
 * construction on anything the engine gets wrong. It cannot be engine
 * evidence, and the printed output says so. What a mismatch catches is the
 * live path returning something different from what was seeded: Graph, Excel,
 * Azure Table Storage and the tool's composition, which is the set of layers
 * no fake can reach.
 */
import { ProfileSchema } from "../../src/domain/profile/schema.js";
import { reconcile } from "../../src/domain/reconcile/index.js";
import type {
  Period,
  ReconciliationReport,
  RepositorySnapshot,
  WorkbookSnapshot,
} from "../../src/domain/reconcile/index.js";
import type { SeedPlan } from "../seed-library.js";
import { excelDateSerial } from "./rows.js";

const SEED_TIMESTAMP = "2000-01-01T00:00:00.000Z";

function workbookSnapshot(plan: SeedPlan): WorkbookSnapshot {
  // Built from the plan rather than by reading back what was written: this is
  // the prediction, and a prediction that read the live workbook would be
  // asserting the thing it is supposed to be checking.
  const effectiveFrom = `${plan.year}-01-01`;
  return {
    rows: plan.workbookClients.map((client) => ({
      client,
      fields: { monthlyTraining: "Yes", quarterlyPhishing: "Yes", effectiveFrom: excelDateSerial(plan.year, 1, 1) },
      effectiveFrom,
    })),
    source: "seeded by npm run seed-library",
    rejectedRows: [],
  };
}

function repositorySnapshot(plan: SeedPlan): RepositorySnapshot {
  return {
    files: plan.tree.filePaths.map((path) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      size: 0,
      modified: SEED_TIMESTAMP,
      etag: "",
    })),
    folderPaths: [...plan.tree.folderPaths],
    scannedAt: SEED_TIMESTAMP,
    // The cross-check is phase 2c and has not been built, so the live scan
    // will carry false here too. Claiming true would make the prediction
    // differ from the run for a reason that has nothing to do with the seed.
    searchCrossCheckIncluded: false,
  };
}

export function expectedReport(rawProfile: unknown, plan: SeedPlan, asOf: Period): ReconciliationReport {
  const profile = ProfileSchema.parse(rawProfile);
  return reconcile(profile, workbookSnapshot(plan), repositorySnapshot(plan), asOf);
}

export function formatExpectedReport(report: ReconciliationReport): string[] {
  const exceptions = report.artifacts.filter((artifact) => artifact.state !== "compliant");
  return [
    "Expected report from the live reconciliation tool:",
    ...exceptions.map((artifact) => `  ${artifact.client}  ${artifact.period.year}-${String(artifact.period.month).padStart(2, "0")}  ${artifact.state}`),
    `  orphans: ${report.orphans.length}`,
    "",
    "Anything the live tool reports that is not listed above is a real finding.",
    "This expectation was computed by running the same engine the tool runs, so it cannot",
    "prove the engine is right. It checks the layers a fake cannot reach: Graph, Excel,",
    "Azure Table Storage, and the tool's own composition.",
  ];
}
