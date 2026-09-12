import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { runSetup } from "../../src/setup/run.js";

function fakeGraph(overrides: Partial<SetupGraph> = {}): { graph: SetupGraph; calls: string[] } {
  const calls: string[] = [];
  const graph: SetupGraph = {
    createApplication: async (request) => {
      calls.push(`createApplication:${request.displayName}`);
      return { objectId: "object-1", appId: "app-1" };
    },
    addPassword: async (objectId) => {
      calls.push(`addPassword:${objectId}`);
      return { secretText: "secret-1" };
    },
    resolveSite: async (sitePath) => {
      calls.push(`resolveSite:${sitePath}`);
      return { siteId: "site-1" };
    },
    grantSitePermission: async (siteId, request) => {
      calls.push(`grantSitePermission:${siteId}:${request.roles.join(",")}`);
    },
    verifyAppAccess: async () => {
      calls.push("verifyAppAccess");
      return { status: 200, body: "{}" };
    },
    ...overrides,
  };
  return { graph, calls };
}

describe("runSetup", () => {
  it("registers, secures, grants, then verifies, in that order", async () => {
    const { graph, calls } = fakeGraph();

    const result = await runSetup(graph, {
      displayName: "Ironwright Reconciliation",
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      write: true,
    });

    expect(calls).toEqual([
      "createApplication:Ironwright Reconciliation",
      "addPassword:object-1",
      "resolveSite:contoso.sharepoint.com:/sites/Example",
      "grantSitePermission:site-1:write",
      "verifyAppAccess",
    ]);
    expect(result).toEqual({ appId: "app-1", objectId: "object-1", secret: "secret-1", siteId: "site-1" });
  });

  it("requests read-only access when write is false", async () => {
    const { graph, calls } = fakeGraph();

    await runSetup(graph, { displayName: "App", siteUrl: "https://contoso.sharepoint.com/sites/Example", write: false });

    expect(calls).toContain("grantSitePermission:site-1:read");
  });
});
