import { describe, expect, it } from "vitest";
import { parentReferencePath, relocateDriveItem } from "../../src/graph/relocate.js";

function recordingClient(response: unknown = { eTag: '"{GUID},2"' }) {
  const calls: Array<{ path: string; body: unknown; headers?: Record<string, string> }> = [];
  return {
    calls,
    patch: async <T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> => {
      calls.push({ path, body, ...(headers === undefined ? {} : { headers }) });
      return response as T;
    },
  };
}

describe("parentReferencePath", () => {
  it("writes the folder path raw, since it travels in the JSON body and Graph rejects an encoded one", () => {
    expect(parentReferencePath("d1", "2026/Client A/hash#pct%")).toBe("/drives/d1/root:/2026/Client A/hash#pct%");
  });

  it("addresses the library root with no trailing segment", () => {
    expect(parentReferencePath("d1", "")).toBe("/drives/d1/root:");
  });
});

describe("relocateDriveItem", () => {
  it("sends only the name for a rename, with no conflict behavior", async () => {
    const client = recordingClient();
    await relocateDriveItem(client, { driveId: "d1", path: "a/old.xlsx", etag: "e1", newName: "new.xlsx" });

    expect(client.calls[0]?.body).toEqual({ name: "new.xlsx" });
    expect(client.calls[0]?.headers?.["if-match"]).toBe("e1");
  });

  it("sends the parent reference and conflictBehavior fail for a move", async () => {
    const client = recordingClient();
    await relocateDriveItem(client, { driveId: "d1", path: "a/f.xlsx", etag: "e1", newParentPath: "b" });

    expect(client.calls[0]?.path).toBe("/drives/d1/root:/a/f.xlsx:");
    expect(client.calls[0]?.body).toEqual({
      parentReference: { path: "/drives/d1/root:/b" },
      "@microsoft.graph.conflictBehavior": "fail",
    });
  });

  it("sends name and parent together for a move that also renames", async () => {
    const client = recordingClient();
    await relocateDriveItem(client, { driveId: "d1", path: "a/x.xlsx", etag: "e1", newName: "y.xlsx", newParentPath: "b" });

    expect(client.calls[0]?.body).toEqual({
      name: "y.xlsx",
      parentReference: { path: "/drives/d1/root:/b" },
      "@microsoft.graph.conflictBehavior": "fail",
    });
  });

  it("returns the new etag the response carries", async () => {
    const client = recordingClient({ eTag: '"{GUID},9"' });
    await expect(
      relocateDriveItem(client, { driveId: "d1", path: "a/f.xlsx", etag: "e1", newParentPath: "b" }),
    ).resolves.toEqual({ kind: "relocated", etag: '"{GUID},9"' });
  });
});
