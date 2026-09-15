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

function splitWorkbookPath(workbookPath: string): { parentPath: string; libraryRelative: string } {
  const libraryRelative = workbookPath.replace(/^\/+/, "");
  const lastSlash = libraryRelative.lastIndexOf("/");
  return { parentPath: lastSlash === -1 ? "" : libraryRelative.slice(0, lastSlash), libraryRelative };
}

export async function createSeedWorkbook(
  client: SeedGraphClient,
  driveId: string,
  workbookPath: string,
  plan: SeedPlan,
): Promise<{ requests: number }> {
  const before = client.requests();
  const { parentPath, libraryRelative } = splitWorkbookPath(workbookPath);

  // The workbook's folder is not part of the taxonomy, so the tree writer
  // never creates it.
  if (parentPath !== "") {
    const lastSlash = parentPath.lastIndexOf("/");
    const grandparent = lastSlash === -1 ? "" : parentPath.slice(0, lastSlash);
    const name = lastSlash === -1 ? parentPath : parentPath.slice(lastSlash + 1);
    await client.createFolder(driveId, grandparent, name);
  }

  try {
    await client.putBytes(driveId, libraryRelative, blankWorkbookBytes(), XLSX_CONTENT_TYPE);
  } catch (error) {
    if (error instanceof GraphRequestError) {
      throw new Error(`Uploading the blank workbook to ${workbookPath} failed with ${error.status}.`);
    }
    throw error;
  }

  const item = driveItemPath(driveId, libraryRelative);
  const grid = workbookGrid(plan);
  await client.patch(`${item}/workbook/worksheets('${SHEET_NAME}')/range(address='${rangeAddress(plan)}')`, {
    values: grid,
  });
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
        );
      }
      // Stated as position, not as diagnosis: this is the first call that
      // requires Graph to open the file as a workbook, so a failure here
      // implicates the uploaded bytes more than anything after it. Which of
      // the two it actually was is not something this code observed.
      throw new Error(
        `Adding the ${TABLE_NAME} table to ${workbookPath} failed with ${error.status}. This is the first call ` +
          "that requires Graph to open the uploaded file as a workbook, so the bytes this script uploaded are " +
          "the first thing to suspect.",
      );
    }
    throw error;
  }

  await client.patch(`${item}/workbook/tables/${table.id}`, { name: TABLE_NAME });
  return { requests: client.requests() - before };
}
