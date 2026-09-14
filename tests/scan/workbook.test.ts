import { describe, expect, it } from "vitest";
import { readWorkbookSnapshot } from "../../src/scan/workbook.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import type { GraphClient } from "../../src/graph/client.js";
import { readFileSync } from "node:fs";

const PROFILE = loadProfile(
  JSON.parse(readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8")),
);

// headerRow in the example profile is 1, so the header is the first row of
// the grid and every row after it is data.
const HEADER = ["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"];

const SITE = "/sites/contoso.sharepoint.com:/sites/Example";
const DRIVES = "/sites/site-1/drives?$select=id,name";
// The workbook path the example profile carries, run through driveItemPath's
// per-segment encoding: the space in the file name becomes %20.
const ITEM_PATH = "/drives/drive-1/root:/Trackers/Operational%20Tracking%20Workbook.xlsx:";
const CREATE_SESSION = `${ITEM_PATH}/workbook/createSession`;
const CLOSE_SESSION = `${ITEM_PATH}/workbook/closeSession`;
const RANGE = `${ITEM_PATH}/workbook/tables/ClientRoster/range`;

/**
 * A single response map keyed by path, looked up by both get and post since
 * no path in these tests is ever addressed by both methods.
 */
function scriptedClient(responses: Record<string, unknown>): GraphClient {
  let requests = 0;
  function lookup<T>(path: string): T {
    requests += 1;
    if (!(path in responses)) throw new Error(`unexpected path ${path}`);
    return responses[path] as T;
  }
  return {
    requests: () => requests,
    get: async <T,>(path: string): Promise<T> => lookup<T>(path),
    post: async <T,>(path: string): Promise<T> => lookup<T>(path),
  };
}

describe("readWorkbookSnapshot", () => {
  it("resolves the drive, reads the range, and assembles a snapshot whose source names the workbook", async () => {
    const client = scriptedClient({
      [SITE]: { id: "site-1" },
      [DRIVES]: { value: [{ id: "drive-1", name: "Compliance Reports" }] },
      [CREATE_SESSION]: { id: "session-1" },
      [RANGE]: { values: [HEADER, ["CLIENTA", true, false, 45231]] },
      [CLOSE_SESSION]: undefined,
    });

    const snapshot = await readWorkbookSnapshot(client, PROFILE);

    expect(snapshot.source).toContain("Operational Tracking Workbook.xlsx");
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rejectedRows).toEqual([]);
  });

  it("carries the reader's rejections onto the snapshot", async () => {
    const client = scriptedClient({
      [SITE]: { id: "site-1" },
      [DRIVES]: { value: [{ id: "drive-1", name: "Compliance Reports" }] },
      [CREATE_SESSION]: { id: "session-1" },
      [RANGE]: {
        values: [
          HEADER,
          ["CLIENTA", true, false, 45231],
          // Not a serial, not ISO text, so the reader rejects this row rather
          // than skipping it: someone put something in that cell.
          ["CLIENTB", true, false, "not-a-date"],
        ],
      },
      [CLOSE_SESSION]: undefined,
    });

    const snapshot = await readWorkbookSnapshot(client, PROFILE);

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rejectedRows).toEqual([
      { row: 3, client: "CLIENTB", reason: 'effectiveFrom was not a date: "not-a-date"' },
    ]);
  });
});
