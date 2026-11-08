import { describe, expect, it } from "vitest";
import { createFile, createFolder, overwriteFile, readDriveItem } from "../../src/graph/items.js";
import { F0_FOLDER_CREATED, F2A_FILE_CREATED, F3A_FILE_OVERWRITTEN } from "./fixtures/assessment-probe.js";

const FILE_PATH = "IW-Probe/probe 20261107T203924Z/dossier.md";
const FILE_URL = "/drives/d1/root:/IW-Probe/probe%2020261107T203924Z/dossier.md:";

function recordingClient(response: unknown) {
  const calls: Array<{ verb: string; path: string; body?: unknown; contentType?: string; headers?: Record<string, string> }> = [];
  return {
    calls,
    get: async <T>(path: string): Promise<T> => {
      calls.push({ verb: "get", path });
      return response as T;
    },
    post: async <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ verb: "post", path, body });
      return response as T;
    },
    putBytes: async <T>(path: string, body: Uint8Array, contentType: string, headers?: Record<string, string>): Promise<T> => {
      calls.push({ verb: "putBytes", path, body, contentType, ...(headers === undefined ? {} : { headers }) });
      return response as T;
    },
  };
}

describe("readDriveItem", () => {
  it("reads one item by path with the projection the module needs", async () => {
    const client = recordingClient(F2A_FILE_CREATED);
    const result = await readDriveItem(client, { driveId: "d1", path: FILE_PATH });

    expect(client.calls[0]?.path).toBe(`${FILE_URL}?$select=id,name,eTag,size,lastModifiedDateTime,webUrl,folder,file`);
    expect(result).toMatchObject({
      kind: "found",
      item: { id: F2A_FILE_CREATED.id, name: "dossier.md", eTag: "<etag-3>", size: 8, isFolder: false },
    });
  });

  it("reports a folder as a folder", async () => {
    const client = recordingClient(F0_FOLDER_CREATED);
    const result = await readDriveItem(client, { driveId: "d1", path: "IW-Probe" });

    expect(result).toMatchObject({ kind: "found", item: { isFolder: true } });
  });
});

describe("createFolder", () => {
  it("posts to the library root children with conflictBehavior fail", async () => {
    const client = recordingClient(F0_FOLDER_CREATED);
    const result = await createFolder(client, { driveId: "d1", parentPath: "", name: "IW-Probe" });

    expect(client.calls[0]?.path).toBe("/drives/d1/root/children");
    expect(client.calls[0]?.body).toEqual({ name: "IW-Probe", folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
    expect(result).toMatchObject({ kind: "created", item: { eTag: "<etag-1>", isFolder: true } });
  });

  it("posts to a parent path children", async () => {
    const client = recordingClient(F0_FOLDER_CREATED);
    await createFolder(client, { driveId: "d1", parentPath: "IW-Probe", name: "sub" });

    expect(client.calls[0]?.path).toBe("/drives/d1/root:/IW-Probe:/children");
  });
});

describe("createFile", () => {
  it("puts the bytes to the content endpoint with conflictBehavior fail", async () => {
    const client = recordingClient(F2A_FILE_CREATED);
    const bytes = new TextEncoder().encode("# probe\n");
    const result = await createFile(client, { driveId: "d1", path: FILE_PATH, bytes, contentType: "text/markdown" });

    expect(client.calls[0]).toMatchObject({
      verb: "putBytes",
      path: `${FILE_URL}/content?@microsoft.graph.conflictBehavior=fail`,
      contentType: "text/markdown",
    });
    expect(client.calls[0]?.body).toBe(bytes);
    expect(result).toMatchObject({ kind: "created", item: { eTag: "<etag-3>" } });
  });
});

describe("overwriteFile", () => {
  it("puts under If-Match with no conflictBehavior and returns the new ETag", async () => {
    const client = recordingClient(F3A_FILE_OVERWRITTEN);
    const result = await overwriteFile(client, {
      driveId: "d1",
      path: FILE_PATH,
      bytes: new TextEncoder().encode("# probe v2\n"),
      contentType: "text/markdown",
      etag: "<etag-3>",
    });

    expect(client.calls[0]?.path).toBe(`${FILE_URL}/content`);
    expect(client.calls[0]?.headers).toEqual({ "if-match": "<etag-3>" });
    expect(result).toMatchObject({ kind: "overwritten", item: { eTag: F3A_FILE_OVERWRITTEN.eTag } });
  });
});
