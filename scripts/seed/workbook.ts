/**
 * Puts a populated, tabled tracking workbook in the library.
 *
 * Deliberately does not use src/graph/excel.ts. That module opens a
 * non-persistent session and therefore structurally cannot write, which is a
 * locked decision: the server only ever reads a document the spec calls the
 * customer's live operational authority, and the read-only guarantee is meant
 * to be structural rather than a matter of nobody calling the wrong method.
 * This script writes, so it uses the seeder's own client.
 */
import { GraphRequestError } from "../../src/graph/errors.js";
import { driveItemPath } from "../../src/graph/paths.js";
import type { SeedGraphClient, SeedPlan } from "../seed-library.js";
import { blankWorkbookBytes, SHEET_NAME } from "./blank-workbook.js";
import { onboardedColumnAddress, rangeAddress, workbookGrid } from "./rows.js";

const TABLE_NAME = "ClientRoster";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DATE_NUMBER_FORMAT = "yyyy-mm-dd";

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

  try {
    await client.putBytes(driveId, libraryRelative, blankWorkbookBytes(), XLSX_CONTENT_TYPE);
  } catch (error) {
    if (error instanceof GraphRequestError) {
      throw new Error(`Uploading the blank workbook to ${workbookPath} failed with ${statusAndCode(error)}.`, {
        cause: error,
      });
    }
    throw error;
  }

  const item = driveItemPath(driveId, libraryRelative);
  const grid = workbookGrid(plan);

  try {
    // Stated as position, not as diagnosis: this range write is the first
    // call that requires Graph to open the uploaded file as a workbook, so a
    // failure here implicates the uploaded bytes more than anything after
    // it. Which of the two it actually was is not something this code
    // observed.
    await client.patch(`${item}/workbook/worksheets('${SHEET_NAME}')/range(address='${rangeAddress(plan)}')`, {
      values: grid,
    });
  } catch (error) {
    if (error instanceof GraphRequestError) {
      throw new Error(
        `Writing the client rows into ${workbookPath} failed with ${statusAndCode(error)}. This is the first call ` +
          "that requires Graph to open the uploaded file as a workbook, so the bytes this script uploaded are the " +
          "first thing to suspect.",
        { cause: error },
      );
    }
    throw error;
  }

  await client.patch(`${item}/workbook/worksheets('${SHEET_NAME}')/range(address='${onboardedColumnAddress(plan)}')`, {
    numberFormat: grid.slice(1).map(() => [DATE_NUMBER_FORMAT]),
  });

  let table: { id: string };
  try {
    table = await client.post<{ id: string }>(`${item}/workbook/tables/add`, {
      address: `${SHEET_NAME}!${rangeAddress(plan)}`,
      hasHeaders: true,
    });
  } catch (error) {
    if (error instanceof GraphRequestError) {
      if (error.status === 409 && error.code === "nameAlreadyExists") {
        throw new Error(
          `${workbookPath} already carries a table named ${TABLE_NAME}. This seed replaces the file rather than ` +
            "updating it, so a table surviving the upload means the upload did not replace what was there.",
          { cause: error },
        );
      }
      // Two /workbook/ calls already succeeded by this point, both range
      // writes above, so the code has positively observed that Graph can
      // open the uploaded file as a workbook. The uploaded bytes are
      // therefore not the suspect here; this request's own inputs are: the
      // address, the header row, or a table already sitting at that range.
      throw new Error(
        `Adding the ${TABLE_NAME} table to ${workbookPath} failed with ${statusAndCode(error)}. Two workbook calls ` +
          "already succeeded before this one, so Graph could open the uploaded file; this request's own " +
          "address, header row, or an existing table at that address is the more likely cause.",
        { cause: error },
      );
    }
    throw error;
  }

  await client.patch(`${item}/workbook/tables/${table.id}`, { name: TABLE_NAME });
  return { requests: client.requests() - before };
}
