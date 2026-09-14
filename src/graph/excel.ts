import type { GraphClient } from "./client.js";
import { GraphRequestError } from "./errors.js";
import { driveItemPath } from "./paths.js";

export interface WorkbookRange {
  values: unknown[][];
}

export type WorkbookSource = { kind: "table" | "worksheet"; name: string };

interface CreateSessionResponse {
  id: string;
}

const SESSION_HEADER = "workbook-session-id";

/**
 * Encoded the same way `paths.ts` encodes a driveItem segment: a `#` or `?` in
 * a table or worksheet name would otherwise truncate the request URL at that
 * character and address something else entirely.
 */
function rangeUrl(itemPath: string, source: WorkbookSource): string {
  const encodedName = encodeURIComponent(source.name);
  return source.kind === "table"
    ? `${itemPath}/workbook/tables/${encodedName}/range`
    : `${itemPath}/workbook/worksheets/${encodedName}/usedRange`;
}

async function createSession(client: GraphClient, itemPath: string): Promise<string> {
  // persistChanges is hardcoded false, never a parameter. This server only
  // ever reads the workbook, and a session that could persist a change would
  // make that a matter of nobody calling a write method rather than a
  // structural guarantee. The workbook is the customer's live operational
  // authority.
  const response = await client.post<CreateSessionResponse>(`${itemPath}/workbook/createSession`, {
    persistChanges: false,
  });
  return response.id;
}

async function closeSession(client: GraphClient, itemPath: string, sessionId: string): Promise<void> {
  await client.post(`${itemPath}/workbook/closeSession`, undefined, { [SESSION_HEADER]: sessionId });
}

/**
 * Opens a non-persistent Excel session, reads a table's range or a
 * worksheet's used range, and closes the session, so a caller never sees a
 * session id. This module carries no domain knowledge: it does not know what
 * a client or a deliverable is, only how to fetch a grid of cell values.
 */
export async function readWorkbookRange(
  client: GraphClient,
  args: { driveId: string; workbookPath: string; source: { kind: "table" | "worksheet"; name: string } },
): Promise<unknown[][]> {
  const itemPath = driveItemPath(args.driveId, args.workbookPath);
  const url = rangeUrl(itemPath, args.source);

  let sessionId = await createSession(client, itemPath);

  try {
    try {
      const range = await client.get<WorkbookRange>(url, { [SESSION_HEADER]: sessionId });
      return range.values;
    } catch (error) {
      // A 404 on a call carrying a session id means the session expired
      // between createSession and the read. One retry on a fresh session is
      // the correct response; a second failure is a real failure, not another
      // expiry, and must propagate rather than loop.
      if (!(error instanceof GraphRequestError) || error.status !== 404) throw error;

      sessionId = await createSession(client, itemPath);
      const range = await client.get<WorkbookRange>(url, { [SESSION_HEADER]: sessionId });
      return range.values;
    }
  } finally {
    try {
      await closeSession(client, itemPath, sessionId);
    } catch {
      // Swallowed deliberately: the values, if the read succeeded, are
      // already in hand, and a failed close is untidy rather than a failure
      // of the read the caller asked for. A leaked session still holds a
      // lock on the workbook until it expires on its own, but that is a
      // Graph-side cleanup concern, not one this function can resolve by
      // retrying a close that just failed.
    }
  }
}
