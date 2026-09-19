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
});
