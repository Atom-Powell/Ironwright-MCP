import { describe, expect, it } from "vitest";
import { readDriveItemEtag, renameDriveItem } from "../../src/graph/rename.js";

describe("renameDriveItem", () => {
  it("addresses the item by path and sends the new name under the supplied etag", async () => {
    const calls: Array<{ path: string; body: unknown; headers?: Record<string, string> }> = [];
    const client = {
      patch: async <T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> => {
        calls.push({ path, body, ...(headers === undefined ? {} : { headers }) });
        return { eTag: '"{GUID},7"' } as unknown as T;
      },
    };

    const outcome = await renameDriveItem(client, {
      driveId: "d1",
      path: "2026/CLIENTA/01-January/old name.xlsx",
      newName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
      etag: '"{GUID},6"',
    });

    expect(outcome).toEqual({ kind: "renamed", etag: '"{GUID},7"' });
    expect(calls[0]?.path).toBe("/drives/d1/root:/2026/CLIENTA/01-January/old%20name.xlsx:");
    expect(calls[0]?.body).toEqual({ name: "2026-01_CLIENTA_MonthlyTraining.xlsx" });
    expect(calls[0]?.headers?.["if-match"]).toBe('"{GUID},6"');
  });

  it("reports a renamed item with no etag in the response rather than inventing one", async () => {
    const client = { patch: async <T>(): Promise<T> => ({}) as unknown as T };

    await expect(
      renameDriveItem(client, { driveId: "d1", path: "a.xlsx", newName: "b.xlsx", etag: "e" }),
    ).resolves.toEqual({ kind: "renamed", etag: undefined });
  });

  // An object with no eTag property, which the test above covers, is not the
  // only way Graph can answer without one. `createGraphClient` returns
  // `undefined as T` for a zero-length body, and a 204 passes its success
  // check, so a PATCH answered with no body reaches this function as
  // `undefined`. Reading a property off that used to throw, and the executor's
  // error boundary then reported a rename that HAD happened as failed.
  it("reports a renamed item when the response body was empty, rather than throwing on it", async () => {
    const client = { patch: async <T>(): Promise<T> => undefined as T };

    await expect(
      renameDriveItem(client, { driveId: "d1", path: "a.xlsx", newName: "b.xlsx", etag: "e" }),
    ).resolves.toEqual({ kind: "renamed", etag: undefined });
  });

  it("reports a renamed item when the response body was null, rather than throwing on it", async () => {
    const client = { patch: async <T>(): Promise<T> => null as T };

    await expect(
      renameDriveItem(client, { driveId: "d1", path: "a.xlsx", newName: "b.xlsx", etag: "e" }),
    ).resolves.toEqual({ kind: "renamed", etag: undefined });
  });
});

describe("readDriveItemEtag", () => {
  it("selects only the etag and returns it", async () => {
    const calls: string[] = [];
    const client = {
      get: async <T>(path: string): Promise<T> => {
        calls.push(path);
        return { eTag: '"{GUID},3"' } as unknown as T;
      },
    };

    await expect(readDriveItemEtag(client, { driveId: "d1", path: "a/b.xlsx" })).resolves.toEqual({
      kind: "found",
      etag: '"{GUID},3"',
    });
    expect(calls[0]).toBe("/drives/d1/root:/a/b.xlsx:?$select=eTag");
  });

  it("reports an item found with no etag rather than throwing, for each shape that can mean that", async () => {
    // Three distinct shapes, not one. The middle two are what the real client
    // hands back for an empty and a null response body; a guard written only
    // against the first threw on both.
    for (const body of [{}, undefined, null]) {
      const client = { get: async <T>(): Promise<T> => body as T };

      await expect(readDriveItemEtag(client, { driveId: "d1", path: "a/b.xlsx" })).resolves.toEqual({
        kind: "found",
        etag: undefined,
      });
    }
  });
});
