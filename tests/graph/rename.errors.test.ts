import { describe, expect, it } from "vitest";
import { readDriveItemEtag, renameDriveItem } from "../../src/graph/rename.js";
import { GraphRequestError } from "../../src/graph/errors.js";

function graphError(method: string, status: number): GraphRequestError {
  return new GraphRequestError({ method, path: "/drives/d1/root:/a.xlsx:", status, body: "{}" });
}

describe("renameDriveItem outcomes", () => {
  it("reports a 412 as a failed precondition rather than throwing", async () => {
    const client = { patch: <T>(): Promise<T> => Promise.reject(graphError("PATCH", 412)) };

    await expect(
      renameDriveItem(client, { driveId: "d1", path: "a.xlsx", newName: "b.xlsx", etag: "e" }),
    ).resolves.toEqual({ kind: "precondition_failed" });
  });

  it("reports a 404 as the item being gone rather than throwing", async () => {
    const client = { patch: <T>(): Promise<T> => Promise.reject(graphError("PATCH", 404)) };

    await expect(
      renameDriveItem(client, { driveId: "d1", path: "a.xlsx", newName: "b.xlsx", etag: "e" }),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("rethrows any other Graph failure, since only 412 and 404 are expected outcomes", async () => {
    const client = { patch: <T>(): Promise<T> => Promise.reject(graphError("PATCH", 403)) };

    await expect(
      renameDriveItem(client, { driveId: "d1", path: "a.xlsx", newName: "b.xlsx", etag: "e" }),
    ).rejects.toBeInstanceOf(GraphRequestError);
  });

  it("rethrows a non-Graph failure untouched", async () => {
    const client = { patch: <T>(): Promise<T> => Promise.reject(new TypeError("network down")) };

    await expect(
      renameDriveItem(client, { driveId: "d1", path: "a.xlsx", newName: "b.xlsx", etag: "e" }),
    ).rejects.toThrow("network down");
  });
});

describe("readDriveItemEtag outcomes", () => {
  it("reports a 404 as not found rather than throwing", async () => {
    const client = { get: <T>(): Promise<T> => Promise.reject(graphError("GET", 404)) };

    await expect(readDriveItemEtag(client, { driveId: "d1", path: "a.xlsx" })).resolves.toEqual({ kind: "not_found" });
  });

  it("reports a found item whose response carried no etag as found with none, not as missing", async () => {
    const client = { get: async <T>(): Promise<T> => ({}) as unknown as T };

    await expect(readDriveItemEtag(client, { driveId: "d1", path: "a.xlsx" })).resolves.toEqual({
      kind: "found",
      etag: undefined,
    });
  });

  it("rethrows any other Graph failure", async () => {
    const client = { get: <T>(): Promise<T> => Promise.reject(graphError("GET", 500)) };

    await expect(readDriveItemEtag(client, { driveId: "d1", path: "a.xlsx" })).rejects.toBeInstanceOf(GraphRequestError);
  });
});
