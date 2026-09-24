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

function file(path: string, library?: string): RepositoryFile {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    size: 1,
    modified: "2026-06-14T09:00:00Z",
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
});
