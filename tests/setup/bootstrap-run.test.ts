import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { runCreateBootstrap } from "../../src/setup/run.js";

function fakeGraph(): { graph: SetupGraph; calls: string[] } {
  const calls: string[] = [];
  const graph = {
    resolveSite: async () => {
      calls.push("resolveSite");
      return { siteId: "should-not-be-called" };
    },
    createApplication: async (request: { displayName: string }) => {
      calls.push(`createApplication:${request.displayName}`);
      return { objectId: "obj-1", appId: "app-1" };
    },
    addPassword: async (_objectId: string, credential: { displayName: string; endDateTime?: string }) => {
      calls.push(`addPassword:${credential.displayName}:${credential.endDateTime === undefined ? "no-expiry" : "expires"}`);
      return { secretText: "secret-1" };
    },
    createServicePrincipal: async () => {
      calls.push("createServicePrincipal");
      return { objectId: "sp-1" };
    },
    resolveServicePrincipal: async () => {
      calls.push("resolveServicePrincipal");
      return { objectId: "graph-sp", appRoles: [{ id: "role-full", value: "Sites.FullControl.All" }] };
    },
    grantAppRole: async (request: { appRoleId: string }) => {
      calls.push(`grantAppRole:${request.appRoleId}`);
    },
    grantSitePermission: async () => {
      calls.push("grantSitePermission");
      return { permissionId: "p" };
    },
    verifyAppAccess: async () => {
      calls.push("verifyAppAccess");
      return { status: 200, body: "{}", appRoles: [] };
    },
    deleteSitePermission: async () => {
      calls.push("deleteSitePermission");
    },
    deleteApplication: async () => {
      calls.push("deleteApplication");
    },
  } as unknown as SetupGraph;
  return { graph, calls };
}

describe("runCreateBootstrap", () => {
  it("creates a full control application and never touches a site", async () => {
    const { graph, calls } = fakeGraph();

    const result = await runCreateBootstrap(graph, { displayName: "Ironwright Grant Issuer" });

    // resolveServicePrincipal runs before createApplication, not after (unlike
    // the task brief's original sketch): buildAppRegistrationRequest needs the
    // real Sites.FullControl.All app role id at creation time, the same way
    // runSetup resolves Graph's service principal before registering its own
    // application.
    expect(calls).toEqual([
      "resolveServicePrincipal",
      "createApplication:Ironwright Grant Issuer",
      "addPassword:ironwright-grant-issuer:expires",
      "createServicePrincipal",
      "grantAppRole:role-full",
    ]);
    expect(calls).not.toContain("resolveSite");
    expect(calls).not.toContain("grantSitePermission");
    expect(calls).not.toContain("verifyAppAccess");
    expect(result).toEqual({ appId: "app-1", objectId: "obj-1", secret: "secret-1" });
  });
});

describe("the grant issuer's client secret", () => {
  it("expires on its own, because the application is only needed while setup runs", async () => {
    const { graph, calls } = fakeGraph();

    await runCreateBootstrap(graph, { displayName: "Ironwright Grant Issuer" });

    // Graph's default is two years. A tenant-wide SharePoint credential that
    // outlives the setup window by that much is the cost this expiry removes.
    expect(calls).toContain("addPassword:ironwright-grant-issuer:expires");
  });
});

