import { describe, expect, it } from "vitest";
import { generatePlanText } from "../../../src/tools/rename/text.js";
import type { GenerateRenamePlanOutput } from "../../../src/tools/rename/output.js";

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
