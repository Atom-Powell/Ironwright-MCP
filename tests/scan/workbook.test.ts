import { describe, expect, it } from "vitest";
import { readWorkbookSnapshot } from "../../src/scan/workbook.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import type { GraphClient } from "../../src/graph/client.js";
import { buildWorkbook } from "../workbook/xlsx-fixture.js";
import { readFileSync } from "node:fs";

const PROFILE = loadProfile(
  JSON.parse(readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8")),
);

const SITE = "/sites/contoso.sharepoint.com:/sites/Example";
const DRIVES = "/sites/site-1/drives?$select=id,name,webUrl";
// The workbook path the example profile carries, run through driveItemPath's
// per-segment encoding: the space in the file name becomes %20.
const ITEM_PATH = "/drives/drive-1/root:/Trackers/Operational%20Tracking%20Workbook.xlsx:";
const CONTENT_PATH = `${ITEM_PATH}/content`;

/**
 * A single response map keyed by path for `get`, plus a fixed byte payload
 * for `getBytes`, since only one workbook download ever happens per test.
 * `downloadDriveItem` goes through `client.getBytes`, so scripting that call
 * with real xlsx bytes exercises the whole composition down to the parser.
 */
function scriptedClient(getResponses: Record<string, unknown>, bytes: Uint8Array): GraphClient {
  let requests = 0;
  return {
    requests: () => requests,
    get: async <T,>(path: string): Promise<T> => {
      requests += 1;
      if (!(path in getResponses)) throw new Error(`unexpected get ${path}`);
      return getResponses[path] as T;
    },
    post: async <T,>(): Promise<T> => {
      throw new Error("this test does not expect a post");
    },
    patch: () => {
      requests += 1;
      return Promise.reject(new Error("this fake Graph client does not implement patch"));
    },
    getBytes: async (path: string): Promise<Uint8Array> => {
      requests += 1;
      if (path !== CONTENT_PATH) throw new Error(`unexpected getBytes ${path}`);
      return bytes;
    },
  };
}

describe("readWorkbookSnapshot", () => {
  it("resolves the drive, downloads the workbook, and assembles a snapshot whose source names the table", async () => {
    const bytes = buildWorkbook({
      sheets: [
        {
          name: "Tracker",
          rowsXml:
            "<row r=\"1\">" +
            '<c r="A1" t="inlineStr"><is><t>Client</t></is></c>' +
            '<c r="B1" t="inlineStr"><is><t>Monthly Training</t></is></c>' +
            '<c r="C1" t="inlineStr"><is><t>Quarterly Phishing</t></is></c>' +
            '<c r="D1" t="inlineStr"><is><t>Onboarded</t></is></c>' +
            "</row>" +
            "<row r=\"2\">" +
            '<c r="A2" t="inlineStr"><is><t>CLIENTA</t></is></c>' +
            '<c r="B2" t="b"><v>1</v></c>' +
            '<c r="C2" t="b"><v>0</v></c>' +
            '<c r="D2" t="str"><v>2024-01-01</v></c>' +
            "</row>",
        },
      ],
      tables: [{ name: "ClientRoster", ref: "A1:D2", sheetIndex: 0 }],
    });

    const client = scriptedClient(
      {
        [SITE]: { id: "site-1" },
        [DRIVES]: { value: [{ id: "drive-1", name: "Compliance Reports" }] },
      },
      bytes,
    );

    const snapshot = await readWorkbookSnapshot(client, PROFILE);

    // Which table was read is the fact that separates "the mapping points at
    // the wrong range" from "the workbook is wrong", so the provenance carries
    // it alongside the file and the library.
    expect(snapshot.source).toBe(
      "/Trackers/Operational Tracking Workbook.xlsx#ClientRoster in Compliance Reports",
    );
    expect(snapshot.rows).toEqual([
      { client: "CLIENTA", fields: { monthlyTraining: true, quarterlyPhishing: false }, effectiveFrom: "2024-01-01" },
    ]);
    expect(snapshot.rejectedRows).toEqual([]);
  });

  it("reports a rejected row's absolute sheet row number, proving the parsed offset survives the whole composition", async () => {
    // The table starts at sheet row 10 rather than row 1, so a rejection
    // numbered against the grid alone would read as row 2 instead of the row
    // 11 an operator would actually find open in the workbook.
    const bytes = buildWorkbook({
      sheets: [
        {
          name: "Tracker",
          rowsXml:
            '<row r="10">' +
            '<c r="A10" t="inlineStr"><is><t>Client</t></is></c>' +
            '<c r="B10" t="inlineStr"><is><t>Monthly Training</t></is></c>' +
            '<c r="C10" t="inlineStr"><is><t>Quarterly Phishing</t></is></c>' +
            '<c r="D10" t="inlineStr"><is><t>Onboarded</t></is></c>' +
            "</row>" +
            '<row r="11">' +
            '<c r="A11" t="inlineStr"><is><t>CLIENTB</t></is></c>' +
            '<c r="B11" t="b"><v>1</v></c>' +
            '<c r="C11" t="b"><v>0</v></c>' +
            // Not a serial, not ISO text, so the reader rejects this row
            // rather than skipping it: someone put something in that cell.
            '<c r="D11" t="str"><v>not-a-date</v></c>' +
            "</row>",
        },
      ],
      tables: [{ name: "ClientRoster", ref: "A10:D11", sheetIndex: 0 }],
    });

    const client = scriptedClient(
      {
        [SITE]: { id: "site-1" },
        [DRIVES]: { value: [{ id: "drive-1", name: "Compliance Reports" }] },
      },
      bytes,
    );

    const snapshot = await readWorkbookSnapshot(client, PROFILE);

    expect(snapshot.rows).toEqual([]);
    expect(snapshot.rejectedRows).toEqual([
      { row: 11, client: "CLIENTB", reason: 'effectiveFrom was not a date: "not-a-date"' },
    ]);
  });
});
