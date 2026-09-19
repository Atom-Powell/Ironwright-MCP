import { describe, expect, it } from "vitest";
import { executePlanText, generatePlanText } from "../../../src/tools/rename/text.js";
import type { ExecuteRenamePlanOutput, GenerateRenamePlanOutput } from "../../../src/tools/rename/output.js";

/**
 * A minimal, complete output. Every test below overrides only the fields it
 * is about, so a field this suite does not name still has to be a value
 * `GenerateRenamePlanOutput` could actually carry.
 */
function output(overrides: Partial<GenerateRenamePlanOutput> = {}): GenerateRenamePlanOutput {
  return {
    planId: "rnm-2026-09-18-a1b2c3d4",
    profileId: "example",
    library: "Compliance Reports",
    driveId: "drive-1",
    createdAt: "2026-09-18T12:00:00Z",
    scannedAt: "2026-09-18T09:00:00Z",
    items: [],
    itemCount: 0,
    itemsOmitted: 0,
    excluded: [],
    excludedCount: 0,
    excludedOmitted: 0,
    workbookReadGraphRequestsByThisCall: 2,
    etagLookupsIssued: 0,
    scanGraphRequestsByThisCall: 3,
    scanSharedWithConcurrentCall: false,
    ...overrides,
  };
}

describe("generatePlanText", () => {
  it("names the plan, profile and library on the first line", () => {
    const lines = generatePlanText(output({ planId: "rnm-2026-09-18-a1b2c3d4", profileId: "example", library: "Compliance Reports" }));

    expect(lines[0]).toBe('Plan rnm-2026-09-18-a1b2c3d4 for profile "example", library "Compliance Reports".');
  });

  it("uses the singular for exactly one rename and states the scan timestamp", () => {
    const lines = generatePlanText(
      output({
        items: [
          {
            path: "2026/ACME/09-September/2026-09_ACME_VendorTraining.xlsx",
            currentName: "2026-09_ACME_VendorTraining.xlsx",
            targetName: "2026-09_ACME_MonthlyTraining.xlsx",
            targetPath: "2026/ACME/09-September/2026-09_ACME_MonthlyTraining.xlsx",
            client: "ACME",
          },
        ],
        itemCount: 1,
        scannedAt: "2026-09-18T09:00:00Z",
      }),
    );

    expect(lines[1]).toBe("1 rename planned, 0 excluded.");
    expect(lines[2]).toBe("Based on a repository scan taken at 2026-09-18T09:00:00Z.");
  });

  it("uses the plural for zero and for more than one", () => {
    expect(generatePlanText(output({ itemCount: 0 }))[1]).toBe("0 renames planned, 0 excluded.");
    expect(generatePlanText(output({ itemCount: 2 }))[1]).toBe("2 renames planned, 0 excluded.");
  });

  it("lists each item as a from-arrow-to line", () => {
    const lines = generatePlanText(
      output({
        items: [
          {
            path: "2026/ACME/09-September/wrong.xlsx",
            currentName: "wrong.xlsx",
            targetName: "2026-09_ACME_MonthlyTraining.xlsx",
            targetPath: "2026/ACME/09-September/2026-09_ACME_MonthlyTraining.xlsx",
            client: "ACME",
          },
        ],
        itemCount: 1,
      }),
    );

    expect(lines).toContain("  2026/ACME/09-September/wrong.xlsx -> 2026-09_ACME_MonthlyTraining.xlsx");
  });

  it("says how many items the listing left out, and says nothing when it left out none", () => {
    const truncated = generatePlanText(output({ itemCount: 60, itemsOmitted: 10 }));
    expect(truncated).toContain("  ...and 10 more, all of them in the stored plan.");

    const complete = generatePlanText(output({ itemCount: 5, itemsOmitted: 0 }));
    expect(complete.some((line) => line.includes("more, all of them"))).toBe(false);
  });

  it("lists each excluded item with its reason, and says how many the listing left out", () => {
    const lines = generatePlanText(
      output({
        excluded: [
          {
            path: "2026/ACME/09-September/wrong.xlsx",
            currentName: "wrong.xlsx",
            targetName: "2026-09_ACME_MonthlyTraining.xlsx",
            client: "ACME",
            reason: "target_path_already_occupied",
          },
        ],
        excludedCount: 60,
        excludedOmitted: 10,
      }),
    );

    expect(lines).toContain("  excluded: 2026/ACME/09-September/wrong.xlsx (target_path_already_occupied)");
    expect(lines).toContain("  ...and 10 more exclusions, all of them in the stored plan.");
  });

  it("pins the Graph cost line exactly, since this is the cost claim phase 4b and 4c both found defects in", () => {
    const lines = generatePlanText(
      output({ workbookReadGraphRequestsByThisCall: 2, scanGraphRequestsByThisCall: 4, etagLookupsIssued: 3 }),
    );

    expect(lines).toContain(
      "Graph requests: 2 for the workbook, 4 for the scan. 3 etag lookups issued, not counted as Graph requests " +
        "since a retried lookup can spend more than one.",
    );
  });

  it("reports zero etag lookups issued as a plain zero, not as an omitted line", () => {
    const lines = generatePlanText(output({ etagLookupsIssued: 0 }));

    expect(lines).toContain(
      "Graph requests: 2 for the workbook, 3 for the scan. 0 etag lookups issued, not counted as Graph requests " +
        "since a retried lookup can spend more than one.",
    );
  });

  it("ends by pointing at execute_rename_plan and naming the dry-run default", () => {
    const lines = generatePlanText(output());

    expect(lines[lines.length - 1]).toBe(
      "Review this plan, then apply it with execute_rename_plan. It runs as a dry run unless confirm is true.",
    );
  });
});

/**
 * A minimal, complete output, mirroring `output()` above. Every test overrides
 * only the fields it is about.
 */
function execOutput(overrides: Partial<ExecuteRenamePlanOutput> = {}): ExecuteRenamePlanOutput {
  return {
    planId: "rnm-2026-09-18-a1b2c3d4",
    profileId: "example",
    driveId: "drive-1",
    dryRun: true,
    results: [],
    resultCount: 0,
    resultsOmitted: 0,
    counts: { renamed: 0, wouldRename: 0, preconditionRefused: 0, notFound: 0, failed: 0 },
    excluded: [],
    excludedCount: 0,
    excludedOmitted: 0,
    reversalEntriesNotRefreshed: 0,
    graphOperationsIssued: 0,
    ...overrides,
  };
}

describe("executePlanText", () => {
  it("states a dry run on the first line, naming the drive it would write to, and that nothing was changed", () => {
    const lines = executePlanText(execOutput({ planId: "rnm-2026-09-18-a1b2c3d4", driveId: "drive-1" }));

    expect(lines[0]).toBe("Dry run of plan rnm-2026-09-18-a1b2c3d4 against drive drive-1. Nothing was changed.");
  });

  it("uses the singular for exactly one would-be rename and the plural otherwise", () => {
    expect(executePlanText(execOutput({ counts: { renamed: 0, wouldRename: 1, preconditionRefused: 0, notFound: 0, failed: 0 } }))[1]).toBe(
      "1 rename would be attempted.",
    );
    expect(executePlanText(execOutput({ counts: { renamed: 0, wouldRename: 0, preconditionRefused: 0, notFound: 0, failed: 0 } }))[1]).toBe(
      "0 renames would be attempted.",
    );
    expect(executePlanText(execOutput({ counts: { renamed: 0, wouldRename: 2, preconditionRefused: 0, notFound: 0, failed: 0 } }))[1]).toBe(
      "2 renames would be attempted.",
    );
  });

  it("says on a dry run that it checked no preconditions", () => {
    const lines = executePlanText(execOutput());

    expect(lines).toContain(
      "This preview contacted Graph not at all, so it did not check whether any file has changed since the plan " +
        "was generated. Those refusals can only appear in a confirmed run.",
    );
  });

  it("states a confirmed run's outcome counts on the second line", () => {
    const lines = executePlanText(
      execOutput({
        dryRun: false,
        counts: { renamed: 3, wouldRename: 0, preconditionRefused: 1, notFound: 2, failed: 4 },
      }),
    );

    expect(lines[0]).toBe("Applied plan rnm-2026-09-18-a1b2c3d4 against drive drive-1.");
    expect(lines[1]).toBe("3 renamed, 1 refused because the item there is not the one the plan recorded, 2 no longer at the planned path, 4 failed.");
  });

  it("lists each result as a from-arrow-to-outcome line", () => {
    const lines = executePlanText(
      execOutput({
        dryRun: false,
        results: [
          {
            path: "2026/ACME/01-January/wrong.xlsx",
            currentName: "wrong.xlsx",
            targetName: "2026-01_ACME_MonthlyTraining.xlsx",
            targetPath: "2026/ACME/01-January/2026-01_ACME_MonthlyTraining.xlsx",
            client: "ACME",
            outcome: "renamed",
          },
        ],
        resultCount: 1,
      }),
    );

    expect(lines).toContain("  2026/ACME/01-January/wrong.xlsx -> 2026-01_ACME_MonthlyTraining.xlsx (renamed)");
  });

  it("says how many results the listing left out, and says nothing when it left out none", () => {
    const truncated = executePlanText(execOutput({ resultCount: 60, resultsOmitted: 10 }));
    expect(truncated).toContain("  ...and 10 more, all of them counted above.");

    const complete = executePlanText(execOutput({ resultCount: 5, resultsOmitted: 0 }));
    expect(complete.some((line) => line.includes("more, all of them counted above"))).toBe(false);
  });

  it("lists each excluded item under its own label, distinct from generatePlanText's", () => {
    const lines = executePlanText(
      execOutput({
        excluded: [
          {
            path: "2026/ACME/02-February/other.xlsx",
            currentName: "other.xlsx",
            targetName: "2026-02_ACME_MonthlyTraining.xlsx",
            client: "ACME",
            reason: "target_path_already_occupied",
          },
        ],
        excludedCount: 1,
      }),
    );

    expect(lines).toContain("  excluded at plan time: 2026/ACME/02-February/other.xlsx (target_path_already_occupied)");
  });

  it("says how many exclusions the listing left out, and says nothing when it left out none", () => {
    const truncated = executePlanText(execOutput({ excludedCount: 60, excludedOmitted: 10 }));
    expect(truncated).toContain("  ...and 10 more exclusions, all of them counted above.");

    const complete = executePlanText(execOutput({ excludedCount: 5, excludedOmitted: 0 }));
    expect(complete.some((line) => line.includes("more exclusions"))).toBe(false);
  });

  it("names the reversal plan and how to apply it, and says nothing on a dry run", () => {
    const withReversal = executePlanText(execOutput({ dryRun: false, reversalPlanId: "rev-2026-09-18-ffffffff" }));
    expect(withReversal).toContain("Reversal plan rev-2026-09-18-ffffffff. Apply it with this same tool to roll this run back.");

    const dryRun = executePlanText(execOutput());
    expect(dryRun.some((line) => line.startsWith("Reversal plan"))).toBe(false);
  });

  it("uses the singular for exactly one unrefreshed reversal entry and the plural otherwise, saying nothing at zero", () => {
    const one = executePlanText(execOutput({ dryRun: false, reversalEntriesNotRefreshed: 1 }));
    expect(one).toContain(
      "1 reversal entry could not be given the file's new ETag, so replaying the reversal will refuse those " +
        "items rather than undo them. Generate a fresh plan for those files.",
    );

    const two = executePlanText(execOutput({ dryRun: false, reversalEntriesNotRefreshed: 2 }));
    expect(two).toContain(
      "2 reversal entries could not be given the file's new ETag, so replaying the reversal will refuse those " +
        "items rather than undo them. Generate a fresh plan for those files.",
    );

    const zero = executePlanText(execOutput({ dryRun: false, reversalEntriesNotRefreshed: 0 }));
    expect(zero.some((line) => line.includes("reversal entr"))).toBe(false);
  });

  it("says which plan a rollback undoes, and says nothing when the plan is a forward one", () => {
    // Without this line a rollback's report is shape-identical to a forward
    // run's, and an operator reading one cannot tell which they are looking at.
    const rollback = executePlanText(execOutput({ dryRun: false, reverses: "rnm-2026-09-18-a1b2c3d4" }));
    expect(rollback).toContain("This plan reverses plan rnm-2026-09-18-a1b2c3d4.");

    const forward = executePlanText(execOutput({ dryRun: false }));
    expect(forward.some((line) => line.startsWith("This plan reverses"))).toBe(false);
  });

  it("ends with the Graph operations line", () => {
    const lines = executePlanText(execOutput({ graphOperationsIssued: 7 }));

    expect(lines[lines.length - 1]).toBe("Graph operations issued: 7.");
  });
});
