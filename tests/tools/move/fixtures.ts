import type { RepositorySnapshot } from "../../../src/domain/reconcile/index.js";
import { file, snapshot } from "../rename/fixtures.js";

export const SEPT = "2026/ACME/09-September";
export const AUG = "2026/ACME/08-August";
export const CANONICAL_NAME = "2026-09_ACME_MonthlyTraining.xlsx";
export const MISNAMED_NAME = "2026-09_ACME_VendorTraining.xlsx";
export const MISPLACED_PATH = `${AUG}/${CANONICAL_NAME}`;
export const BOTH_WRONG_PATH = `${AUG}/${MISNAMED_NAME}`;
export const TARGET_PATH = `${SEPT}/${CANONICAL_NAME}`;

const FOLDERS = ["2026", "2026/ACME", AUG, SEPT];

/** September's report filed in August's folder under its canonical name. */
export function snapshotWithMisplacedFile(folders: string[] = FOLDERS): RepositorySnapshot {
  return snapshot([file(MISPLACED_PATH)], folders);
}

/** September's report filed in August's folder under the vendor-token name. */
export function snapshotWithBothWrong(): RepositorySnapshot {
  return snapshot([file(BOTH_WRONG_PATH)], FOLDERS);
}
