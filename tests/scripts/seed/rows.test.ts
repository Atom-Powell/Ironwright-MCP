import { describe, expect, it } from "vitest";
import { excelSerialToIsoDate } from "../../../src/workbook/read.js";
import { buildSeedPlan, ABSENT_CLIENT } from "../../../scripts/seed-library.js";
import { excelDateSerial, WORKBOOK_HEADERS, workbookGrid } from "../../../scripts/seed/rows.js";
import { exampleSeedProfile } from "./fixtures.js";

const options = { clientCount: 12, year: 2026, includeQuarterly: true, throughMonth: 9 };

describe("excelDateSerial", () => {
  it("produces the serial Excel uses for 2026-01-01", () => {
    expect(excelDateSerial(2026, 1, 1)).toBe(46023);
  });

  it("round-trips through the reader's own converter", () => {
    // The one assertion that matters: the seeder and the workbook reader must
    // agree about what a date cell means, and the reader is the side that will
    // see this value coming back out of Graph.
    expect(excelSerialToIsoDate(excelDateSerial(2026, 1, 1))).toBe("2026-01-01");
  });
});

describe("workbookGrid", () => {
  it("leads with the headers the example profile maps", () => {
    const grid = workbookGrid(buildSeedPlan(exampleSeedProfile(), options));
    expect(grid[0]).toEqual(WORKBOOK_HEADERS);
    expect(WORKBOOK_HEADERS).toEqual(["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"]);
  });

  it("carries one row per workbook client, the absent one included", () => {
    const plan = buildSeedPlan(exampleSeedProfile(), options);
    const grid = workbookGrid(plan);
    expect(grid).toHaveLength(plan.workbookClients.length + 1);
    expect(grid.map((row) => row[0])).toContain(ABSENT_CLIENT);
  });

  it("writes the deliverable columns as text the engine reads as owed", () => {
    const grid = workbookGrid(buildSeedPlan(exampleSeedProfile(), options));
    expect(grid[1]?.[1]).toBe("Yes");
    expect(grid[1]?.[2]).toBe("Yes");
  });

  it("onboards every client on January 1 of the seeded year", () => {
    const grid = workbookGrid(buildSeedPlan(exampleSeedProfile(), options));
    for (const row of grid.slice(1)) expect(row[3]).toBe(excelDateSerial(2026, 1, 1));
  });
});
