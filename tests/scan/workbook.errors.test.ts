import { describe, expect, it } from "vitest";
import { readWorkbookSnapshot } from "../../src/scan/workbook.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import type { GraphClient } from "../../src/graph/client.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { buildWorkbook } from "../workbook/xlsx-fixture.js";
import { readFileSync } from "node:fs";

const PROFILE = loadProfile(
  JSON.parse(readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8")),
);

const SITE = "/sites/contoso.sharepoint.com:/sites/Example";
const DRIVES = "/sites/site-1/drives?$select=id,name,webUrl";
const ITEM_PATH = "/drives/drive-1/root:/Trackers/Operational%20Tracking%20Workbook.xlsx:";
const CONTENT_PATH = `${ITEM_PATH}/content`;

const DRIVE_RESPONSES = {
  [SITE]: { id: "site-1" },
  [DRIVES]: { value: [{ id: "drive-1", name: "Compliance Reports" }] },
};

function clientDownloading(getBytes: GraphClient["getBytes"]): GraphClient {
  return {
    requests: () => 0,
    get: async <T,>(path: string): Promise<T> => {
      if (!(path in DRIVE_RESPONSES)) throw new Error(`unexpected get ${path}`);
      return DRIVE_RESPONSES[path as keyof typeof DRIVE_RESPONSES] as T;
    },
    post: async <T,>(): Promise<T> => {
      throw new Error("this test does not expect a post");
    },
    getBytes,
  };
}

describe("readWorkbookSnapshot failures", () => {
  it("refuses a workbook whose mapped table is missing rather than reporting an empty snapshot", async () => {
    const bytes = buildWorkbook({
      sheets: [{ name: "Tracker", rowsXml: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
      // No table named ClientRoster, which is what the example profile's
      // workbookMapping names.
      tables: [{ name: "SomeOtherTable", ref: "A1:A1", sheetIndex: 0 }],
    });

    const client = clientDownloading(async (path) => {
      if (path !== CONTENT_PATH) throw new Error(`unexpected getBytes ${path}`);
      return bytes;
    });

    await expect(readWorkbookSnapshot(client, PROFILE)).rejects.toThrow(/No table named "ClientRoster"/);
  });

  it("surfaces a download failure as a failure rather than an empty snapshot", async () => {
    const client = clientDownloading(async (path) => {
      if (path !== CONTENT_PATH) throw new Error(`unexpected getBytes ${path}`);
      throw new GraphRequestError({ method: "GET", path, status: 503, body: "service unavailable" });
    });

    // A caller that turned this failure into an empty snapshot would report a
    // client list of zero as compliance, which is indistinguishable from a
    // workbook that genuinely has no clients. The download failing must reach
    // the caller as a failure, not as data.
    await expect(readWorkbookSnapshot(client, PROFILE)).rejects.toThrow(GraphRequestError);
  });
});
