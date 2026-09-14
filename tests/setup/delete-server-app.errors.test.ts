import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { runDeleteServerApp } from "../../src/setup/run.js";

// Implements every SetupGraph method, not just the ones runDeleteServerApp is
// expected to call. A fake missing a method throws a TypeError the instant an
// unexpected call reaches it, before the calling test's own assertions run,
// which would make a negative assertion like "touches nothing" pass vacuously
// on a thrown error rather than on the fake actually recording no such call.
function fakeGraph(options: {
  app: { objectId: string; appId: string } | undefined;
  permissions: Array<{ permissionId: string; appIds: string[] }>;
  deleteApplicationStatus?: number;
  purgeStatus?: number;
}): { graph: SetupGraph; calls: string[] } {
  const calls: string[] = [];
  const graph: SetupGraph = {
    resolveSite: async (sitePath) => {
      calls.push(`resolveSite:${sitePath}`);
      return { siteId: "site-1" };
    },
    findApplicationByDisplayName: async (displayName) => {
      calls.push(`findApplicationByDisplayName:${displayName}`);
      return options.app;
    },
    createApplication: async () => {
      calls.push("createApplication");
      return { objectId: "should-not-be-called", appId: "should-not-be-called" };
    },
    addPassword: async (objectId) => {
      calls.push(`addPassword:${objectId}`);
      return { secretText: "should-not-be-called" };
    },
    createServicePrincipal: async (appId) => {
      calls.push(`createServicePrincipal:${appId}`);
      return { objectId: "should-not-be-called" };
    },
    resolveServicePrincipal: async (appId) => {
      calls.push(`resolveServicePrincipal:${appId}`);
      return { objectId: "should-not-be-called", appRoles: [] };
    },
    grantAppRole: async () => {
      calls.push("grantAppRole");
    },
    grantSitePermission: async (siteId) => {
      calls.push(`grantSitePermission:${siteId}`);
      return { permissionId: "should-not-be-called" };
    },
    listSitePermissions: async (siteId) => {
      calls.push(`listSitePermissions:${siteId}`);
      return options.permissions;
    },
    verifyAppAccess: async () => {
      calls.push("verifyAppAccess");
      return { status: 200, body: "{}", appRoles: [] };
    },
    deleteSitePermission: async (siteId, permissionId) => {
      calls.push(`deleteSitePermission:${siteId}:${permissionId}`);
    },
    deleteApplication: async (objectId) => {
      calls.push(`deleteApplication:${objectId}`);
      if (options.deleteApplicationStatus !== undefined) {
        throw new GraphRequestError({
          method: "DELETE",
          path: `/applications/${objectId}`,
          status: options.deleteApplicationStatus,
          body: "{}",
        });
      }
    },
    purgeDeletedApplication: async (objectId) => {
      calls.push(`purgeDeletedApplication:${objectId}`);
      if (options.purgeStatus !== undefined) {
        throw new GraphRequestError({
          method: "DELETE",
          path: `/directory/deletedItems/${objectId}`,
          status: options.purgeStatus,
          body: "{}",
        });
      }
    },
  };
  return { graph, calls };
}

describe("runDeleteServerApp errors", () => {
  it("refuses without a grant issuer, and touches nothing", async () => {
    const { graph, calls } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [{ permissionId: "perm-1", appIds: ["app-1"] }],
    });

    await expect(
      runDeleteServerApp(graph, {
        siteUrl: "https://contoso.sharepoint.com/sites/Example",
        displayName: "Ironwright Repository Reconciliation",
        confirm: true,
        forceOrphan: false,
        hasGrantIssuer: false,
      }),
    ).rejects.toThrow(/--create-bootstrap/);

    expect(calls).not.toContain("deleteApplication:obj-1");
    expect(calls).not.toContain("purgeDeletedApplication:obj-1");
  });

  it("with --force-orphan, deletes and purges without a grant issuer and reports the residue", async () => {
    const { graph, calls } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [],
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: true,
      hasGrantIssuer: false,
    });

    expect(outcome).toMatchObject({ kind: "torn-down", permissionRevoked: false, orphanedPermission: true });
    expect(calls).toContain("deleteApplication:obj-1");
    expect(calls).toContain("purgeDeletedApplication:obj-1");
    expect(calls).not.toContain("listSitePermissions:site-1");
  });

  it("tolerates a 404 from the delete and still purges", async () => {
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [],
      deleteApplicationStatus: 404,
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toMatchObject({ kind: "torn-down" });
  });

  it("tolerates a 404 from the purge, since already purged is the outcome asked for", async () => {
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [],
      purgeStatus: 404,
    });

    await expect(
      runDeleteServerApp(graph, {
        siteUrl: "https://contoso.sharepoint.com/sites/Example",
        displayName: "Ironwright Repository Reconciliation",
        confirm: true,
        forceOrphan: false,
        hasGrantIssuer: true,
      }),
    ).resolves.toMatchObject({ kind: "torn-down" });
  });

  it("says the grant is revoked and the application still exists when the delete fails", async () => {
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [{ permissionId: "perm-1", appIds: ["app-1"] }],
      deleteApplicationStatus: 403,
    });

    const failure = runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    await expect(failure).rejects.toThrow(/permission was revoked/i);
    await expect(failure).rejects.toThrow(/application still exists/i);
  });
});
