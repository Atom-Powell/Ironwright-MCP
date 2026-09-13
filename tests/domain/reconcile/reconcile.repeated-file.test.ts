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

/**
 * The same collapse, where the two entries for one path disagree about the
 * file's own metadata.
 *
 * Identical repeats, which is all the cases above use, cannot tell a
 * position-based collapse from a content-based one. These can. A rule that
 * kept whichever entry was listed last gave two different reports for one set
 * of entries, and `RepositorySnapshot.files` promises no ordering at all: a
 * phase-2 mapping layer that merged a delta page with a Search cross-check
 * would destroy whatever order either of them had. The ETag the surviving
 * entry carries is what a phase-4 rename or move plan uses as its If-Match
 * precondition, so the wrong survivor is a stale precondition against a real
 * client file.
 *
 * Two candidate paths for one slot, both canonically named and both outside
 * the expected folder, so both are misplaced and the state ranking cannot
 * separate them. Only the modification date can, which is what makes the
 * collapse's choice of survivor visible in the report.
 */
const JANUARY_SLOT = { client: "CLIENTA", deliverable: "monthly-safety", month: 1 };

function conflictingFile(path: string, modified: string, etag: string): RepositoryFile {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), size: 2048, modified, etag };
}

const A_OLD = conflictingFile("2026/Archive/2026-01_CLIENTA_Safety.xlsx", "2026-01-01T00:00:00Z", "etag-a-old");
const A_NEW = conflictingFile("2026/Archive/2026-01_CLIENTA_Safety.xlsx", "2026-09-01T00:00:00Z", "etag-a-new");
const B = conflictingFile("2026/Inbox/2026-01_CLIENTA_Safety.xlsx", "2026-05-01T00:00:00Z", "etag-b");

function snapshotOf(...files: RepositoryFile[]): RepositorySnapshot {
  return { files, folderPaths: [], scannedAt: "2026-07-03T09:00:00Z", searchCrossCheckIncluded: true };
}

function januaryOf(report: ReturnType<typeof reconcile>) {
  const found = report.artifacts.find(
    (artifact) =>
      artifact.client === JANUARY_SLOT.client &&
      artifact.deliverable === JANUARY_SLOT.deliverable &&
      artifact.period.month === JANUARY_SLOT.month,
  );
  if (found === undefined) {
    throw new Error("the report has no January artifact for CLIENTA / monthly-safety");
  }
  return found;
}

function januaryDuplicatesOf(report: ReturnType<typeof reconcile>) {
  return report.duplicates.filter((duplicate) => duplicate.slot.period.month === JANUARY_SLOT.month);
}

describe("a repository snapshot whose two entries for one path disagree", () => {
  it("keeps the most recently modified of the two", () => {
    const report = reconcile(profile, workbook, snapshotOf(A_OLD, B, A_NEW), GOLDEN_AS_OF);

    expect(januaryOf(report).matched?.path).toBe(A_NEW.path);
    expect(januaryOf(report).matched?.etag).toBe("etag-a-new");
  });

  it("resolves the repeat the same way whatever order the entries arrive in", () => {
    // The property last-wins broke, and the reason for changing the rule
    // rather than documenting an ordering contract: the engine already
    // answers "which record of a file is current" by most recently modified,
    // in compareCandidates, and it answers it without reading position. Two
    // rules for one question is the shape of the defect this wave started on.
    const orderings = [
      [A_OLD, B, A_NEW],
      [A_NEW, B, A_OLD],
      [B, A_NEW, A_OLD],
      [A_NEW, A_OLD, B],
    ];
    const reports = orderings.map((files) => JSON.stringify(reconcile(profile, workbook, snapshotOf(...files), GOLDEN_AS_OF)));

    expect(new Set(reports).size).toBe(1);
  });

  it("names the same winner and the same duplicate row whatever the order", () => {
    // Spelled out rather than left to the whole-report comparison above, so a
    // failure says which of the two an ordering change moved.
    const forward = reconcile(profile, workbook, snapshotOf(A_OLD, B, A_NEW), GOLDEN_AS_OF);
    const reversed = reconcile(profile, workbook, snapshotOf(A_NEW, B, A_OLD), GOLDEN_AS_OF);

    expect(januaryOf(reversed).matched).toEqual(januaryOf(forward).matched);
    expect(januaryDuplicatesOf(reversed)).toEqual(januaryDuplicatesOf(forward));
    expect(januaryDuplicatesOf(forward).map((duplicate) => duplicate.path)).toEqual([B.path]);
  });

  it("breaks an exact modification tie without reading position", () => {
    // Two entries for one path stamped at the same instant still have to
    // collapse to one answer that does not depend on which was listed first.
    // The ETag is the tiebreak, compared as a plain string the way every
    // other ordering in the report is.
    const high = { ...A_OLD, etag: "etag-a-zz" };
    const low = { ...A_OLD, etag: "etag-a-aa" };

    const forward = reconcile(profile, workbook, snapshotOf(low, high), GOLDEN_AS_OF);
    const reversed = reconcile(profile, workbook, snapshotOf(high, low), GOLDEN_AS_OF);

    expect(januaryOf(forward).matched?.etag).toBe("etag-a-zz");
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it("reports one artifact and one duplicate for the slot, not two of either", () => {
    // Guards the guard. All four assertions above would hold over a report
    // that had stopped collapsing at all and simply agreed with itself, so
    // this pins that the three entries still resolve to one winner and one
    // duplicate rather than to two candidates for one path.
    const report = reconcile(profile, workbook, snapshotOf(A_OLD, B, A_NEW), GOLDEN_AS_OF);

    expect(report.artifacts.filter((artifact) => artifact.period.month === 1)).toHaveLength(1);
    expect(januaryDuplicatesOf(report)).toHaveLength(1);
  });
});
