import { describe, expect, it } from "vitest";
import { reconcile } from "../../../src/domain/reconcile/index.js";
import type { ArtifactFinding, Period } from "../../../src/domain/reconcile/index.js";
import { GOLDEN_AS_OF, loadExpectedReport, loadProfile, loadRepository, loadWorkbook } from "./fixtures/load.js";

/**
 * The acceptance test for the whole engine. Everything else in this directory
 * proves a stage does what its own unit test asked for; this proves the four
 * stages assembled together produce the right answer on one repository that
 * exercises every rule at once.
 *
 * `expected-report.json` was written by hand from the profile and the design
 * spec BEFORE the engine was run over these fixtures, and every one of the
 * thirteen required cases was reasoned out from the profile's own rules and
 * then compared against what the engine produced. That review is recorded,
 * case by case, in
 * `.superpowers/sdd/2026-09-13-reconciliation-engine/task-6-golden-audit.md`.
 * The engine agreed with the hand-derived report in every case, so nothing in
 * the golden file was adjusted to match output.
 *
 * That order matters and is the only thing that makes this file worth having.
 * A golden report generated from the engine and adopted without reading pins
 * whatever the code did on the day it ran, bugs included, and then defends
 * those bugs against every later fix. If a future change makes this test fail,
 * the question is which of the two is wrong, and the audit document is where
 * the answer for each case already is. Never edit the golden file to make a
 * diff go away.
 */
const profile = loadProfile();
const workbook = loadWorkbook();
const repository = loadRepository();
const expectedReport = loadExpectedReport();

function run(): ReturnType<typeof reconcile> {
  return reconcile(profile, workbook, repository, GOLDEN_AS_OF);
}

function artifact(client: string, deliverable: string, month: number): ArtifactFinding {
  const period: Period = { year: 2026, month };
  const found = run().artifacts.find(
    (candidate) =>
      candidate.client === client &&
      candidate.deliverable === deliverable &&
      candidate.period.year === period.year &&
      candidate.period.month === period.month,
  );
  if (found === undefined) {
    throw new Error(`the report has no artifact for ${client} / ${deliverable} / 2026-${month}`);
  }
  return found;
}

describe("the golden report", () => {
  it("matches the hand-reviewed report for the whole fixture repository", () => {
    expect(run()).toEqual(expectedReport);
  });

  it("serializes in the same field and row order as the golden file", () => {
    // toEqual above ignores key order, but the design makes ordering part of
    // the report's contract precisely so two runs produce the same bytes and a
    // person can diff two reports by hand. Comparing the serialized forms is
    // what actually pins that.
    expect(JSON.stringify(run())).toBe(JSON.stringify(expectedReport));
  });

  it("produces the same bytes on a second run over the same inputs", () => {
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

/**
 * One assertion per case the design's Testing section requires. The whole
 * report is already pinned above, so these add no coverage; they exist so a
 * failure names the rule that broke instead of handing a reviewer a
 * ten-artifact object diff to bisect.
 */
describe("the golden report, case by case", () => {
  it("a canonical name in the right folder is compliant", () => {
    const finding = artifact("CLIENTA", "monthly-safety", 1);

    expect(finding.state).toBe("compliant");
    expect(finding.matched?.path).toBe("2026/CLIENTA/01-January/2026-01_CLIENTA_Safety.xlsx");
    expect(finding.matched?.recognizerId).toBeUndefined();
  });

  it("a name the profile accepts only through an alias recognizer is compliant, and says which", () => {
    const finding = artifact("CLIENTA", "monthly-safety", 2);

    expect(finding.state).toBe("compliant");
    expect(finding.matched?.name).toBe("CLIENTA-202602-Safety.xlsx");
    expect(finding.matched?.recognizerId).toBe("alias-compact");
  });

  it("a legacy name in the right folder is misnamed", () => {
    const finding = artifact("CLIENTA", "monthly-safety", 3);

    expect(finding.state).toBe("misnamed");
    expect(finding.matched?.recognizerId).toBe("legacy-spaced");
  });

  it("a canonical name in the wrong folder is misplaced", () => {
    const finding = artifact("CLIENTA", "monthly-safety", 4);

    expect(finding.state).toBe("misplaced");
    expect(finding.expectedPath).toBe("2026/CLIENTA/04-April");
    expect(finding.matched?.path).toBe("2026/Inbox/2026-04_CLIENTA_Safety.xlsx");
  });

  it("a legacy name in the wrong folder is misnamed and misplaced", () => {
    const finding = artifact("CLIENTA", "monthly-safety", 5);

    expect(finding.state).toBe("misnamed_and_misplaced");
    expect(finding.matched?.path).toBe("2026/Archive/CLIENTA Safety - May 2026.xlsx");
  });

  it("a slot with no candidate anywhere is missing and carries no matched file", () => {
    const finding = artifact("CLIENTA", "monthly-safety", 6);

    expect(finding.state).toBe("missing");
    expect(finding.matched).toBeUndefined();
    expect(run().duplicates.some((duplicate) => duplicate.slot.period.month === 6)).toBe(false);
  });

  it("a second candidate for a claimed slot becomes a duplicate naming that slot", () => {
    const report = run();
    const january = report.duplicates.filter((duplicate) => duplicate.slot.period.month === 1);

    // The Archive copy is the more recently modified of the two, so recency
    // losing to the compliant candidate is the state ranking doing its job
    // rather than the tiebreak happening to agree with it.
    expect(january).toEqual([
      {
        path: "2026/Archive/2026-01_CLIENTA_Safety.xlsx",
        name: "2026-01_CLIENTA_Safety.xlsx",
        slot: { client: "CLIENTA", deliverable: "monthly-safety", period: { year: 2026, month: 1 } },
        state: "misplaced",
      },
    ]);
    expect(artifact("CLIENTA", "monthly-safety", 1).matched?.etag).toBe("etag-a01");
  });

  it("two equally-ranked candidates are separated by the more recent modification", () => {
    // Both April copies are canonical and both sit outside the expected
    // folder, so state cannot pick between them and only the tiebreak can.
    expect(artifact("CLIENTA", "monthly-safety", 4).matched?.etag).toBe("etag-a04-inbox");
    expect(run().duplicates.map((duplicate) => duplicate.path)).toContain("2026/Archive/2026-04_CLIENTA_Safety.xlsx");
  });

  it("a filename that does not parse at all is an unrecognized orphan", () => {
    const orphan = run().orphans.find((candidate) => candidate.name === "handover notes.txt");

    expect(orphan?.kind).toBe("unrecognized");
    expect(orphan?.parsed).toBeUndefined();
  });

  it("a filename that parses cleanly for a client who owes nothing is an unexpected orphan", () => {
    const orphan = run().orphans.find((candidate) => candidate.name === "2026-04_CLIENTC_Safety.xlsx");

    expect(orphan?.kind).toBe("unexpected");
    expect(orphan?.parsed).toEqual({ client: "CLIENTC", deliverable: "monthly-safety", period: { year: 2026, month: 4 } });
  });

  it("a folder with no file and no deeper folder beneath it is empty", () => {
    // "2026/CLIENTA/04-April" is empty because April's file was filed in
    // Inbox instead, and "2025/CLIENTA" is a leftover from an earlier year.
    expect(run().emptyFolders).toEqual(["2025/CLIENTA", "2026/CLIENTA/04-April"]);
  });

  it("a quarterly deliverable is owed once per quarter, filed under the anchored month", () => {
    const report = run();
    const quarterly = report.artifacts.filter((candidate) => candidate.deliverable === "quarterly-audit");

    // Six monthly periods span two quarters, and with the profile's "last"
    // anchor each quarter reports under its final month.
    expect(quarterly.map((candidate) => candidate.period)).toEqual([
      { year: 2026, month: 3 },
      { year: 2026, month: 6 },
    ]);
    expect(quarterly.map((candidate) => candidate.expectedName)).toEqual([
      "2026-03_CLIENTA_Audit.xlsx",
      "2026-06_CLIENTA_Audit.xlsx",
    ]);
  });

  it("a file naming a non-anchor month of a quarter satisfies that quarter's slot", () => {
    const finding = artifact("CLIENTA", "quarterly-audit", 6);

    // The file says April. Matching compares the anchored month, so it
    // satisfies the June slot rather than falling out as an orphan for a
    // quarter nobody owes.
    expect(finding.matched?.name).toBe("CLIENTA Audit 2026-04.xlsx");
    expect(finding.state).toBe("misnamed");
    expect(run().orphans.map((orphan) => orphan.name)).not.toContain("CLIENTA Audit 2026-04.xlsx");
  });

  it("a client's effective date excludes the periods before it", () => {
    const report = run();
    const clientB = report.artifacts.filter((candidate) => candidate.client === "CLIENTB");

    // CLIENTB is effective from 2026-05-15, so January through April are not
    // owed even though they fall inside the six-month window.
    expect(clientB.map((candidate) => candidate.period.month)).toEqual([5, 6]);

    // The repository holds a correctly named, correctly filed February file
    // for CLIENTB. It is an orphan rather than a compliant artifact, which is
    // what proves the exclusion happened rather than the period simply having
    // no file.
    const february = report.orphans.find((orphan) => orphan.name === "2026-02_CLIENTB_Safety.xlsx");
    expect(february?.kind).toBe("unexpected");
    expect(february?.parsed?.period).toEqual({ year: 2026, month: 2 });
  });

  it("a client who owes nothing still gets a summary, with zero counts and no artifacts", () => {
    const report = run();
    const clientC = report.clients.find((summary) => summary.client === "CLIENTC");

    expect(clientC).toEqual({
      client: "CLIENTC",
      counts: { compliant: 0, misnamed: 0, misplaced: 0, misnamed_and_misplaced: 0, missing: 0 },
      compliant: true,
    });
    expect(report.artifacts.some((candidate) => candidate.client === "CLIENTC")).toBe(false);
  });
});
