import { describe, expect, it } from "vitest";
import { reconcile } from "../../../src/domain/reconcile/index.js";
import type { ReconciliationReport, RepositorySnapshot } from "../../../src/domain/reconcile/index.js";
import { GOLDEN_AS_OF, loadProfile, loadRepository, loadWorkbook } from "./fixtures/load.js";

/**
 * The same fixtures as the golden report, scanned without the Microsoft Search
 * cross-check.
 *
 * Without Search, a correctly named file sitting outside the expected taxonomy
 * is invisible to the scan, so every `misplaced` finding is unreliable and
 * every `missing` finding is suspect: the file may exist somewhere the walk
 * never reached. The engine cannot repair that, and it must not pretend to.
 * What it can do is refuse to let the report be mistaken for a complete one,
 * and that is the property pinned here.
 */
const profile = loadProfile();
const workbook = loadWorkbook();
const complete = loadRepository();

const degraded: RepositorySnapshot = { ...complete, searchCrossCheckIncluded: false };

function reportFor(repository: RepositorySnapshot): ReconciliationReport {
  return reconcile(profile, workbook, repository, GOLDEN_AS_OF);
}

describe("a repository snapshot scanned without the Search cross-check", () => {
  it("records the absent cross-check in the report's own provenance", () => {
    const report = reportFor(degraded);

    expect(report.provenance.searchCrossCheckIncluded).toBe(false);
  });

  it("still produces the report rather than refusing to answer", () => {
    // A partial scan is degraded, not useless. Most of what the report says
    // about names and duplicates does not depend on Search at all, so
    // withholding the whole answer would be its own kind of dishonesty.
    const report = reportFor(degraded);

    expect(report.artifacts.length).toBeGreaterThan(0);
    expect(report.clients.length).toBeGreaterThan(0);
  });

  it("leaves a caller a way to tell the scan was partial without seeing the inputs", () => {
    // The substantive property, and the reason the flag exists. A report is
    // handed on to a tool, an agent and eventually a person, none of whom hold
    // the RepositorySnapshot it came from. If the only record of the partial
    // scan were the input, an incomplete answer would be indistinguishable
    // from a complete one at every point after this function returns.
    const partial = JSON.parse(JSON.stringify(reportFor(degraded))) as ReconciliationReport;
    const whole = JSON.parse(JSON.stringify(reportFor(complete))) as ReconciliationReport;

    expect(JSON.stringify(partial)).not.toBe(JSON.stringify(whole));
    expect(partial.provenance.searchCrossCheckIncluded).toBe(false);
    expect(whole.provenance.searchCrossCheckIncluded).toBe(true);
  });

  it("carries findings whose reliability depends on the missing cross-check", () => {
    // Guards the guard. The two assertions above would both pass over a report
    // with nothing in it that Search could have changed, and would then prove
    // nothing about the case the flag exists for. These are the findings a
    // caller must not present as settled: a file counted missing, and a file
    // counted misplaced, either of which a Search pass could have resolved
    // differently.
    const report = reportFor(degraded);

    expect(report.artifacts.some((artifact) => artifact.state === "missing")).toBe(true);
    expect(report.artifacts.some((artifact) => artifact.state === "misplaced")).toBe(true);
  });

  it("changes nothing but the flag, so the flag is the only thing that can carry the warning", () => {
    // The engine does not silently soften a degraded scan's findings, drop its
    // missing artifacts, or otherwise encode the partiality somewhere a caller
    // might read instead. Every finding is identical to the complete scan's.
    // That is what makes the provenance flag load-bearing rather than
    // decorative, and it is why a change that quietly dropped the flag would
    // leave an incomplete report reading exactly like a complete one.
    const partial = reportFor(degraded);
    const whole = reportFor(complete);

    expect({ ...partial, provenance: whole.provenance }).toEqual(whole);
  });
});
