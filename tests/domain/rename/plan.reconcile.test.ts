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

function file(path: string, etag: string, library?: string): RepositoryFile {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    size: 1024,
    modified: "2026-06-14T09:00:00Z",
    etag,
    ...(library === undefined ? {} : { library }),
  };
}

function repository(files: RepositoryFile[], extraFolders: string[] = []): RepositorySnapshot {
  return {
    files,
    folderPaths: ["2026", `2026/${CLIENT}`, FOLDER, ...extraFolders],
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

  it("keeps the tiebreak winner as the candidate when two misnamed files claim one slot", () => {
    // Both names match the same "legacy-spaced" recognizer for the same slot,
    // since month name resolution is case- and abbreviation-insensitive (see
    // parse.ts). Both sit in the correct folder, so both are "misnamed"
    // candidates for the identical slot, and matchArtifacts's tiebreak (most
    // recently modified, then path ascending) has to pick one winner. Both
    // files here share one modified timestamp, so the tiebreak falls to path:
    // "Jun" sorts before "June" (a space sorts before "e"), so the
    // abbreviated name wins and the full name becomes the duplicate.
    const abbreviated = `${FOLDER}/CLIENTX Safety - Jun 2026.xlsx`;
    const full = `${FOLDER}/${MISNAMED_NAME}`;
    const snapshot = repository([file(abbreviated, "e1"), file(full, "e2")]);
    const report = reconcile(PROFILE, workbookOwing(CLIENT), snapshot, AS_OF);

    const finding = report.artifacts.find((artifact) => artifact.client === CLIENT && artifact.period.month === AS_OF.month);
    expect(finding?.state).toBe("misnamed");
    expect(finding?.matched?.path).toBe(abbreviated);
    expect(report.duplicates).toEqual([expect.objectContaining({ path: full, state: "misnamed" })]);

    const pairing = pairMisnamedArtifacts(report);

    expect(pairing.candidates).toEqual([
      {
        path: abbreviated,
        currentName: "CLIENTX Safety - Jun 2026.xlsx",
        targetName: CANONICAL_NAME,
        targetPath: `${FOLDER}/${CANONICAL_NAME}`,
        client: CLIENT,
      },
    ]);
    expect(pairing.collisions).toEqual([
      {
        path: full,
        currentName: MISNAMED_NAME,
        targetName: CANONICAL_NAME,
        client: CLIENT,
        reason: "two_files_share_one_target_name",
      },
    ]);
  });

  it("excludes a misnamed duplicate as two_files_share_one_target_name when the slot's winner is itself misplaced rather than compliant", () => {
    // The canonical NAME is correct but the file sits in July's folder; the
    // naming template embeds the period in the filename itself, so this file
    // still parses to June's slot regardless of which folder holds it, and
    // computeState reports it "misplaced" (name correct, location wrong). A
    // "misplaced" winner has not reached the canonical path either, so the
    // misnamed loser and the winner both converge on that same path once
    // each is corrected, which two_files_share_one_target_name describes,
    // not target_path_already_occupied.
    const wrongFolder = "2026/CLIENTX/07-July";
    const misplacedPath = `${wrongFolder}/${CANONICAL_NAME}`;
    const misnamedPath = `${FOLDER}/${MISNAMED_NAME}`;
    const snapshot = repository([file(misplacedPath, "e1"), file(misnamedPath, "e2")], [wrongFolder]);
    const report = reconcile(PROFILE, workbookOwing(CLIENT), snapshot, AS_OF);

    const finding = report.artifacts.find((artifact) => artifact.client === CLIENT && artifact.period.month === AS_OF.month);
    expect(finding?.state).toBe("misplaced");
    expect(finding?.matched?.path).toBe(misplacedPath);
    expect(report.duplicates).toEqual([expect.objectContaining({ path: misnamedPath, state: "misnamed" })]);

    const pairing = pairMisnamedArtifacts(report);

    // The misplaced winner needs a move, not a rename, so phase 6a's own
    // candidateFrom produces nothing for it; only the excluded duplicate
    // shows up here.
    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions).toEqual([
      {
        path: misnamedPath,
        currentName: MISNAMED_NAME,
        targetName: CANONICAL_NAME,
        client: CLIENT,
        reason: "two_files_share_one_target_name",
      },
    ]);
  });

  it("excludes a misnamed duplicate as slot_already_satisfied_by_another_file when the winner is compliant under an accepted alias", () => {
    // alias-compact is the fixture profile's own accepted-alias recognizer
    // (verdict "compliant" for a name other than the canonical template). Its
    // file sits in the correct folder under its own alias name, not the
    // canonical name, so it wins the slot as "compliant" while its matched
    // path still differs from the canonical target: the slot is met, but
    // nothing physically occupies that target path.
    const aliasPath = `${FOLDER}/CLIENTX-202606-Safety.xlsx`;
    const misnamedPath = `${FOLDER}/${MISNAMED_NAME}`;
    const snapshot = repository([file(aliasPath, "e1"), file(misnamedPath, "e2")]);
    const report = reconcile(PROFILE, workbookOwing(CLIENT), snapshot, AS_OF);

    const finding = report.artifacts.find((artifact) => artifact.client === CLIENT && artifact.period.month === AS_OF.month);
    expect(finding?.state).toBe("compliant");
    expect(finding?.matched?.path).toBe(aliasPath);
    expect(report.duplicates).toEqual([expect.objectContaining({ path: misnamedPath, state: "misnamed" })]);

    const pairing = pairMisnamedArtifacts(report);

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions).toEqual([
      {
        path: misnamedPath,
        currentName: MISNAMED_NAME,
        targetName: CANONICAL_NAME,
        client: CLIENT,
        reason: "slot_already_satisfied_by_another_file",
      },
    ]);
  });

  it("excludes a misnamed file as slot_won_by_file_in_another_library when a canonically named copy in another library wins its slot", () => {
    // The Archive copy carries the canonical name at the same relative path,
    // but a file carrying a library is always misplaced (see computeState in
    // match.ts), and misplaced outranks misnamed, so it wins the slot and the
    // local misnamed file becomes its duplicate. Nothing occupies the
    // canonical path in this library.
    const misnamedPath = `${FOLDER}/${MISNAMED_NAME}`;
    const foreignPath = `${FOLDER}/${CANONICAL_NAME}`;
    const snapshot = repository([file(misnamedPath, "e1"), file(foreignPath, "e2", "Archive")]);
    const report = reconcile(PROFILE, workbookOwing(CLIENT), snapshot, AS_OF);

    const finding = report.artifacts.find((artifact) => artifact.client === CLIENT && artifact.period.month === AS_OF.month);
    expect(finding?.state).toBe("misplaced");
    expect(finding?.matched).toEqual(expect.objectContaining({ path: foreignPath, library: "Archive" }));
    expect(report.duplicates).toEqual([expect.objectContaining({ path: misnamedPath, state: "misnamed" })]);

    const pairing = pairMisnamedArtifacts(report);

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions).toEqual([
      {
        path: misnamedPath,
        currentName: MISNAMED_NAME,
        targetName: CANONICAL_NAME,
        client: CLIENT,
        reason: "slot_won_by_file_in_another_library",
      },
    ]);
  });
});
