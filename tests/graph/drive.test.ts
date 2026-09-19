import { describe, expect, it } from "vitest";
import { listDrives, resolveDrive, siteLookupPath } from "../../src/graph/drive.js";
import type { GraphClient } from "../../src/graph/client.js";

function fakeClient(responses: Record<string, unknown>): GraphClient {
  return {
    requests: () => 0,
    get: async <T,>(path: string): Promise<T> => {
      if (!(path in responses)) throw new Error(`unexpected path ${path}`);
      return responses[path] as T;
    },
    post: async <T,>(): Promise<T> => { throw new Error("this fake does not implement post"); },
    patch: () => Promise.reject(new Error("this fake Graph client does not implement patch")),
    getBytes: async (): Promise<Uint8Array> => { throw new Error("this fake does not implement getBytes"); },
  };
}

describe("siteLookupPath", () => {
  it("turns a site URL into the hostname-and-server-relative-path form", () => {
    expect(siteLookupPath("https://contoso.sharepoint.com/sites/Example")).toBe(
      "/sites/contoso.sharepoint.com:/sites/Example",
    );
  });

  it("addresses the root site when the URL has no path", () => {
    expect(siteLookupPath("https://contoso.sharepoint.com")).toBe("/sites/contoso.sharepoint.com");
  });
});

describe("resolveDrive", () => {
  it("resolves the site then the named library", async () => {
    const client = fakeClient({
      "/sites/contoso.sharepoint.com:/sites/Example": { id: "site-1" },
      "/sites/site-1/drives?$select=id,name,webUrl": {
        value: [
          { id: "drive-a", name: "Documents" },
          { id: "drive-b", name: "Compliance Reports" },
        ],
      },
    });

    await expect(resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Compliance Reports")).resolves.toEqual({
      siteId: "site-1",
      driveId: "drive-b",
      drives: [
        { id: "drive-a", name: "Documents" },
        { id: "drive-b", name: "Compliance Reports" },
      ],
    });
  });

  it("matches a library name case-insensitively when nothing matches exactly", async () => {
    const client = fakeClient({
      "/sites/contoso.sharepoint.com:/sites/Example": { id: "site-1" },
      "/sites/site-1/drives?$select=id,name,webUrl": { value: [{ id: "drive-b", name: "Compliance Reports" }] },
    });

    await expect(resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "compliance reports")).resolves.toEqual({
      siteId: "site-1",
      driveId: "drive-b",
      drives: [{ id: "drive-b", name: "Compliance Reports" }],
    });
  });

  it("prefers an exact match over a case-insensitive one when both are present", async () => {
    const client = fakeClient({
      "/sites/contoso.sharepoint.com:/sites/Example": { id: "site-1" },
      "/sites/site-1/drives?$select=id,name,webUrl": {
        value: [
          { id: "drive-lower", name: "compliance reports" },
          { id: "drive-exact", name: "Compliance Reports" },
        ],
      },
    });

    await expect(resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Compliance Reports")).resolves.toEqual({
      siteId: "site-1",
      driveId: "drive-exact",
      drives: [
        { id: "drive-lower", name: "compliance reports" },
        { id: "drive-exact", name: "Compliance Reports" },
      ],
    });
  });

  it("hands back the same drive listing it resolved the own drive from, so a caller needing the site's other libraries spends no second request for it", async () => {
    const client = fakeClient({
      "/sites/contoso.sharepoint.com:/sites/Example": { id: "site-1" },
      "/sites/site-1/drives?$select=id,name,webUrl": {
        value: [
          { id: "drive-a", name: "Documents" },
          { id: "drive-b", name: "Compliance Reports" },
          { id: "drive-c", name: "Archive" },
        ],
      },
    });

    const result = await resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Compliance Reports");

    expect(result.drives.map((drive) => drive.id)).toEqual(["drive-a", "drive-b", "drive-c"]);
  });
});

describe("listDrives", () => {
  it("lists every drive on the site with its id and name", async () => {
    const client = {
      get: (async (path: string) => {
        if (path.includes("/drives")) {
          return { value: [{ id: "d1", name: "Documents" }, { id: "d2", name: "Archive" }] };
        }
        return { id: "site-1" };
      }) as never,
    };

    const result = await listDrives(client, "https://contoso.sharepoint.com/sites/Example");

    expect(result.siteId).toBe("site-1");
    expect(result.drives).toEqual([
      { id: "d1", name: "Documents" },
      { id: "d2", name: "Archive" },
    ]);
  });

  it("carries a drive's webUrl when the listing includes one", async () => {
    const client = {
      get: (async (path: string) => {
        if (path.includes("/drives")) {
          return {
            value: [{ id: "d1", name: "Documents", webUrl: "https://contoso.sharepoint.com/sites/Example/Documents" }],
          };
        }
        return { id: "site-1" };
      }) as never,
    };

    const result = await listDrives(client, "https://contoso.sharepoint.com/sites/Example");

    expect(result.drives).toEqual([
      { id: "d1", name: "Documents", webUrl: "https://contoso.sharepoint.com/sites/Example/Documents" },
    ]);
  });

  it("still resolves a drive with no webUrl, since resolveDrive never reads it", async () => {
    const client = {
      get: (async (path: string) => {
        if (path.includes("/drives")) return { value: [{ id: "d1", name: "Documents" }] };
        return { id: "site-1" };
      }) as never,
    };

    const result = await listDrives(client, "https://contoso.sharepoint.com/sites/Example");

    expect(result.drives).toEqual([{ id: "d1", name: "Documents" }]);
    expect("webUrl" in (result.drives[0] ?? {})).toBe(false);
  });

  it("still resolves one library by name through the extracted enumeration", async () => {
    // Pins that the extraction did not change resolveDrive's own behavior,
    // including the exact-before-case-insensitive rule.
    const client = {
      get: (async (path: string) => {
        if (path.includes("/drives")) {
          return { value: [{ id: "d1", name: "documents" }, { id: "d2", name: "Documents" }] };
        }
        return { id: "site-1" };
      }) as never,
    };

    const result = await resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Documents");

    expect(result.driveId).toBe("d2");
  });
});
