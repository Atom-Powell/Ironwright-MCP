import { describe, expect, it } from "vitest";
import { executeMovePlanText } from "../../../src/tools/move/text.js";
import type { ExecuteMovePlanOutput } from "../../../src/tools/move/output.js";

/** A minimal, complete output; each test overrides only the fields it is about. */
function output(overrides: Partial<ExecuteMovePlanOutput> = {}): ExecuteMovePlanOutput {
  return {
    planId: "mov-2026-09-24-a1b2c3d4",
    profileId: "example",
    driveId: "drive-1",
    dryRun: false,
    results: [],
    resultCount: 0,
    resultsOmitted: 0,
    counts: { moved: 0, wouldMove: 0, preconditionRefused: 0, targetNameTaken: 0, notFound: 0, failed: 0 },
    excluded: [],
    excludedCount: 0,
    excludedOmitted: 0,
    reversalEntriesNotRefreshed: 0,
    graphOperationsIssued: 0,
    ...overrides,
  };
}

describe("executeMovePlanText", () => {
  it("states every count of a confirmed run in one sentence", () => {
    const lines = executeMovePlanText(
      output({ counts: { moved: 1, wouldMove: 0, preconditionRefused: 2, targetNameTaken: 3, notFound: 0, failed: 4 } }),
    );

    expect(lines[0]).toBe("Applied plan mov-2026-09-24-a1b2c3d4 against drive drive-1.");
    expect(lines[1]).toBe(
      "1 moved, 2 refused because the item there is not the one the plan recorded, 3 refused because another " +
        "file already holds the target name, 0 no longer at the planned path, 4 failed.",
    );
  });

  it("names the library an excluded file was found in, as the generated plan's text does", () => {
    const lines = executeMovePlanText(
      output({
        excluded: [
          {
            path: "2026/ACME/09-September/2026-09_ACME_MonthlyTraining.xlsx",
            currentName: "2026-09_ACME_MonthlyTraining.xlsx",
            targetName: "2026-09_ACME_MonthlyTraining.xlsx",
            client: "ACME",
            reason: "in_another_library",
            library: "Archive",
          },
          {
            path: "2026/ACME/08-August/2026-09_ACME_MonthlyTraining.xlsx",
            currentName: "2026-09_ACME_MonthlyTraining.xlsx",
            targetName: "2026-09_ACME_MonthlyTraining.xlsx",
            client: "ACME",
            reason: "target_folder_absent",
          },
        ],
        excludedCount: 2,
      }),
    );

    expect(lines).toContain(
      '  excluded at plan time: 2026/ACME/09-September/2026-09_ACME_MonthlyTraining.xlsx (in_another_library, found in library "Archive")',
    );
    expect(lines).toContain("  excluded at plan time: 2026/ACME/08-August/2026-09_ACME_MonthlyTraining.xlsx (target_folder_absent)");
  });
});
