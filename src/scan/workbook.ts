import type { GraphClient } from "../graph/client.js";
import { resolveDrive } from "../graph/drive.js";
import { readWorkbookRange } from "../graph/excel.js";
import { readWorkbookGrid } from "../workbook/read.js";
import type { Profile } from "../domain/profile/schema.js";
import type { WorkbookSnapshot } from "../domain/reconcile/index.js";

/**
 * The composition root that turns a profile's workbook identity into the
 * WorkbookSnapshot the reconciliation engine consumes. It resolves the
 * drive, reads the mapped range through a non-persistent Excel session, and
 * runs the grid through the pure mapping layer, composing three calls and
 * reporting only what they returned: it does not characterize the drive, the
 * workbook, or the rejections beyond that.
 */
export async function readWorkbookSnapshot(client: GraphClient, profile: Profile): Promise<WorkbookSnapshot> {
  const { driveId } = await resolveDrive(client, profile.identity.siteUrl, profile.identity.library);

  const grid = await readWorkbookRange(client, {
    driveId,
    workbookPath: profile.identity.workbookPath,
    source: profile.workbookMapping.source,
  });

  const result = readWorkbookGrid(grid, profile);

  return {
    rows: result.rows,
    rejectedRows: result.rejectedRows,
    source: `${profile.identity.workbookPath} in ${profile.identity.library}`,
  };
}
