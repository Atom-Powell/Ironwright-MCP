import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { describeDeleteServerAppOutcome } from "../../src/setup/cli.js";
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
  /**
   * Graph's machine-readable code in the purge failure's body. The
   * replication-lag retry matches on this code, not on the status alone, so a
   * test that wants the retry exercised has to send the code a lagging
   * deletedItems 404 actually carries.
   */
  purgeCode?: string;
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
          body: options.purgeCode === undefined ? "{}" : JSON.stringify({ error: { code: options.purgeCode } }),
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

  it("without a grant issuer, says whether the grant still exists was not checked rather than asserting it holds one", async () => {
    // This branch is reached only when the listing never ran, so it cannot
    // know whether a grant exists. Pins the corrected wording and the absence
    // of the earlier, unobserved claim.
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [{ permissionId: "perm-1", appIds: ["app-1"] }],
    });

    const failure = runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: false,
    });

    await expect(failure).rejects.toThrow(/was not checked/i);
    await expect(failure).rejects.not.toThrow(/still holds its grant/i);
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

  it("with --force-orphan, a dry run reports the listing as never inspected rather than empty", async () => {
    const { graph, calls } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [],
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: false,
      forceOrphan: true,
      hasGrantIssuer: false,
    });

    expect(outcome).toEqual({
      kind: "planned",
      appId: "app-1",
      objectId: "obj-1",
      permissionId: undefined,
      permissionsInspected: false,
    });
    expect(calls).not.toContain("listSitePermissions:site-1");
  });

  it("tolerates a 404 from the delete, still purges, and records that it did not delete", async () => {
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

    // applicationDeleted is the whole point. A 404 here is a tolerable outcome,
    // not an observed delete, and the formatter has no other way to tell them
    // apart.
    expect(outcome).toMatchObject({ kind: "torn-down", applicationDeleted: false, purgeConfirmed: true });
  });

  it("does not claim it deleted an application that was already gone", async () => {
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

    const message = describeDeleteServerAppOutcome(outcome, "https://contoso.sharepoint.com/sites/Example");

    expect(message).toMatch(/already gone when this run tried to delete it/i);
    expect(message).toMatch(/this run did not delete it/i);
    expect(message).not.toMatch(/Deleted application app-1/);
  });

  it("tolerates a 404 from the purge but records that the purge was not confirmed", async () => {
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
    ).resolves.toMatchObject({ kind: "torn-down", applicationDeleted: true, purgeConfirmed: false, purgeRetried: false });
  });

  it("does not claim the secret is unrecoverable when the purge returned not found", async () => {
    // The finding this test exists for. This 404 fires milliseconds after the
    // delete succeeded in the same run, so the likely cause is that the object
    // has not yet surfaced in deleted items, where it stays restorable with its
    // credentials for 30 days. Saying the secret is not recoverable there is
    // the exact opposite of the truth, on the scenario this mode was built for.
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [],
      purgeStatus: 404,
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    const message = describeDeleteServerAppOutcome(outcome, "https://contoso.sharepoint.com/sites/Example");

    expect(message).toMatch(/Deleted application app-1/);
    expect(message).toMatch(/purge returned not found/i);
    expect(message).toMatch(/could not confirm the purge/i);
    // "does not list app-1", not "is empty": that portal view is tenant-wide
    // and can legitimately hold other deleted objects, so the checkable
    // instruction names this application, not the whole view.
    expect(message).toMatch(/Deleted applications does not list app-1/);
    expect(message).not.toMatch(/not recoverable/i);
    // This 404 carries no code at all (isDirectoryReplicationLagError is false
    // on the very first attempt), so purgeDeletedApplicationWithRetry gives up
    // after zero sleeps. The message must not claim a retry ladder ran and
    // ruled out replication lag when nothing was ever retried.
    expect(outcome).toMatchObject({ purgeRetried: false });
    expect(message).not.toMatch(/even after retrying/i);
  });

  it("retries a purge that answers Request_ResourceNotFound, then gives up cleanly", async () => {
    const { graph, calls } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [],
      purgeStatus: 404,
      purgeCode: "Request_ResourceNotFound",
    });
    const slept: number[] = [];

    const outcome = await runDeleteServerApp(
      graph,
      {
        siteUrl: "https://contoso.sharepoint.com/sites/Example",
        displayName: "Ironwright Repository Reconciliation",
        confirm: true,
        forceOrphan: false,
        hasGrantIssuer: true,
      },
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    // Three attempts on the same ladder the service principal race uses, then
    // an unconfirmed purge rather than a thrown failure: nothing observed says
    // the object is gone, and nothing observed says the purge failed either.
    expect(calls.filter((call) => call === "purgeDeletedApplication:obj-1")).toHaveLength(3);
    expect(slept).toEqual([3000, 6000]);
    expect(outcome).toMatchObject({ kind: "torn-down", purgeConfirmed: false, purgeRetried: true });

    // Unlike the no-code 404 above, this run genuinely slept through the whole
    // ladder, so the message may say so.
    const message = describeDeleteServerAppOutcome(outcome, "https://contoso.sharepoint.com/sites/Example");
    expect(message).toMatch(/even after retrying/i);
  });

  it("does not retry a purge 404 that carries no replication-lag code", async () => {
    const { graph, calls } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [],
      purgeStatus: 404,
    });
    const slept: number[] = [];

    const outcome = await runDeleteServerApp(
      graph,
      {
        siteUrl: "https://contoso.sharepoint.com/sites/Example",
        displayName: "Ironwright Repository Reconciliation",
        confirm: true,
        forceOrphan: false,
        hasGrantIssuer: true,
      },
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    expect(calls.filter((call) => call === "purgeDeletedApplication:obj-1")).toHaveLength(1);
    expect(slept).toEqual([]);
    expect(outcome).toMatchObject({ purgeRetried: false });
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

  it("does not claim a revoke when the delete fails and no permission entry was found", async () => {
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [],
      deleteApplicationStatus: 403,
    });

    const failure = runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    await expect(failure).rejects.toThrow(/no site permission was revoked/i);
    await expect(failure).rejects.toThrow(/application still exists/i);
    await failure.catch((error: unknown) => {
      expect((error as Error).message).not.toMatch(/^The site permission was revoked/);
    });
  });

  it("says the application was deleted and names the restore window when the purge fails", async () => {
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [],
      purgeStatus: 403,
    });

    const failure = runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    await expect(failure).rejects.toThrow(/was deleted/i);
    await expect(failure).rejects.toThrow(/30 days/);
  });
});
