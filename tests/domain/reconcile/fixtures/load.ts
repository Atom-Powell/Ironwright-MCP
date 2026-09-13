import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ProfileSchema, type Profile } from "../../../../src/domain/profile/schema.js";
import type {
  Period,
  ReconciliationReport,
  RepositorySnapshot,
  WorkbookSnapshot,
} from "../../../../src/domain/reconcile/index.js";

/**
 * The fixtures are read from disk rather than declared as TypeScript objects
 * so that the golden report is a plain artifact a reviewer can diff and read
 * on its own, without a compiler between them and it. Reading files is I/O,
 * which is why this lives under `tests/` and not under `src/domain/`: the
 * purity rule constrains the engine, not the harness that feeds it.
 */
const fixturesDir = fileURLToPath(new URL(".", import.meta.url));

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixturesDir}${name}`, "utf8"));
}

/**
 * Parsed through the real schema rather than cast, so the fixture profile has
 * to be a profile the product would actually accept. A cast would let the
 * golden report be pinned against a profile no deployment could load.
 */
export function loadProfile(): Profile {
  return ProfileSchema.parse(readFixture("profile.json"));
}

// The workbook and repository snapshots have no runtime validator of their
// own: phase 2 constructs them from Graph responses, so their only contract is
// the TypeScript one, and a cast is what a test can honestly assert here.
export function loadWorkbook(): WorkbookSnapshot {
  return readFixture("workbook.json") as WorkbookSnapshot;
}

export function loadRepository(): RepositorySnapshot {
  return readFixture("repository.json") as RepositorySnapshot;
}

export function loadExpectedReport(): ReconciliationReport {
  return readFixture("expected-report.json") as ReconciliationReport;
}

/**
 * The reference month the golden report was computed for. Fixed, and passed in
 * as an argument, because the engine never reads a clock: a golden file
 * compared against a report derived from "now" would start failing the moment
 * the month changed, which would teach whoever hit it to distrust the test
 * rather than the change.
 */
export const GOLDEN_AS_OF: Period = { year: 2026, month: 6 };
