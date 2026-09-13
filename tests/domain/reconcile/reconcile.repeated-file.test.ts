import { describe, expect, it } from "vitest";
import { reconcile } from "../../../src/domain/reconcile/index.js";
import type { RepositoryFile, RepositorySnapshot } from "../../../src/domain/reconcile/index.js";
import { GOLDEN_AS_OF, loadProfile, loadRepository, loadWorkbook } from "./fixtures/load.js";

/**
 * A repository snapshot that lists one file twice used to produce a phantom
 * duplicate: the second entry became a second candidate for the same slot, one
 * copy won and the other was reported as a redundant duplicate at the winning
 * file's own path. The report then said, of one path, both that it was the
 * compliant artifact for a slot and that it was a superfluous copy of that
 * slot, and a move or cleanup plan reading the duplicate list would have
 * targeted the compliant file.
 *
 * A path names one item in a document library, so two entries for one path are
 * one file listed twice. Phase 2 builds its inventory on delta query, and a
 * delta enumeration can emit the same item on more than one page, which makes
 * this a transport artifact rather than a repository problem to report.
 */
const profile = loadProfile();
const workbook = loadWorkbook();
const repository = loadRepository();

const COMPLIANT_PATH = "2026/CLIENTA/01-January/2026-01_CLIENTA_Safety.xlsx";

function fileAt(path: string): RepositoryFile {
  const found = repository.files.find((candidate) => candidate.path === path);
  if (found === undefined) {
    throw new Error(`the fixture repository has no file at ${path}`);
  }
  return found;
}

function withRepeatOf(path: string): RepositorySnapshot {
  const original = fileAt(path);
  return { ...repository, files: [...repository.files, { ...original }] };
}

describe("a repository snapshot that lists the same path twice", () => {
  it("does not report the winning file as a duplicate of its own slot", () => {
    const report = reconcile(profile, workbook, withRepeatOf(COMPLIANT_PATH), GOLDEN_AS_OF);
    const january = report.artifacts.find(
      (artifact) => artifact.client === "CLIENTA" && artifact.deliverable === "monthly-safety" && artifact.period.month === 1,
    );

    expect(january?.state).toBe("compliant");
    expect(january?.matched?.path).toBe(COMPLIANT_PATH);
    expect(report.duplicates.map((duplicate) => duplicate.path)).not.toContain(COMPLIANT_PATH);
  });

  it("produces exactly the report the same snapshot produces without the repeat", () => {
    // The strongest form of the property, and the one that keeps a partial
    // fix honest: a repeated entry must change nothing at all, not merely
    // avoid one wrong duplicate row.
    const withRepeat = reconcile(profile, workbook, withRepeatOf(COMPLIANT_PATH), GOLDEN_AS_OF);
    const without = reconcile(profile, workbook, repository, GOLDEN_AS_OF);

    expect(JSON.stringify(withRepeat)).toBe(JSON.stringify(without));
  });

  it("is unaffected by where in the listing the repeat appears", () => {
    // Delta pages arrive in an order the engine does not control, so a repeat
    // ahead of its original must collapse the same way as one behind it.
    const original = fileAt(COMPLIANT_PATH);
    const repeatFirst: RepositorySnapshot = { ...repository, files: [{ ...original }, ...repository.files] };

    expect(JSON.stringify(reconcile(profile, workbook, repeatFirst, GOLDEN_AS_OF))).toBe(
      JSON.stringify(reconcile(profile, workbook, repository, GOLDEN_AS_OF)),
    );
  });

  it("still reports a genuine second copy at a different path as a duplicate", () => {
    // Guards the guard. Deduplicating by path must not become deduplicating
    // by filename: the fixture's Archive copy of the January file is a real
    // second copy at its own path and is exactly what the duplicate list is
    // for.
    const report = reconcile(profile, workbook, withRepeatOf(COMPLIANT_PATH), GOLDEN_AS_OF);

    expect(report.duplicates.map((duplicate) => duplicate.path)).toContain("2026/Archive/2026-01_CLIENTA_Safety.xlsx");
  });
});
