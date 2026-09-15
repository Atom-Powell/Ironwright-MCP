import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildSeedPlan, ABSENT_CLIENT, MISNAMED_FILE_CLIENT, MISSING_FILE_CLIENT } from "../../../scripts/seed-library.js";
import { expectedReport, formatExpectedReport } from "../../../scripts/seed/expected.js";
import { exampleSeedProfile } from "./fixtures.js";

const rawProfile = JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown;
const plan = buildSeedPlan(exampleSeedProfile(), { clientCount: 12, year: 2026, includeQuarterly: true, throughMonth: 9 });
const report = () => expectedReport(rawProfile, plan, { year: 2026, month: 9 });

describe("expectedReport", () => {
  it("reports every period the absent client owes as missing", () => {
    const missing = report().artifacts.filter((a) => a.client === ABSENT_CLIENT && a.state === "missing");
    expect(missing.length).toBeGreaterThan(0);
  });

  it("reports exactly one missing artifact for the planted client and month", () => {
    const missing = report().artifacts.filter((a) => a.client === MISSING_FILE_CLIENT && a.state === "missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.period).toEqual({ year: 2026, month: 1 });
  });

  it("reports the planted file as misnamed rather than unrecognized", () => {
    const misnamed = report().artifacts.filter((a) => a.client === MISNAMED_FILE_CLIENT && a.state === "misnamed");
    expect(misnamed).toHaveLength(1);
    expect(misnamed[0]?.period).toEqual({ year: 2026, month: 1 });
  });

  it("finds no orphans at all, which is what the month cap is for", () => {
    // Without the cap the tree carries files for months that have not
    // happened, and every one of them is an unexpected orphan burying the
    // three findings this seed plants on purpose.
    expect(report().orphans).toEqual([]);
  });

  it("refuses any client that is not planted to carry an exception", () => {
    const planted = new Set([ABSENT_CLIENT, MISSING_FILE_CLIENT, MISNAMED_FILE_CLIENT]);
    const surprises = report().artifacts.filter((a) => a.state !== "compliant" && !planted.has(a.client));
    expect(surprises).toEqual([]);
  });

  it("states in the printed output that this cannot prove the engine", () => {
    const lines = formatExpectedReport(report()).join("\n");
    expect(lines).toContain("cannot");
    expect(lines).toMatch(/engine/i);
  });
});
