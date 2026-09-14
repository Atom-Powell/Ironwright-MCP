import { describe, expect, it } from "vitest";
import { readWorkbookRange } from "../../src/graph/excel.js";
import type { GraphClient } from "../../src/graph/client.js";

/**
 * Records every call as "method:path:sessionHeader" so a test can assert both
 * which endpoint was hit and which session id, if any, rode along with it.
 */
function fakeClient(
  calls: string[],
  responses: { get?: Record<string, unknown>; post?: Record<string, unknown> },
  bodies: unknown[] = [],
): GraphClient {
  return {
    requests: () => calls.length,
    get: async <T,>(path: string, headers?: Record<string, string>): Promise<T> => {
      calls.push(`get:${path}:${headers?.["workbook-session-id"] ?? ""}`);
      if (!(path in (responses.get ?? {}))) throw new Error(`unexpected get ${path}`);
      return responses.get?.[path] as T;
    },
    post: async <T,>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> => {
      calls.push(`post:${path}:${headers?.["workbook-session-id"] ?? ""}`);
      bodies.push(body);
      if (!(path in (responses.post ?? {}))) throw new Error(`unexpected post ${path}`);
      return responses.post?.[path] as T;
    },
  };
}

describe("readWorkbookRange", () => {
  it("opens a non-persistent session, reads a table's range, and closes it", async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, {
      post: {
        "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/createSession": { id: "s-1" },
        "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/closeSession": undefined,
      },
      get: {
        "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/tables/ClientRoster/range": {
          values: [["Client"], ["CLIENTA"]],
        },
      },
    });

    const values = await readWorkbookRange(client, {
      driveId: "d1",
      workbookPath: "/Trackers/Tracker.xlsx",
      source: { kind: "table", name: "ClientRoster" },
    });

    expect(values).toEqual([["Client"], ["CLIENTA"]]);
    expect(calls[0]).toContain("createSession");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]).toContain("closeSession");
  });

  it("sends persistChanges false, so the session cannot commit a change to the workbook", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const client = fakeClient(
      calls,
      {
        post: {
          "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/createSession": { id: "s-1" },
          "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/closeSession": undefined,
        },
        get: {
          "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/tables/ClientRoster/range": {
            values: [["Client"]],
          },
        },
      },
      bodies,
    );

    await readWorkbookRange(client, {
      driveId: "d1",
      workbookPath: "/Trackers/Tracker.xlsx",
      source: { kind: "table", name: "ClientRoster" },
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({ persistChanges: false });
  });

  it("carries the session id on the read and on the close", async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, {
      post: {
        "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/createSession": { id: "s-1" },
        "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/closeSession": undefined,
      },
      get: {
        "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/tables/ClientRoster/range": {
          values: [["Client"]],
        },
      },
    });

    await readWorkbookRange(client, {
      driveId: "d1",
      workbookPath: "/Trackers/Tracker.xlsx",
      source: { kind: "table", name: "ClientRoster" },
    });

    const readCall = calls.find((call) => call.startsWith("get:"));
    const closeCall = calls.find((call) => call.includes("closeSession"));

    expect(readCall).toBeDefined();
    expect(readCall).toContain(":s-1");
    expect(closeCall).toBeDefined();
    expect(closeCall).toContain(":s-1");
  });

  it("reads a worksheet's used range when the mapping names a worksheet", async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, {
      post: {
        "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/createSession": { id: "s-1" },
        "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/closeSession": undefined,
      },
      get: {
        "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/worksheets/Sheet1/usedRange": {
          values: [["A1"]],
        },
      },
    });

    const values = await readWorkbookRange(client, {
      driveId: "d1",
      workbookPath: "/Trackers/Tracker.xlsx",
      source: { kind: "worksheet", name: "Sheet1" },
    });

    expect(values).toEqual([["A1"]]);
    const readCall = calls.find((call) => call.startsWith("get:"));
    expect(readCall).toBeDefined();
    expect(readCall).toContain("/workbook/worksheets/Sheet1/usedRange");
  });
});
