import type { GraphClient } from "./client.js";
import { driveItemPath } from "./paths.js";

/**
 * A workbook larger than this is refused rather than downloaded. The number is
 * a constant rather than profile configuration because no real customer
 * workbook has ever been seen by this project, so a knob would be a guess at a
 * shape nobody has observed. A tracking workbook that genuinely exceeds this is
 * a reason to revisit the design, not to raise a limit quietly.
 */
export const MAX_WORKBOOK_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Downloads a driveItem's content. This exists because the Graph Excel API
 * refuses app-only tokens, so the workbook is read as a file rather than as a
 * workbook. See the 2026-09-16 spec. The size cap is enforced inside
 * `getBytes`, against both the declared Content-Length and the bytes actually
 * received, so there is nothing left for this function to check on its own.
 */
export async function downloadDriveItem(
  client: GraphClient,
  args: { driveId: string; workbookPath: string },
): Promise<Uint8Array> {
  return client.getBytes(`${driveItemPath(args.driveId, args.workbookPath)}/content`, MAX_WORKBOOK_DOWNLOAD_BYTES);
}
