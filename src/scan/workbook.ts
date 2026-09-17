import type { GraphClient } from "../graph/client.js";
import { resolveDrive } from "../graph/drive.js";
import { downloadDriveItem } from "../graph/content.js";
import { parseWorkbookGrid } from "../workbook/xlsx.js";
import { readWorkbookGrid } from "../workbook/read.js";
import type { Profile } from "../domain/profile/schema.js";
import type { WorkbookSnapshot } from "../domain/reconcile/index.js";

/**
 * The composition root that turns a profile's workbook identity into the
 * WorkbookSnapshot the reconciliation engine consumes. It resolves the
 * drive, downloads the workbook's bytes, parses the mapped table or
 * worksheet out of the archive, and runs the resulting grid through the pure
 * mapping layer, composing four calls and reporting only what they returned:
 * it does not characterize the drive, the workbook, or the rejections beyond
 * that. The Graph Excel API is not part of this path: it refuses this
 * server's app-only tokens with a 403 on every application permission tried,
 * so the workbook is read as file content rather than as a live workbook.
 * See the 2026-09-16 spec.
 */
export async function readWorkbookSnapshot(client: GraphClient, profile: Profile): Promise<WorkbookSnapshot> {
  const { driveId } = await resolveDrive(client, profile.identity.siteUrl, profile.identity.library);

  const bytes = await downloadDriveItem(client, { driveId, workbookPath: profile.identity.workbookPath });
  const { grid, rowOffset } = parseWorkbookGrid(bytes, profile.workbookMapping.source);
  const result = readWorkbookGrid(grid, profile, rowOffset);

  return {
    rows: result.rows,
    rejectedRows: result.rejectedRows,
    // "path#range in library", the convention the engine's golden fixture
    // already uses. The range is the half that settles an argument: a report
    // that disagrees with the workbook is most often a mapping pointed at the
    // wrong table, and a provenance line naming only the file cannot tell that
    // apart from a file that is genuinely wrong.
    source: `${profile.identity.workbookPath}#${profile.workbookMapping.source.name} in ${profile.identity.library}`,
  };
}
