import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildSeedPlan, ABSENT_CLIENT, MISNAMED_FILE_CLIENTS, MISSING_FILE_CLIENT } from "../../../scripts/seed-library.js";
import { expectedReport, formatExpectedReport, parseProfile } from "../../../scripts/seed/expected.js";
import { exampleSeedProfile } from "./fixtures.js";

const exampleProfileJson = JSON.parse(readFileSync("examples/profiles/example.json", "utf8"));
const profile = parseProfile(exampleProfileJson);
const plan = buildSeedPlan(exampleSeedProfile(), { clientCount: 12, year: 2026, includeQuarterly: true, throughMonth: 9 });
const report = () => expectedReport(profile, plan, { year: 2026, month: 9 });
const workbookPath = profile.identity.workbookPath;
const workbookInLibrary = workbookPath.replace(/^\/+/, "");

/**
 * The base example profile with only identity.workbookPath swapped, so a
 * test can put the seeded workbook at a filename that behaves differently
 * against examples/profiles/example.json's own taxonomy, naming template and
 * recognizers without inventing a second profile to track.
 */
function profileWithWorkbookPath(newWorkbookPath: string) {
  return parseProfile({
    ...exampleProfileJson,
    identity: { ...exampleProfileJson.identity, workbookPath: newWorkbookPath },
  });
}

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

  it("reports each planted file as misnamed rather than unrecognized", () => {
    const misnamed = report().artifacts.filter(
      (a) => MISNAMED_FILE_CLIENTS.includes(a.client) && a.state === "misnamed",
    );
    expect(misnamed).toHaveLength(MISNAMED_FILE_CLIENTS.length);
    for (const artifact of misnamed) expect(artifact.period).toEqual({ year: 2026, month: 1 });
  });

  it("predicts the seeder's own workbook as the one orphan the live tool will report", () => {
    // Two separate reasons put exactly one row here, and the earlier version
    // of this test credited only the second. The workbook createSeedWorkbook
    // writes at identity.workbookPath sits inside the library it describes,
    // the scan applies no exclusion for that path, and no recognizer in the
    // profile matches its name, so the engine reports it as an unrecognized
    // orphan. The month cap is what keeps it the only one: without it the
    // tree carries files for months that have not happened, and every one of
    // them is an unexpected orphan burying the three findings this seed
    // plants on purpose.
    const orphans = report().orphans;
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.path).toBe(workbookInLibrary);
    expect(orphans[0]?.kind).toBe("unrecognized");
  });

  it("refuses any client that is not planted to carry an exception", () => {
    const planted = new Set([ABSENT_CLIENT, MISSING_FILE_CLIENT, ...MISNAMED_FILE_CLIENTS]);
    const surprises = report().artifacts.filter((a) => a.state !== "compliant" && !planted.has(a.client));
    expect(surprises).toEqual([]);
  });
});

describe("formatExpectedReport", () => {
  it("counts every list the report carries, so a list this seed leaves empty is still accounted for", () => {
    // Walks the report's own fields rather than a written-out list of them:
    // the defect this replaces was a block that printed the orphan count and
    // nothing else, so emptyFolders was reported by the live tool and absent
    // from the expectation, under a line claiming anything unlisted was a
    // real finding.
    const current = report();
    const lines = formatExpectedReport(current, workbookPath).join("\n");
    const listNames = Object.entries(current).filter(([, value]) => Array.isArray(value));
    expect(listNames.length).toBeGreaterThan(1);
    for (const [name, value] of listNames) {
      expect(lines).toContain(`${name}: ${(value as unknown[]).length}`);
    }
  });

  it("names the seeder's own workbook where it reports the orphan", () => {
    const lines = formatExpectedReport(report(), workbookPath).join("\n");
    expect(lines).toContain(workbookInLibrary);
    expect(lines).toMatch(/tracking workbook/i);
  });

  it("names the empty folder the missing-file plant leaves behind", () => {
    const current = report();
    const lines = formatExpectedReport(current, workbookPath).join("\n");
    expect(current.emptyFolders.length).toBeGreaterThan(0);
    for (const folder of current.emptyFolders) expect(lines).toContain(folder);
  });

  it("distinguishes an unexpected orphan from an unrecognized one, since the engine already tells them apart", () => {
    // example.json's "legacy-spaced" recognizer matches this shape but names
    // a client with no workbook row, so the workbook parses cleanly and still
    // lands as an orphan: this is the case the old unconditional wording got
    // backwards, reading as "no recognizer matches" for a file a recognizer
    // just matched.
    const unexpectedProfile = profileWithWorkbookPath("/Trackers/ZZZZ Monthly - January 2000.xlsx");
    const unexpectedWorkbookInLibrary = unexpectedProfile.identity.workbookPath.replace(/^\/+/, "");
    const unexpectedReport = expectedReport(unexpectedProfile, plan, { year: 2026, month: 9 });

    const orphan = unexpectedReport.orphans.find((candidate) => candidate.path === unexpectedWorkbookInLibrary);
    expect(orphan?.kind).toBe("unexpected");

    const lines = formatExpectedReport(unexpectedReport, unexpectedProfile.identity.workbookPath).join("\n");
    expect(lines).toContain(
      "a recognizer in the profile matches its name, but no slot in this report expects the client, deliverable",
    );
    expect(lines).toContain("engine reports it as an unexpected orphan");
    expect(lines).not.toMatch(/no recognizer in the profile matches its name/);
  });

  it("states plainly, without a guessed cause, when the workbook is absent from the orphan list", () => {
    // A filename that matches the canonical naming template for a client,
    // deliverable and period the workbook already owes is recognized into
    // that real artifact slot rather than reported as any kind of orphan,
    // which is the second way the old wording's guess could be wrong: absence
    // from the orphan list is not proof no recognizer matched.
    const recognizedProfile = profileWithWorkbookPath("/Trackers/2026-09_Client01_MonthlyTraining.xlsx");
    const recognizedWorkbookInLibrary = recognizedProfile.identity.workbookPath.replace(/^\/+/, "");
    const recognizedReport = expectedReport(recognizedProfile, plan, { year: 2026, month: 9 });

    expect(recognizedReport.orphans.some((candidate) => candidate.path === recognizedWorkbookInLibrary)).toBe(false);

    const lines = formatExpectedReport(recognizedReport, recognizedProfile.identity.workbookPath).join("\n");
    expect(lines).toContain("but the orphan list above does not name it");
    expect(lines).toContain("not why it is or is not there");
    expect(lines).not.toMatch(/no recognizer in the profile matches its name/);
  });

  it("names the deliverable on each artifact line, so one client's two findings for a month differ", () => {
    // ABSENT_CLIENT owes both a monthly and a quarterly artifact in every
    // quarter-end month, and without the deliverable the two rows are the
    // same characters. Step 7 of the live sitting asks an operator to compare
    // finding by finding, which identical rows make impossible.
    const lines = formatExpectedReport(report(), workbookPath);
    const quarterEnd = lines.filter((line) => line.includes(ABSENT_CLIENT) && line.includes("2026-03"));
    expect(quarterEnd).toHaveLength(2);
    expect(new Set(quarterEnd).size).toBe(2);
    expect(quarterEnd.some((line) => line.includes("MonthlyTraining"))).toBe(true);
    expect(quarterEnd.some((line) => line.includes("QuarterlyPhishing"))).toBe(true);
  });
});
