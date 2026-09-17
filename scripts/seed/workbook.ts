/**
 * Puts a populated, tabled tracking workbook in the library.
 *
 * The whole workbook, table included, is assembled in memory by
 * scripts/seed/blank-workbook.ts and uploaded with one content PUT. There is
 * no read of src/workbook/ here and no use of the Graph Excel API's
 * /workbook/ surface: that surface refuses this server's app-only tokens at
 * every permission tested, which is the finding that started this phase, and
 * this script used to be the last caller still depending on it, through a
 * range write, a table add and a table rename after the upload. This script
 * writes, so it uses the seeder's own client rather than a read path built
 * for a server that only ever reads.
 */
import { GraphRequestError } from "../../src/graph/errors.js";
import { excelSerialToIsoDate } from "../../src/workbook/read.js";
import type { SeedGraphClient, SeedPlan } from "../seed-library.js";
import { seededWorkbookBytes } from "./blank-workbook.js";
import { WORKBOOK_HEADERS, workbookGrid } from "./rows.js";

const TABLE_NAME = "ClientRoster";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ONBOARDED_COLUMN_INDEX = WORKBOOK_HEADERS.indexOf("Onboarded");
if (ONBOARDED_COLUMN_INDEX === -1) {
  // Caught at module load, not inside createSeedWorkbook: this constant names
  // a fixed position in a fixed header list, so a mismatch is a programming
  // error in this file, not a bad plan or a bad tenant response, and it
  // should fail every run identically rather than only the first one that
  // reaches the conversion below.
  throw new Error('WORKBOOK_HEADERS no longer contains "Onboarded"; scripts/seed/workbook.ts must be updated to match.');
}

/**
 * The Onboarded column's serial converted to ISO text (see the comment on
 * ONBOARDED_COLUMN_INDEX's one caller below for why this column is text
 * rather than a formatted number). Reuses the reader's own conversion,
 * src/workbook/read.ts's excelSerialToIsoDate, rather than writing a second
 * one here, so the value this seeder writes and the value the reader would
 * recover from a real Excel date serial are the same function applied to the
 * same number; scripts/seed/rows.test.ts already pins that round trip.
 */
function onboardedCellAsIsoText(cell: string | number): string | number {
  if (typeof cell !== "number") return cell;
  const iso = excelSerialToIsoDate(cell);
  if (iso === undefined) {
    throw new Error(`The Onboarded column's serial ${String(cell)} did not convert to an ISO date.`);
  }
  return iso;
}

/**
 * workbookGrid's Onboarded column holds an Excel date serial, the same value
 * a real workbook's cellXfs date format would display. Applying that format
 * here would mean writing a styles.xml cellXfs entry nothing else in this
 * phase needs, and the only way to apply one to an already uploaded file is
 * the Graph Excel API's /workbook/ range call this task exists to stop
 * calling. Writing the serial as a bare number instead would display as a
 * five digit integer, not a date, which is a worse reading than text. ISO
 * text is the remaining option: src/workbook/read.ts's readWorkbookGrid
 * screens a text date through the same isIsoEffectiveFrom predicate it
 * applies to a converted serial, so this column reads correctly either way.
 * The accepted cost, already recorded in docs/OPEN-ITEMS.md, is that a human
 * opening the seeded workbook sees this column as text rather than a
 * formatted date.
 */
function asWritableGrid(grid: (string | number)[][]): (string | number)[][] {
  return grid.map((row) =>
    row.map((cell, columnIndex) => (columnIndex === ONBOARDED_COLUMN_INDEX ? onboardedCellAsIsoText(cell) : cell)),
  );
}

/**
 * The library-relative form of a profile's identity.workbookPath, which is
 * written with a leading slash and addressed without one.
 *
 * Exported because scripts/seed/expected.ts predicts a report over a library
 * that contains this file, and the prediction has to name the same path this
 * module writes to rather than a second derivation of it.
 */
export function workbookLibraryPath(workbookPath: string): string {
  return workbookPath.replace(/^\/+/, "");
}

/**
 * Every ancestor folder of the workbook, root to leaf, in the order
 * createSeedWorkbook creates them. A workbook at the library root has none.
 */
export function workbookAncestorPaths(workbookPath: string): string[] {
  const libraryRelative = workbookLibraryPath(workbookPath);
  const lastSlash = libraryRelative.lastIndexOf("/");
  if (lastSlash === -1) return [];

  const paths: string[] = [];
  let cursor = "";
  for (const segment of libraryRelative.slice(0, lastSlash).split("/")) {
    if (segment.length === 0) continue;
    cursor = cursor === "" ? segment : `${cursor}/${segment}`;
    paths.push(cursor);
  }
  return paths;
}

function splitPath(path: string): { parentPath: string; name: string } {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1
    ? { parentPath: "", name: path }
    : { parentPath: path.slice(0, lastSlash), name: path.slice(lastSlash + 1) };
}

/**
 * Graph's own error code alongside the status, in the same shape
 * GraphRequestError's message uses. A 403 is accessDenied or it is something
 * else, and an operator acts on the two differently, so a message naming only
 * the status discards the half that decides what to do next. The error itself
 * is passed as `cause` wherever this appears, so the full response body stays
 * reachable too.
 */
function statusAndCode(error: GraphRequestError): string {
  return `${error.status}${error.code === undefined ? "" : ` (${error.code})`}`;
}

export async function createSeedWorkbook(
  client: SeedGraphClient,
  driveId: string,
  workbookPath: string,
  plan: SeedPlan,
): Promise<{ requests: number }> {
  const before = client.requests();
  const libraryRelative = workbookLibraryPath(workbookPath);

  // The workbook's folder is not part of the taxonomy, so the tree writer
  // never creates it. Every ancestor is created in order, root to leaf, the
  // same way executeSeed's own folder loop walks tree.folderPaths: Graph's
  // children endpoint needs a parent to already exist before a child can be
  // created inside it, so a workbookPath nested more than one level deep
  // needs one createFolder call per level, not one call naming the leaf
  // under an ancestor that was never created.
  for (const ancestorPath of workbookAncestorPaths(workbookPath)) {
    const { parentPath, name } = splitPath(ancestorPath);
    await client.createFolder(driveId, parentPath, name);
  }

  const grid = asWritableGrid(workbookGrid(plan));
  const bytes = seededWorkbookBytes(grid, TABLE_NAME);

  try {
    await client.putBytes(driveId, libraryRelative, bytes, XLSX_CONTENT_TYPE);
  } catch (error) {
    if (error instanceof GraphRequestError) {
      throw new Error(`Uploading the workbook to ${workbookPath} failed with ${statusAndCode(error)}.`, {
        cause: error,
      });
    }
    throw error;
  }

  return { requests: client.requests() - before };
}
