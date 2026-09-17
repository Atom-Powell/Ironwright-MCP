import { describe, expect, it } from "vitest";
import { readWorkbookRange } from "../../src/graph/excel.js";
import type { GraphClient } from "../../src/graph/client.js";
import { GraphRequestError } from "../../src/graph/errors.js";

const RANGE_PATH = "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/tables/ClientRoster/range";
const CREATE_PATH = "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/createSession";
const CLOSE_PATH = "/drives/d1/root:/Trackers/Tracker.xlsx:/workbook/closeSession";

const EXPIRED_SESSION = new GraphRequestError({
  method: "GET",
  path: RANGE_PATH,
  status: 404,
  body: JSON.stringify({ error: { code: "ItemNotFound", message: "session expired" } }),
});

describe("readWorkbookRange failures", () => {
  it("recreates an expired session once and retries the read", async () => {
    const calls: string[] = [];
    let sessionCounter = 0;
    let getCount = 0;

    const client: GraphClient = {
      requests: () => calls.length,
      get: async <T,>(path: string, headers?: Record<string, string>): Promise<T> => {
        calls.push(`get:${path}:${headers?.["workbook-session-id"] ?? ""}`);
        getCount += 1;
        if (getCount === 1) throw EXPIRED_SESSION;
        return { values: [["retried"]] } as T;
      },
      post: async <T,>(path: string, _body?: unknown, headers?: Record<string, string>): Promise<T> => {
        calls.push(`post:${path}:${headers?.["workbook-session-id"] ?? ""}`);
        if (path === CREATE_PATH) {
          sessionCounter += 1;
          return { id: `s-${sessionCounter}` } as T;
        }
        if (path === CLOSE_PATH) return undefined as T;
        throw new Error(`unexpected post ${path}`);
      },
      getBytes: async (): Promise<Uint8Array> => { throw new Error("this fake does not implement getBytes"); },
    };

    const values = await readWorkbookRange(client, {
      driveId: "d1",
      workbookPath: "/Trackers/Tracker.xlsx",
      source: { kind: "table", name: "ClientRoster" },
    });

    expect(values).toEqual([["retried"]]);
    const createCalls = calls.filter((call) => call.includes("createSession"));
    expect(createCalls).toHaveLength(2);
  });

  it("gives up when the read fails a second time on a fresh session", async () => {
    const calls: string[] = [];
    let sessionCounter = 0;

    const client: GraphClient = {
      requests: () => calls.length,
      get: async <T,>(path: string, headers?: Record<string, string>): Promise<T> => {
        calls.push(`get:${path}:${headers?.["workbook-session-id"] ?? ""}`);
        throw EXPIRED_SESSION;
      },
      post: async <T,>(path: string, _body?: unknown, headers?: Record<string, string>): Promise<T> => {
        calls.push(`post:${path}:${headers?.["workbook-session-id"] ?? ""}`);
        if (path === CREATE_PATH) {
          sessionCounter += 1;
          return { id: `s-${sessionCounter}` } as T;
        }
        if (path === CLOSE_PATH) return undefined as T;
        throw new Error(`unexpected post ${path}`);
      },
      getBytes: async (): Promise<Uint8Array> => { throw new Error("this fake does not implement getBytes"); },
    };

    await expect(
      readWorkbookRange(client, {
        driveId: "d1",
        workbookPath: "/Trackers/Tracker.xlsx",
        source: { kind: "table", name: "ClientRoster" },
      }),
    ).rejects.toThrow(GraphRequestError);

    const getCalls = calls.filter((call) => call.startsWith("get:"));
    const createCalls = calls.filter((call) => call.includes("createSession"));
    expect(getCalls).toHaveLength(2);
    expect(createCalls).toHaveLength(2);
  });

  it("closes the session even when the read fails", async () => {
    const calls: string[] = [];

    const client: GraphClient = {
      requests: () => calls.length,
      get: async <T,>(path: string, headers?: Record<string, string>): Promise<T> => {
        calls.push(`get:${path}:${headers?.["workbook-session-id"] ?? ""}`);
        throw new GraphRequestError({ method: "GET", path, status: 500, body: "boom" });
      },
      post: async <T,>(path: string, _body?: unknown, headers?: Record<string, string>): Promise<T> => {
        calls.push(`post:${path}:${headers?.["workbook-session-id"] ?? ""}`);
        if (path === CREATE_PATH) return { id: "s-1" } as T;
        if (path === CLOSE_PATH) return undefined as T;
        throw new Error(`unexpected post ${path}`);
      },
      getBytes: async (): Promise<Uint8Array> => { throw new Error("this fake does not implement getBytes"); },
    };

    await expect(
      readWorkbookRange(client, {
        driveId: "d1",
        workbookPath: "/Trackers/Tracker.xlsx",
        source: { kind: "table", name: "ClientRoster" },
      }),
    ).rejects.toThrow(GraphRequestError);

    const closeCalls = calls.filter((call) => call.includes("closeSession"));
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]).toContain(":s-1");
  });

  /**
   * The three shapes a range read can come back in that are not a grid. Each
   * one used to travel: an empty body became a bare TypeError with no mention
   * of the request, and a non-array `values` reached the workbook reader and
   * came back out as "the range came back empty", which describes the workbook
   * rather than the response that was actually received.
   */
  function clientReturning(body: unknown): GraphClient {
    let requests = 0;
    return {
      requests: () => requests,
      get: async <T,>(): Promise<T> => {
        requests += 1;
        return body as T;
      },
      post: async <T,>(path: string): Promise<T> => {
        requests += 1;
        if (path === CREATE_PATH) return { id: "s-1" } as T;
        if (path === CLOSE_PATH) return undefined as T;
        throw new Error(`unexpected post ${path}`);
      },
      getBytes: async (): Promise<Uint8Array> => { throw new Error("this fake does not implement getBytes"); },
    };
  }

  const READ_ARGS = {
    driveId: "d1",
    workbookPath: "/Trackers/Tracker.xlsx",
    source: { kind: "table", name: "ClientRoster" },
  } as const;

  it("refuses an empty response body rather than dereferencing through it", async () => {
    await expect(readWorkbookRange(clientReturning(undefined), READ_ARGS)).rejects.toThrow(/empty body/);
  });

  it("refuses a response with no values field, and says so", async () => {
    await expect(readWorkbookRange(clientReturning({ address: "Sheet1!A1:D9" }), READ_ARGS)).rejects.toThrow(
      /no values field/,
    );
  });

  it("refuses a values field that is not an array, rather than calling the range empty", async () => {
    const call = readWorkbookRange(clientReturning({ values: "A1:D9" }), READ_ARGS);

    await expect(call).rejects.toThrow(/not an array/);
    await expect(call).rejects.toThrow(/"A1:D9"/);
  });

  it("does not fail the read when closing the session fails", async () => {
    const calls: string[] = [];

    const client: GraphClient = {
      requests: () => calls.length,
      get: async <T,>(path: string, headers?: Record<string, string>): Promise<T> => {
        calls.push(`get:${path}:${headers?.["workbook-session-id"] ?? ""}`);
        return { values: [["ok"]] } as T;
      },
      post: async <T,>(path: string, _body?: unknown, headers?: Record<string, string>): Promise<T> => {
        calls.push(`post:${path}:${headers?.["workbook-session-id"] ?? ""}`);
        if (path === CREATE_PATH) return { id: "s-1" } as T;
        if (path === CLOSE_PATH) throw new GraphRequestError({ method: "POST", path, status: 500, body: "close failed" });
        throw new Error(`unexpected post ${path}`);
      },
      getBytes: async (): Promise<Uint8Array> => { throw new Error("this fake does not implement getBytes"); },
    };

    const values = await readWorkbookRange(client, {
      driveId: "d1",
      workbookPath: "/Trackers/Tracker.xlsx",
      source: { kind: "table", name: "ClientRoster" },
    });

    expect(values).toEqual([["ok"]]);
  });
});
