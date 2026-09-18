import { describe, expect, it } from "vitest";
import { describeWorkbookText } from "../../../src/tools/describe/text.js";
import type { DescribeToolOutput } from "../../../src/tools/describe/output.js";

// Every figure below is distinct from every other, within each fixture and
// across the two truncation branches, the same discipline inventoryText's
// own tests follow: a transposition between returned, omitted and cap must
// change the rendered sentence, not merely leave it looking plausible.

const INVENTORY_WHOLE: DescribeToolOutput = {
  siteUrl: "https://contoso.sharepoint.com/sites/Example",
  readAt: "2026-09-18T09:15:00.000Z",
  library: "Documents",
  workbookPath: "Trackers/Book.xlsx",
  mode: "inventory",
  sheets: [
    { name: "Tracking", usedRange: "A1:D12", rows: 12, columns: 4 },
    { name: "Notes", usedRange: "A1:A3", rows: 3, columns: 1 },
  ],
  sheetsListing: { returned: 2, omitted: 0, cap: 200, truncated: false },
  tables: [{ name: "ClientTable", sheet: "Tracking", ref: "A1:D12", rows: 12, columns: 4, hasHeaderRow: true }],
  tablesListing: { returned: 1, omitted: 0, cap: 200, truncated: false },
  unresolved: [],
  samplesWithheld: false,
  graphRequests: 5,
};

describe("describeWorkbookText, inventory mode", () => {
  it("names the workbook, library, and resolved totals in one sentence", () => {
    const lines = describeWorkbookText(INVENTORY_WHOLE);

    expect(lines[0]).toBe(
      'Workbook "Trackers/Book.xlsx" in library "Documents" on https://contoso.sharepoint.com/sites/Example, ' +
        "read at 2026-09-18T09:15:00.000Z: 2 worksheets and 1 table resolved.",
    );
  });

  it("states cleanly resolved wiring as its own sentence when nothing is unresolved", () => {
    const lines = describeWorkbookText(INVENTORY_WHOLE);

    // "this tool tracked", not "this workbook declares": findTables in
    // xlsx.ts can skip a table part (one with a ref but no name) before
    // either the resolved counts or unresolved ever see it, so this sentence
    // must not claim totality against the workbook's own declared set. See
    // the regression in tests/tools/describe/run.test.ts.
    expect(lines[1]).toBe("Every worksheet and table this tool tracked resolved cleanly; none is reported as unresolved.");
  });

  it("states plainly that no source was named and what to do next", () => {
    const lines = describeWorkbookText(INVENTORY_WHOLE);

    expect(lines[2]).toBe(
      "No source was named, so this call proposes no header row and describes no columns. Call again naming " +
        "one of the tables or worksheets above as source to describe it in full.",
    );
  });

  it("states the Graph cost as its own sentence", () => {
    const lines = describeWorkbookText(INVENTORY_WHOLE);

    expect(lines[3]).toBe("This call cost 5 Graph requests.");
  });

  it("uses the singular for a single Graph request", () => {
    const single: DescribeToolOutput = { ...INVENTORY_WHOLE, graphRequests: 1 };
    expect(describeWorkbookText(single).at(-1)).toBe("This call cost 1 Graph request.");
  });

  it("states each truncated listing with its returned, omitted, and cap counts in their own place", () => {
    const truncated: DescribeToolOutput = {
      ...INVENTORY_WHOLE,
      sheetsListing: { returned: 3, omitted: 2, cap: 3, truncated: true },
      tablesListing: { returned: 6, omitted: 7, cap: 6, truncated: true },
    };

    const lines = describeWorkbookText(truncated);

    expect(lines[0]).toBe(
      'Workbook "Trackers/Book.xlsx" in library "Documents" on https://contoso.sharepoint.com/sites/Example, ' +
        "read at 2026-09-18T09:15:00.000Z: 5 worksheets and 13 tables resolved.",
    );
    expect(lines[1]).toBe("Listing 3 worksheets of 5 resolved; 2 more were left out to keep this response bounded at 3.");
    expect(lines[2]).toBe("Listing 6 tables of 13 resolved; 7 more were left out to keep this response bounded at 6.");
  });

  it("surfaces unresolved entries by name and reason, never silently, and counts them separately from the totals", () => {
    const withUnresolved: DescribeToolOutput = {
      ...INVENTORY_WHOLE,
      unresolved: [
        { kind: "sheet", name: "Broken", reason: "resolves to a part missing from the archive" },
        { kind: "table", name: "Orphan", reason: "no worksheet's relationships point at that part" },
      ],
    };

    const lines = describeWorkbookText(withUnresolved);

    expect(lines[1]).toBe(
      "2 sheets or tables could not be resolved and would otherwise have been silently dropped from the " +
        "counts above; each is reported rather than dropped: sheet \"Broken\" (resolves to a part missing from " +
        "the archive); table \"Orphan\" (no worksheet's relationships point at that part).",
    );
  });
});

const SOURCE_WHOLE: DescribeToolOutput = {
  siteUrl: "https://contoso.sharepoint.com/sites/Example",
  readAt: "2026-09-18T11:47:00.000Z",
  library: "Documents",
  workbookPath: "Trackers/Book.xlsx",
  mode: "source",
  source: { kind: "table", name: "ClientTable" },
  headerRow: { proposed: 1, candidates: [] },
  columns: [
    { position: 1, columnLabel: "A", header: "Client", headerUnevaluable: false, inferredType: "string", nonEmptyCount: 2, unevaluableCount: 0, distinctCount: 2, samples: ["CLIENTA", "CLIENTB"], samplesOmitted: 0 },
    { position: 2, columnLabel: "B", header: "Owed", headerUnevaluable: false, inferredType: "number", nonEmptyCount: 2, unevaluableCount: 0, distinctCount: 2, samples: ["3", "1"], samplesOmitted: 0 },
  ],
  columnsListing: { returned: 2, omitted: 0, cap: 100, truncated: false },
  sampleCap: 5,
  samplesWithheld: false,
  graphRequests: 4,
};

describe("describeWorkbookText, source mode", () => {
  it("names the workbook, library and described source in one sentence", () => {
    const lines = describeWorkbookText(SOURCE_WHOLE);

    expect(lines[0]).toBe(
      'Workbook "Trackers/Book.xlsx" in library "Documents" on https://contoso.sharepoint.com/sites/Example, ' +
        'read at 2026-09-18T11:47:00.000Z, describing the table "ClientTable".',
    );
  });

  it("states the proposed header row as its own sentence", () => {
    const lines = describeWorkbookText(SOURCE_WHOLE);

    expect(lines[1]).toBe("Proposed header row 1.");
  });

  it("states the complete column count when nothing was truncated", () => {
    const lines = describeWorkbookText(SOURCE_WHOLE);

    expect(lines[2]).toBe("Describing 2 columns, the complete set this range holds.");
  });

  it("states plainly that this tool proposes no columns map", () => {
    const lines = describeWorkbookText(SOURCE_WHOLE);

    expect(lines[3]).toBe(
      "This tool proposes no columns map. Header text, inferred type, distinct count and sample values above " +
        "are the evidence; deciding which field each column is and writing that into the profile remains yours to do.",
    );
  });

  it("states that samples are included, and the cap that was applied, when they were not withheld", () => {
    const lines = describeWorkbookText(SOURCE_WHOLE);

    expect(lines[4]).toBe(
      "Sample values are included with each column above, capped at 5 distinct values each; see each column's " +
        "own samplesOmitted for how many more it actually holds.",
    );
  });

  it("states a different cap value when a different one was applied, so the sentence is not a hardcoded 5", () => {
    const differentCap: DescribeToolOutput = { ...SOURCE_WHOLE, sampleCap: 3 };
    const lines = describeWorkbookText(differentCap);

    expect(lines[4]).toContain("capped at 3 distinct values each");
  });

  it("states the Graph cost as its own sentence", () => {
    const lines = describeWorkbookText(SOURCE_WHOLE);

    expect(lines[5]).toBe("This call cost 4 Graph requests.");
  });

  it("states a declined header row with its own reason, and a truncated column listing with its counts in place", () => {
    const declined: DescribeToolOutput = {
      ...SOURCE_WHOLE,
      source: { kind: "worksheet", name: "Tracking" },
      headerRow: {
        candidates: [
          { row: 1, distinctLabels: 3, reason: "distinct text" },
          { row: 2, distinctLabels: 3, reason: "distinct text" },
        ],
        declinedReason: "Rows 1 and 2 are equally plausible headers, so this tool proposes none.",
      },
      columnsListing: { returned: 5, omitted: 3, cap: 5, truncated: true },
      graphRequests: 9,
    };

    const lines = describeWorkbookText(declined);

    expect(lines[0]).toBe(
      'Workbook "Trackers/Book.xlsx" in library "Documents" on https://contoso.sharepoint.com/sites/Example, ' +
        'read at 2026-09-18T11:47:00.000Z, describing the worksheet "Tracking".',
    );
    expect(lines[1]).toBe("Proposed no header row: Rows 1 and 2 are equally plausible headers, so this tool proposes none.");
    expect(lines[2]).toBe("Describing 5 columns of 8 this range holds; 3 more were left out to keep this response bounded at 5.");
    expect(lines[5]).toBe("This call cost 9 Graph requests.");
  });

  it("says a source-mode output with no source carries no name, rather than rendering an empty one", () => {
    // Unreachable through the tool today, since shapeDescribeSource always
    // sets `source`. Pinned because the alternative renders as
    // `the source ""`, which is the `profile ""` shape this branch already
    // refused once: a missing value shown as a present empty one.
    const nameless: DescribeToolOutput = { ...SOURCE_WHOLE };
    delete nameless.source;

    const lines = describeWorkbookText(nameless);

    expect(lines[0]).toBe(
      'Workbook "Trackers/Book.xlsx" in library "Documents" on https://contoso.sharepoint.com/sites/Example, ' +
        "read at 2026-09-18T11:47:00.000Z, describing a source this response carries no name for.",
    );
  });

  it("states that samples were withheld, and why, as its own whole sentence", () => {
    const stale: DescribeToolOutput = { ...SOURCE_WHOLE, samplesWithheld: true };

    const lines = describeWorkbookText(stale);

    expect(lines[4]).toBe(
      "Sample values are withheld because the workbook is marked fullCalcOnLoad and this range holds at " +
        "least one formula, so its saved cached values are not authoritative. Column structure above is " +
        "unaffected; only the sample values are withheld.",
    );
  });
});
