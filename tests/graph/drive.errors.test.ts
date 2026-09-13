import { describe, expect, it } from "vitest";
import { LibraryNotFoundError, resolveDrive } from "../../src/graph/drive.js";
import type { GraphClient } from "../../src/graph/client.js";

function fakeClient(responses: Record<string, unknown>): GraphClient {
  return {
    requests: () => 0,
    get: async <T,>(path: string): Promise<T> => responses[path] as T,
  };
}

describe("resolveDrive failures", () => {
  it("lists the libraries that do exist, because a bare not-found sends an operator to the wrong place", async () => {
    const client = fakeClient({
      "/sites/contoso.sharepoint.com:/sites/Example": { id: "site-1" },
      "/sites/site-1/drives?$select=id,name": {
        value: [
          { id: "drive-a", name: "Documents" },
          { id: "drive-c", name: "Archive" },
        ],
      },
    });

    const failure = resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Compliance Reports");

    await expect(failure).rejects.toThrow(LibraryNotFoundError);
    await expect(failure).rejects.toThrow(/"Archive", "Documents"/);
  });

  it("says the site has no libraries at all rather than printing an empty list", async () => {
    const client = fakeClient({
      "/sites/contoso.sharepoint.com:/sites/Example": { id: "site-1" },
      "/sites/site-1/drives?$select=id,name": { value: [] },
    });

    await expect(
      resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Compliance Reports"),
    ).rejects.toThrow(/no document libraries/i);
  });

  it("refuses a site response with no id rather than addressing /sites/undefined/drives", async () => {
    const client = fakeClient({ "/sites/contoso.sharepoint.com:/sites/Example": {} });

    await expect(
      resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Compliance Reports"),
    ).rejects.toThrow(/no id/i);
  });
});
