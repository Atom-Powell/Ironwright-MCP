import { describe, expect, it } from "vitest";
import { pairMisnamedArtifacts } from "../../../src/domain/rename/plan.js";
import { reconcile } from "../../../src/domain/reconcile/index.js";
import type { RepositoryFile, RepositorySnapshot, WorkbookSnapshot } from "../../../src/domain/reconcile/index.js";
import { loadProfile } from "../reconcile/fixtures/load.js";

/**
 * Feeds a real `reconcile()` report, built from the shared synthetic profile
 * rather than a second hand-built one, straight into `pairMisnamedArtifacts`.
 *
 * Every other test in this suite hand-builds an `ArtifactFinding` or
 * `DuplicateFinding` directly, which is what let two rounds of this module's
 * own bugs hide behind fixtures that shared the bug's own wrong assumption
 * instead of matching what the engine actually produces: first that
 * `expectedPath` was a full file path rather than a folder, then that two
 * files could both win a slot as separate artifacts rather than one winning
 * and the rest becoming duplicates. This test has no such blind spot, because
 * nothing in it asserts what the engine's report looks like; it only asserts
 * what `pairMisnamedArtifacts` does with whatever the engine actually
 * returns.
 */
const PROFILE = loadProfile();
const CLIENT = "CLIENTX";
const FOLDER = "2026/CLIENTX/06-June";
const CANONICAL_NAME = "2026-06_CLIENTX_Safety.xlsx";
const MISNAMED_NAME = "CLIENTX Safety - June 2026.xlsx";
const AS_OF = { year: 2026, month: 6 };

function workbookOwing(client: string): WorkbookSnapshot {
  return {
    rows: [{ client, fields: { monthlySafety: true } }],
    rejectedRows: [],
    source: "test-fixture",
  };
}

function file(path: string, etag: string): RepositoryFile {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), size: 1024, modified: "2026-06-14T09:00:00Z", etag };
}

function repository(files: RepositoryFile[]): RepositorySnapshot {
  return {
    files,
    folderPaths: ["2026", `2026/${CLIENT}`, FOLDER],
    scannedAt: "2026-06-14T09:00:00Z",
    searchCrossCheckIncluded: false,
  };
}

describe("pairMisnamedArtifacts against a real reconcile() report", () => {
  it("turns a plain misnamed artifact into a rename candidate", () => {
    const snapshot = repository([file(`${FOLDER}/${MISNAMED_NAME}`, "e1")]);
    const report = reconcile(PROFILE, workbookOwing(CLIENT), snapshot, AS_OF);

    // Not asserted, only checked: this is what makes the test honest about
    // testing pairMisnamedArtifacts rather than re-deriving reconcile()'s own
    // answer. If this ever stops holding, the fixture stopped producing a
    // misnamed artifact and the test below would trivially pass on an empty
    // pairing, which is why the assertions after it check the pairing's
    // actual contents rather than merely that it did not throw.
    // period.month picks out June specifically: the profile's 6-month rolling
    // window owes CLIENTX every month from January through June, all as the
    // same client, so a bare client match would find January's "missing"
    // entry rather than the one this test is actually about.
    const finding = report.artifacts.find((artifact) => artifact.client === CLIENT && artifact.period.month === AS_OF.month);
    expect(finding?.state).toBe("misnamed");

    const pairing = pairMisnamedArtifacts(report);

    expect(pairing.collisions).toEqual([]);
    expect(pairing.candidates).toEqual([
      {
        path: `${FOLDER}/${MISNAMED_NAME}`,
        currentName: MISNAMED_NAME,
        targetName: CANONICAL_NAME,
        targetPath: `${FOLDER}/${CANONICAL_NAME}`,
        client: CLIENT,
      },
    ]);
  });

  it("turns a misnamed duplicate into an excluded item, and renames the slot's real winner instead", () => {
    // Both files parse to the identical slot (same client, deliverable and
    // period), so the real engine resolves one winner (the canonical file,
    // ranked "compliant") and demotes the other to a DuplicateFinding
    // carrying its own "misnamed" state, exactly the shape that hid behind
    // this module's second bug.
    const snapshot = repository([
      file(`${FOLDER}/${MISNAMED_NAME}`, "e1"),
      file(`${FOLDER}/${CANONICAL_NAME}`, "e2"),
    ]);
    const report = reconcile(PROFILE, workbookOwing(CLIENT), snapshot, AS_OF);

    const finding = report.artifacts.find((artifact) => artifact.client === CLIENT && artifact.period.month === AS_OF.month);
    expect(finding?.state).toBe("compliant");
    expect(report.duplicates).toEqual([
      expect.objectContaining({ path: `${FOLDER}/${MISNAMED_NAME}`, state: "misnamed" }),
    ]);

    const pairing = pairMisnamedArtifacts(report);

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions).toEqual([
      {
        path: `${FOLDER}/${MISNAMED_NAME}`,
        currentName: MISNAMED_NAME,
        targetName: CANONICAL_NAME,
        client: CLIENT,
        reason: "target_path_already_occupied",
      },
    ]);
  });
});
