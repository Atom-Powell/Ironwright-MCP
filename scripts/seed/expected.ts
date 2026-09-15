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
 *
 * This module is also the seeder's only door into src/domain/, which is why
 * parseProfile lives here rather than in scripts/seed-library.ts: the engine
 * takes a validated Profile, the seeder starts from raw JSON, and one module
 * owning that conversion keeps the import boundary scripts/seed-library.ts's
 * header comment describes true of the whole script.
 */
import { ProfileSchema, type Profile } from "../../src/domain/profile/schema.js";
import { reconcile } from "../../src/domain/reconcile/index.js";
import type {
  Period,
  ReconciliationReport,
  RepositorySnapshot,
  WorkbookSnapshot,
} from "../../src/domain/reconcile/index.js";
import type { SeedPlan } from "../seed-library.js";
import { excelDateSerial } from "./rows.js";
import { workbookAncestorPaths, workbookLibraryPath } from "./workbook.js";
import type { OrphanKind } from "../../src/domain/reconcile/index.js";

export type { Profile };

const SEED_TIMESTAMP = "2000-01-01T00:00:00.000Z";

/**
 * The full-schema validation the engine requires, exported so a run can fail
 * on a bad profile before it writes anything. A profile that satisfies
 * loadSeedProfile's four-field check can still fail this one, and finding
 * that out after a complete seed against a live tenant costs the whole seed
 * and prints no expectation.
 */
export function parseProfile(rawProfile: unknown): Profile {
  return ProfileSchema.parse(rawProfile);
}

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

/**
 * The tree the plan describes, plus the tracking workbook the same run places
 * at the profile's identity.workbookPath and the folders created to hold it.
 *
 * The workbook belongs here because the live scan enumerates the whole
 * library and applies no exclusion for that path, so it is in the live
 * snapshot whether or not this prediction carries it. Leaving it out made the
 * printed expectation claim no orphans while the tool correctly reported one,
 * and a wrong expectation is worse than no expectation. Its path and its
 * folders come from the same workbookPath createSeedWorkbook writes to,
 * through that module's own helpers, so a change to where the workbook lands
 * moves both sides together.
 */
function repositorySnapshot(plan: SeedPlan, workbookPath: string): RepositorySnapshot {
  const filePaths = [...plan.tree.filePaths, workbookLibraryPath(workbookPath)];
  return {
    files: filePaths.map((path) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      size: 0,
      modified: SEED_TIMESTAMP,
      etag: "",
    })),
    folderPaths: [...plan.tree.folderPaths, ...workbookAncestorPaths(workbookPath)],
    scannedAt: SEED_TIMESTAMP,
    // The cross-check is phase 2c and has not been built, so the live scan
    // will carry false here too. Claiming true would make the prediction
    // differ from the run for a reason that has nothing to do with the seed.
    searchCrossCheckIncluded: false,
  };
}

export function expectedReport(profile: Profile, plan: SeedPlan, asOf: Period): ReconciliationReport {
  return reconcile(profile, workbookSnapshot(plan), repositorySnapshot(plan, profile.identity.workbookPath), asOf);
}

/**
 * One line per list the report carries, counted by walking the report's own
 * fields rather than from a set of field names written out here. An earlier
 * version printed the orphan count alone, under a line telling the operator
 * that anything not listed was a real finding, while emptyFolders carried a
 * row the whole time. Naming the lists by hand would go wrong the same way
 * the first time the engine grows another one.
 */
function listCounts(report: ReconciliationReport): string[] {
  return Object.entries(report)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([name, rows]) => `    ${name}: ${rows.length}`);
}

function formatPeriod(period: Period): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

function section(heading: string, rows: string[]): string[] {
  return [heading, ...(rows.length === 0 ? ["    (none)"] : rows)];
}

/**
 * States only what a given `OrphanKind` means, per the definition in
 * types.ts: `unrecognized` is a parse failure against both the canonical
 * template and every recognizer, `unexpected` is a clean parse into a client,
 * deliverable and period that no slot in this report expects. Naming a cause
 * for either would assert something the engine did not observe; this reads
 * the cause straight off the classification the engine already made.
 */
function orphanKindClause(kind: OrphanKind): string {
  switch (kind) {
    case "unrecognized":
      return "neither the naming template nor any recognizer in the profile matches its name, so the engine reports it as an unrecognized orphan";
    case "unexpected":
      return (
        "a recognizer in the profile matches its name, but no slot in this report expects the client, deliverable " +
        "and period it captured, so the engine reports it as an unexpected orphan"
      );
  }
}

export function formatExpectedReport(report: ReconciliationReport, workbookPath: string): string[] {
  const exceptions = report.artifacts.filter((artifact) => artifact.state !== "compliant");
  const workbookInLibrary = workbookLibraryPath(workbookPath);
  const workbookOrphan = report.orphans.find((orphan) => orphan.path === workbookInLibrary);

  return [
    "Expected report from the live reconciliation tool:",
    "  Every list this report carries, with the number of rows in it:",
    ...listCounts(report),
    // The deliverable is on the artifact line because a client owes both a
    // monthly and a quarterly artifact in every quarter-end month, and
    // without it those two findings print as the same characters, which the
    // finding-by-finding comparison the live sitting asks for cannot use.
    ...section(
      "  Artifacts that are not compliant:",
      exceptions.map(
        (artifact) =>
          `    ${artifact.client}  ${artifact.deliverable}  ${formatPeriod(artifact.period)}  ${artifact.state}`,
      ),
    ),
    ...section(
      "  Orphans:",
      report.orphans.map((orphan) => `    ${orphan.path}  ${orphan.kind}`),
    ),
    ...section(
      "  Empty folders:",
      report.emptyFolders.map((folderPath) => `    ${folderPath}`),
    ),
    ...section(
      "  Duplicates:",
      report.duplicates.map((duplicate) => `    ${duplicate.path}  ${duplicate.state}`),
    ),
    ...section(
      "  Workbook rows the reader rejected:",
      report.rejectedWorkbookRows.map(
        (row) => `    row ${row.row}  ${row.client ?? "(client unreadable)"}  ${row.reason}`,
      ),
    ),
    "",
    // Read off the predicted report rather than stated as a fact about every
    // run: this function can see whether the workbook is among the orphans it
    // is printing and, when it is, which kind the engine gave it, so it says
    // only that. It does not guess why a recognizer did or did not match, and
    // it does not guess why the workbook is absent from the list when it is:
    // absence could equally mean a recognizer matched it into a real
    // artifact slot, which this function never checked.
    workbookOrphan === undefined
      ? `${workbookInLibrary} is the tracking workbook this seed writes. It sits inside the library it describes, ` +
        "so the live scan enumerates it along with everything else, but the orphan list above does not name it. " +
        "This function only checks whether the workbook's path is among the predicted orphans, not why it is or " +
        "is not there. If the live tool reports an orphan at that path, it is this file, not a new finding."
      : `The orphan above at ${workbookInLibrary} is the tracking workbook this seed writes. It sits inside the ` +
        `library it describes, the scan excludes nothing at that path, and ${orphanKindClause(workbookOrphan.kind)}. ` +
        "That row is expected, not a finding against the tool.",
    "",
    "Compare the counts first, then the rows. Anything the live tool reports that is not listed above is a real",
    "finding. This expectation was computed by running the same engine the tool runs, so it cannot",
    "prove the engine is right. It checks the layers a fake cannot reach: Graph, Excel,",
    "Azure Table Storage, and the tool's own composition.",
  ];
}
