import { describe, expect, it } from "vitest";
import { resolveDrive, siteLookupPath } from "../../src/graph/drive.js";
import type { GraphClient } from "../../src/graph/client.js";

function fakeClient(responses: Record<string, unknown>): GraphClient {
  return {
    requests: () => 0,
    get: async <T,>(path: string): Promise<T> => {
      if (!(path in responses)) throw new Error(`unexpected path ${path}`);
      return responses[path] as T;
    },
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
      "/sites/site-1/drives?$select=id,name": {
        value: [
          { id: "drive-a", name: "Documents" },
          { id: "drive-b", name: "Compliance Reports" },
        ],
      },
    });

    await expect(resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Compliance Reports")).resolves.toEqual({
      siteId: "site-1",
      driveId: "drive-b",
    });
  });

  it("matches a library name case-insensitively when nothing matches exactly", async () => {
    const client = fakeClient({
      "/sites/contoso.sharepoint.com:/sites/Example": { id: "site-1" },
      "/sites/site-1/drives?$select=id,name": { value: [{ id: "drive-b", name: "Compliance Reports" }] },
    });

    await expect(resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "compliance reports")).resolves.toEqual({
      siteId: "site-1",
      driveId: "drive-b",
    });
  });
});
