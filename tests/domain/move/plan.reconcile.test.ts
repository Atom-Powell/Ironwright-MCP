import { describe, expect, it } from "vitest";
import { pairMisplacedArtifacts } from "../../../src/domain/move/plan.js";
import { reconcile } from "../../../src/domain/reconcile/index.js";
import type { RepositoryFile, RepositorySnapshot, WorkbookSnapshot } from "../../../src/domain/reconcile/index.js";
import { loadProfile } from "../reconcile/fixtures/load.js";

const PROFILE = loadProfile();
const CLIENT = "CLIENTX";
const JUNE = "2026/CLIENTX/06-June";
const MAY = "2026/CLIENTX/05-May";
const CANONICAL = "2026-06_CLIENTX_Safety.xlsx";
const MISNAMED = "CLIENTX Safety - June 2026.xlsx";
const AS_OF = { year: 2026, month: 6 };

function workbook(): WorkbookSnapshot {
  return { rows: [{ client: CLIENT, fields: { monthlySafety: true } }], rejectedRows: [], source: "test-fixture" };
}

function file(path: string, library?: string, modified = "2026-06-14T09:00:00Z"): RepositoryFile {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    size: 1,
    modified,
    etag: "e",
    ...(library === undefined ? {} : { library }),
  };
}

function repo(files: RepositoryFile[], folders: string[] = ["2026", `2026/${CLIENT}`, JUNE, MAY]): RepositorySnapshot {
  return { files, folderPaths: folders, scannedAt: "2026-06-14T09:00:00Z", searchCrossCheckIncluded: false };
}

function june(report: ReturnType<typeof reconcile>) {
  return report.artifacts.find((a) => a.client === CLIENT && a.period.month === 6);
}

describe("pairMisplacedArtifacts against a real reconcile() report", () => {
  it("moves a correctly named file into the folder it belongs in, keeping its name", () => {
    const snapshot = repo([file(`${MAY}/${CANONICAL}`)]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("misplaced");

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.exclusions).toEqual([]);
    expect(pairing.candidates).toEqual([
      { path: `${MAY}/${CANONICAL}`, currentName: CANONICAL, targetName: CANONICAL, targetPath: `${JUNE}/${CANONICAL}`, client: CLIENT },
    ]);
  });

  it("moves and renames a file that is both misnamed and misplaced, as one candidate", () => {
    const snapshot = repo([file(`${MAY}/${MISNAMED}`)]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("misnamed_and_misplaced");

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.candidates).toEqual([
      { path: `${MAY}/${MISNAMED}`, currentName: MISNAMED, targetName: CANONICAL, targetPath: `${JUNE}/${CANONICAL}`, client: CLIENT },
    ]);
  });

  it("excludes a file whose target folder does not exist", () => {
    const snapshot = repo([file(`${MAY}/${CANONICAL}`)], ["2026", `2026/${CLIENT}`, MAY]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.candidates).toEqual([]);
    expect(pairing.exclusions).toEqual([
      { path: `${MAY}/${CANONICAL}`, currentName: CANONICAL, targetName: CANONICAL, client: CLIENT, reason: "target_folder_absent" },
    ]);
  });

  it("excludes a file found in another library, naming that library", () => {
    const snapshot = repo([file(`${JUNE}/${CANONICAL}`, "Archive")]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("misplaced");

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.candidates).toEqual([]);
    expect(pairing.exclusions).toEqual([
      { path: `${JUNE}/${CANONICAL}`, currentName: CANONICAL, targetName: CANONICAL, client: CLIENT, reason: "in_another_library", library: "Archive" },
    ]);
  });

  it("excludes a misplaced copy when the canonical path is already filled", () => {
    const snapshot = repo([file(`${JUNE}/${CANONICAL}`), file(`${MAY}/${CANONICAL}`)]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("compliant");

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.candidates).toEqual([]);
    expect(pairing.exclusions).toEqual([
      { path: `${MAY}/${CANONICAL}`, currentName: CANONICAL, targetName: CANONICAL, client: CLIENT, reason: "target_path_already_occupied" },
    ]);
  });

  it("leaves a misnamed file in the right folder to the rename plan", () => {
    const snapshot = repo([file(`${JUNE}/${MISNAMED}`)]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("misnamed");

    expect(pairMisplacedArtifacts(report, snapshot.folderPaths)).toEqual({ candidates: [], exclusions: [] });
  });

  it("reports a misplaced copy found in another library as an exclusion, not a silent drop", () => {
    // The canonical file at its canonical path wins the slot as compliant.
    // The same-named copy in "Archive" parses to the identical slot, loses to
    // the winner already at the canonical path, and comes back as a
    // DuplicateFinding carrying a library rather than as a second
    // ArtifactFinding: a shape the rename pairing never sees, since a
    // misnamed duplicate's own state cannot carry a library (see match.ts's
    // computeState), but a misplaced one can.
    const snapshot = repo([file(`${JUNE}/${CANONICAL}`), file(`${JUNE}/${CANONICAL}`, "Archive")]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("compliant");
    expect(report.duplicates).toEqual([
      expect.objectContaining({ path: `${JUNE}/${CANONICAL}`, state: "misplaced", library: "Archive" }),
    ]);

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.candidates).toEqual([]);
    expect(pairing.exclusions).toEqual([
      { path: `${JUNE}/${CANONICAL}`, currentName: CANONICAL, targetName: CANONICAL, client: CLIENT, reason: "in_another_library", library: "Archive" },
    ]);
  });

  it("reports a local file that lost its slot to a copy in another library as slot_won_by_file_in_another_library", () => {
    // Both copies are misplaced (the local one sits in May's folder, the other
    // sits in another library), so they tie on rank and matchArtifacts breaks
    // the tie on modification time: the newer Archive copy wins the slot and
    // the local file becomes its duplicate. The winner's matched path equals
    // the canonical path only relative to Archive; nothing sits at that path
    // in this library, so target_path_already_occupied would be false here.
    const local = `${MAY}/${CANONICAL}`;
    const foreign = `${JUNE}/${CANONICAL}`;
    const snapshot = repo([file(local, undefined, "2026-06-10T09:00:00Z"), file(foreign, "Archive", "2026-06-12T09:00:00Z")]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("misplaced");
    expect(june(report)?.matched).toEqual(expect.objectContaining({ path: foreign, library: "Archive" }));
    expect(report.duplicates).toEqual([expect.objectContaining({ path: local, state: "misplaced" })]);
    expect(report.duplicates[0]?.library).toBeUndefined();

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.candidates).toEqual([]);
    expect(pairing.exclusions).toEqual([
      { path: foreign, currentName: CANONICAL, targetName: CANONICAL, client: CLIENT, reason: "in_another_library", library: "Archive" },
      { path: local, currentName: CANONICAL, targetName: CANONICAL, client: CLIENT, reason: "slot_won_by_file_in_another_library" },
    ]);
  });

  it("moves the slot's winner and excludes a second misplaced copy as two_files_share_one_target_name", () => {
    // Two local copies of the canonical name in two wrong folders. Both are
    // misplaced, so they tie on rank and on modification time, and the path
    // tiebreak picks May's copy. The winner becomes the one candidate; the
    // loser would land on the same canonical path once moved.
    const july = "2026/CLIENTX/07-July";
    const snapshot = repo(
      [file(`${MAY}/${CANONICAL}`), file(`${july}/${CANONICAL}`)],
      ["2026", `2026/${CLIENT}`, JUNE, MAY, july],
    );
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("misplaced");
    expect(june(report)?.matched?.path).toBe(`${MAY}/${CANONICAL}`);
    expect(report.duplicates).toEqual([expect.objectContaining({ path: `${july}/${CANONICAL}`, state: "misplaced" })]);

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.candidates).toEqual([
      { path: `${MAY}/${CANONICAL}`, currentName: CANONICAL, targetName: CANONICAL, targetPath: `${JUNE}/${CANONICAL}`, client: CLIENT },
    ]);
    expect(pairing.exclusions).toEqual([
      { path: `${july}/${CANONICAL}`, currentName: CANONICAL, targetName: CANONICAL, client: CLIENT, reason: "two_files_share_one_target_name" },
    ]);
  });

  it("excludes a canonically named copy in a wrong folder as slot_already_satisfied_by_another_file when the winner is compliant under an alias", () => {
    // alias-compact is the fixture profile's accepted-alias recognizer. Its
    // file in June's folder wins the slot as compliant, since compliant
    // outranks misplaced, while its path differs from the canonical path.
    // The canonically named copy in May's folder loses and is misplaced.
    const alias = `${JUNE}/CLIENTX-202606-Safety.xlsx`;
    const snapshot = repo([file(alias), file(`${MAY}/${CANONICAL}`)]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("compliant");
    expect(june(report)?.matched?.path).toBe(alias);
    expect(report.duplicates).toEqual([expect.objectContaining({ path: `${MAY}/${CANONICAL}`, state: "misplaced" })]);

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.candidates).toEqual([]);
    expect(pairing.exclusions).toEqual([
      { path: `${MAY}/${CANONICAL}`, currentName: CANONICAL, targetName: CANONICAL, client: CLIENT, reason: "slot_already_satisfied_by_another_file" },
    ]);
  });
});
