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

describe("runDeleteServerApp", () => {
  it("plans without touching anything when confirm is absent", async () => {
    const { graph, calls } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [{ permissionId: "perm-1", appIds: ["app-1"] }],
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: false,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toEqual({
      kind: "planned",
      appId: "app-1",
      objectId: "obj-1",
      permissionId: "perm-1",
      permissionsInspected: true,
    });
    // The exact list, not three not.toContain assertions against named
    // strings. Those three pass for any mutating call nobody thought to name,
    // and this test is the one that would catch the worst defect this mode can
    // have. Asserting the whole list also pins what nothing else asserts: that
    // resolveSite receives siteIdPathFromUrl's hostname-and-server-relative
    // form rather than the raw site URL, which Graph answers with a 400.
    expect(calls).toEqual([
      "findApplicationByDisplayName:Ironwright Repository Reconciliation",
      "resolveSite:contoso.sharepoint.com:/sites/Example",
      "listSitePermissions:site-1",
    ]);
  });

  it("marks the listing inspected but unmatched when a grant issuer's dry run finds no permission entry", async () => {
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [{ permissionId: "perm-9", appIds: ["someone-else"] }],
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: false,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toEqual({
      kind: "planned",
      appId: "app-1",
      objectId: "obj-1",
      permissionId: undefined,
      permissionsInspected: true,
    });
  });

  it("revokes, deletes and purges in that order when confirmed", async () => {
    const { graph, calls } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [{ permissionId: "perm-1", appIds: ["app-1"] }],
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toEqual({
      kind: "torn-down",
      appId: "app-1",
      objectId: "obj-1",
      permissionRevoked: true,
      orphanedPermission: false,
      applicationDeleted: true,
      purgeConfirmed: true,
    });
    expect(calls.filter((call) => /deleteSitePermission|deleteApplication|purgeDeletedApplication/.test(call))).toEqual([
      "deleteSitePermission:site-1:perm-1",
      "deleteApplication:obj-1",
      "purgeDeletedApplication:obj-1",
    ]);
  });

  it("reports an application that is already gone as done", async () => {
    const { graph, calls } = fakeGraph({ app: undefined, permissions: [] });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toEqual({ kind: "already-absent", displayName: "Ironwright Repository Reconciliation" });
    expect(calls).not.toContain("deleteApplication:obj-1");
  });

  it("deletes and purges when no permission entry is granted to the application", async () => {
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [{ permissionId: "perm-9", appIds: ["someone-else"] }],
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toMatchObject({ kind: "torn-down", permissionRevoked: false, orphanedPermission: false });
  });
});
