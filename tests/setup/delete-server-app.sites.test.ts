import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { describeDeleteServerAppOutcome } from "../../src/setup/cli.js";
import { runDeleteServerApp } from "../../src/setup/run.js";

const FINANCE = "https://contoso.sharepoint.com/sites/Finance";
const LEGAL = "https://contoso.sharepoint.com/sites/Legal";
const HR = "https://contoso.sharepoint.com/sites/HR";

// Keyed by the path resolveSite receives, so a test also proves each site URL
// is turned into its own siteIdPathFromUrl form rather than all of them
// resolving to the first.
const SITES: Record<string, { siteId: string }> = {
  "contoso.sharepoint.com:/sites/Finance": { siteId: "site-fin" },
  "contoso.sharepoint.com:/sites/Legal": { siteId: "site-legal" },
  "contoso.sharepoint.com:/sites/HR": { siteId: "site-hr" },
  // A spelling the parser cannot tell from Finance by its text, which Graph
  // resolves to the same site all the same.
  "contoso.sharepoint.com:/sites/Fin%61nce": { siteId: "site-fin" },
};

// Implements every SetupGraph method for the same reason the single-site fakes
// do: a missing method throws a TypeError that would make a "touches nothing"
// assertion pass on the thrown error rather than on the recorded calls.
function fakeGraph(options: {
  app: { objectId: string; appId: string } | undefined;
  permissions: Record<string, Array<{ permissionId: string; appIds: string[] }>>;
  listFailsFor?: string;
  revokeFailsFor?: string;
  /** The status the failing revoke answers with; 403 unless a test says otherwise. */
  revokeFailStatus?: number;
}): { graph: SetupGraph; calls: string[] } {
  const calls: string[] = [];
  const graph: SetupGraph = {
    resolveSite: async (sitePath) => {
      calls.push(`resolveSite:${sitePath}`);
      const site = SITES[sitePath];
      if (site === undefined) {
        throw new GraphRequestError({ method: "GET", path: `/sites/${sitePath}`, status: 404, body: "{}" });
      }
      return site;
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
      if (options.listFailsFor === siteId) {
        throw new GraphRequestError({ method: "GET", path: `/sites/${siteId}/permissions`, status: 403, body: "{}" });
      }
      return options.permissions[siteId] ?? [];
    },
    verifyAppAccess: async () => {
      calls.push("verifyAppAccess");
      return { status: 200, body: "{}", appRoles: [] };
    },
    deleteSitePermission: async (siteId, permissionId) => {
      calls.push(`deleteSitePermission:${siteId}:${permissionId}`);
      if (options.revokeFailsFor === siteId) {
        throw new GraphRequestError({
          method: "DELETE",
          path: `/sites/${siteId}/permissions/${permissionId}`,
          status: options.revokeFailStatus ?? 403,
          body: "{}",
        });
      }
    },
    deleteApplication: async (objectId) => {
      calls.push(`deleteApplication:${objectId}`);
    },
    purgeDeletedApplication: async (objectId) => {
      calls.push(`purgeDeletedApplication:${objectId}`);
    },
  };
  return { graph, calls };
}

const APP = { objectId: "obj-1", appId: "app-1" };
const NAME = "Ironwright Repository Reconciliation";
const WRITES = /deleteSitePermission|deleteApplication|purgeDeletedApplication/;

describe("runDeleteServerApp across several sites", () => {
  it("revokes every site's entry in the order given, then deletes, then purges", async () => {
    const { graph, calls } = fakeGraph({
      app: APP,
      permissions: {
        "site-fin": [{ permissionId: "perm-fin", appIds: ["app-1"] }],
        "site-legal": [{ permissionId: "perm-legal", appIds: ["app-1"] }],
      },
    });
    const notices: string[] = [];

    const outcome = await runDeleteServerApp(
      graph,
      { siteUrls: [FINANCE, LEGAL], displayName: NAME, confirm: true, forceOrphan: false, hasGrantIssuer: true },
      { onNotice: (message) => notices.push(message) },
    );

    expect(outcome).toEqual({
      kind: "torn-down",
      appId: "app-1",
      objectId: "obj-1",
      sites: [
        { siteUrl: FINANCE, permission: "revoked" },
        { siteUrl: LEGAL, permission: "revoked" },
      ],
      orphanedPermission: false,
      applicationDeleted: true,
      purgeConfirmed: true,
      purgeRetried: false,
    });
    // Every read before the first write: the whole point of reading first is
    // that a failure on the last site cannot leave the first one half done.
    expect(calls).toEqual([
      `findApplicationByDisplayName:${NAME}`,
      "resolveSite:contoso.sharepoint.com:/sites/Finance",
      "listSitePermissions:site-fin",
      "resolveSite:contoso.sharepoint.com:/sites/Legal",
      "listSitePermissions:site-legal",
      "deleteSitePermission:site-fin:perm-fin",
      "deleteSitePermission:site-legal:perm-legal",
      "deleteApplication:obj-1",
      "purgeDeletedApplication:obj-1",
    ]);
    expect(notices.filter((notice) => notice.startsWith("Revoking"))).toEqual([
      `Revoking site permission perm-fin on ${FINANCE}.`,
      `Revoking site permission perm-legal on ${LEGAL}.`,
    ]);
  });

  it("revokes where an entry exists and records the site that had none", async () => {
    const { graph, calls } = fakeGraph({
      app: APP,
      permissions: {
        "site-fin": [{ permissionId: "perm-fin", appIds: ["app-1"] }],
        "site-legal": [{ permissionId: "perm-other", appIds: ["someone-else"] }],
      },
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrls: [FINANCE, LEGAL],
      displayName: NAME,
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toMatchObject({
      kind: "torn-down",
      sites: [
        { siteUrl: FINANCE, permission: "revoked" },
        { siteUrl: LEGAL, permission: "none" },
      ],
    });
    expect(calls.filter((call) => WRITES.test(call))).toEqual([
      "deleteSitePermission:site-fin:perm-fin",
      "deleteApplication:obj-1",
      "purgeDeletedApplication:obj-1",
    ]);

    const message = describeDeleteServerAppOutcome(outcome, [FINANCE, LEGAL]);
    expect(message).toContain(`Revoked its permission entry on ${FINANCE}.`);
    expect(message).toContain(`No permission entry on ${LEGAL} was granted to it, so none was revoked there.`);
    expect(message).toMatch(/Onboarding these sites again/);
  });

  it("previews every site without writing anything", async () => {
    const { graph, calls } = fakeGraph({
      app: APP,
      permissions: { "site-fin": [{ permissionId: "perm-fin", appIds: ["app-1"] }] },
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrls: [FINANCE, LEGAL],
      displayName: NAME,
      confirm: false,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toEqual({
      kind: "planned",
      appId: "app-1",
      objectId: "obj-1",
      sites: [
        { siteUrl: FINANCE, permissionId: "perm-fin" },
        { siteUrl: LEGAL, permissionId: undefined },
      ],
      permissionsInspected: true,
    });
    expect(calls.filter((call) => WRITES.test(call))).toEqual([]);

    const message = describeDeleteServerAppOutcome(outcome, [FINANCE, LEGAL]);
    expect(message).toMatch(/dry run and nothing was changed/);
    expect(message).toContain(`On ${FINANCE} it would revoke permission entry perm-fin.`);
    expect(message).toContain(`On ${LEGAL} no permission entry is granted to it, so there would be nothing to revoke there.`);
    expect(message).not.toMatch(/Deleted|Purged|Revoked/);
  });

  it("refuses before any write when the second site's listing fails, and names that site", async () => {
    const { graph, calls } = fakeGraph({
      app: APP,
      permissions: { "site-fin": [{ permissionId: "perm-fin", appIds: ["app-1"] }] },
      listFailsFor: "site-legal",
    });

    const failure = runDeleteServerApp(graph, {
      siteUrls: [FINANCE, LEGAL],
      displayName: NAME,
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    await expect(failure).rejects.toThrow(new RegExp(`Listing the permissions on ${LEGAL} failed`));
    await expect(failure).rejects.toThrow(/nothing was changed/i);
    await failure.catch((error: unknown) => {
      // Kept so describeSetupFailure can still reach the site permissions
      // remedy, which names the grant issuer as the likely cause of a 403 here.
      expect((error as Error).cause).toBeInstanceOf(GraphRequestError);
    });
    expect(calls.filter((call) => WRITES.test(call))).toEqual([]);
  });

  it("refuses before any write when a later site does not resolve, and names that site", async () => {
    const { graph, calls } = fakeGraph({
      app: APP,
      permissions: { "site-fin": [{ permissionId: "perm-fin", appIds: ["app-1"] }] },
    });
    const missing = "https://contoso.sharepoint.com/sites/Gone";

    const failure = runDeleteServerApp(graph, {
      siteUrls: [FINANCE, missing],
      displayName: NAME,
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    await expect(failure).rejects.toThrow(new RegExp(`Resolving ${missing} failed`));
    await expect(failure).rejects.toThrow(/nothing was changed/i);
    expect(calls.filter((call) => WRITES.test(call))).toEqual([]);
  });

  it("stops at a failed revoke, keeps the application, and names revoked, failed and unattempted sites", async () => {
    const { graph, calls } = fakeGraph({
      app: APP,
      permissions: {
        "site-fin": [{ permissionId: "perm-fin", appIds: ["app-1"] }],
        "site-legal": [{ permissionId: "perm-legal", appIds: ["app-1"] }],
        "site-hr": [{ permissionId: "perm-hr", appIds: ["app-1"] }],
      },
      revokeFailsFor: "site-legal",
    });

    const failure = runDeleteServerApp(graph, {
      siteUrls: [FINANCE, LEGAL, HR],
      displayName: NAME,
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    await expect(failure).rejects.toThrow(new RegExp(`Revoking permission entry perm-legal on ${LEGAL} failed`));
    await expect(failure).rejects.toThrow(new RegExp(`Already revoked: ${FINANCE}\\.`));
    await expect(failure).rejects.toThrow(new RegExp(`Not yet attempted: ${HR}\\.`));
    await expect(failure).rejects.toThrow(/application app-1 still exists/);
    await expect(failure).rejects.toThrow(/Re-running is safe/);
    await failure.catch((error: unknown) => {
      expect((error as Error).cause).toBeInstanceOf(GraphRequestError);
    });
    // The application is the only key a re-run has to find the remaining
    // entries, so it must survive a failed revoke.
    expect(calls.filter((call) => WRITES.test(call))).toEqual([
      "deleteSitePermission:site-fin:perm-fin",
      "deleteSitePermission:site-legal:perm-legal",
    ]);
  });

  it("names a later site with no entry as having nothing to revoke when a revoke fails", async () => {
    const { graph } = fakeGraph({
      app: APP,
      permissions: {
        "site-fin": [{ permissionId: "perm-fin", appIds: ["app-1"] }],
        "site-hr": [{ permissionId: "perm-hr", appIds: ["app-1"] }],
      },
      revokeFailsFor: "site-fin",
    });

    const failure = runDeleteServerApp(graph, {
      siteUrls: [FINANCE, LEGAL, HR],
      displayName: NAME,
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    await expect(failure).rejects.toThrow(new RegExp(`Already revoked: none\\.`));
    await expect(failure).rejects.toThrow(new RegExp(`Not yet attempted: ${HR}\\.`));
    await expect(failure).rejects.toThrow(new RegExp(`Nothing to revoke on: ${LEGAL}\\.`));
  });

  it("with one site, a failed revoke reads without the per-site lists", async () => {
    const { graph, calls } = fakeGraph({
      app: APP,
      permissions: { "site-fin": [{ permissionId: "perm-fin", appIds: ["app-1"] }] },
      revokeFailsFor: "site-fin",
    });

    const failure = runDeleteServerApp(graph, {
      siteUrls: [FINANCE],
      displayName: NAME,
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    await expect(failure).rejects.toThrow(new RegExp(`Revoking permission entry perm-fin on ${FINANCE} failed`));
    await expect(failure).rejects.toThrow(/application app-1 still exists/);
    await expect(failure).rejects.not.toThrow(/Already revoked|Not yet attempted|Nothing to revoke on/);
    expect(calls.filter((call) => WRITES.test(call))).toEqual(["deleteSitePermission:site-fin:perm-fin"]);
  });

  it("tolerates a revoke that finds the entry already gone, carries on, and never calls it revoked", async () => {
    const { graph, calls } = fakeGraph({
      app: APP,
      permissions: {
        "site-fin": [{ permissionId: "perm-fin", appIds: ["app-1"] }],
        "site-legal": [{ permissionId: "perm-legal", appIds: ["app-1"] }],
      },
      revokeFailsFor: "site-fin",
      revokeFailStatus: 404,
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrls: [FINANCE, LEGAL],
      displayName: NAME,
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toMatchObject({
      kind: "torn-down",
      sites: [
        { siteUrl: FINANCE, permission: "already-gone" },
        { siteUrl: LEGAL, permission: "revoked" },
      ],
      applicationDeleted: true,
    });
    expect(calls.filter((call) => WRITES.test(call))).toEqual([
      "deleteSitePermission:site-fin:perm-fin",
      "deleteSitePermission:site-legal:perm-legal",
      "deleteApplication:obj-1",
      "purgeDeletedApplication:obj-1",
    ]);

    const message = describeDeleteServerAppOutcome(outcome, [FINANCE, LEGAL]);
    expect(message).toContain(`On ${FINANCE} the entry was already gone when this run tried to revoke it.`);
    expect(message).not.toContain(`Revoked its permission entry on ${FINANCE}`);
    expect(message).toContain(`Revoked its permission entry on ${LEGAL}.`);
  });

  it("refuses before any write when two URLs resolve to the same site, naming both as typed", async () => {
    const { graph, calls } = fakeGraph({
      app: APP,
      permissions: { "site-fin": [{ permissionId: "perm-fin", appIds: ["app-1"] }] },
    });
    const sameSite = "https://contoso.sharepoint.com/sites/Fin%61nce";

    const failure = runDeleteServerApp(graph, {
      siteUrls: [FINANCE, sameSite],
      displayName: NAME,
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    await expect(failure).rejects.toThrow(new RegExp(`${FINANCE} and ${sameSite} name the same site`));
    await expect(failure).rejects.toThrow(/nothing was changed/i);
    expect(calls.filter((call) => WRITES.test(call))).toEqual([]);
  });

  it("with --force-orphan, inspects no site and names every site in the residue", async () => {
    const { graph, calls } = fakeGraph({ app: APP, permissions: {} });

    const outcome = await runDeleteServerApp(graph, {
      siteUrls: [FINANCE, LEGAL],
      displayName: NAME,
      confirm: true,
      forceOrphan: true,
      hasGrantIssuer: false,
    });

    expect(outcome).toMatchObject({
      kind: "torn-down",
      orphanedPermission: true,
      sites: [
        { siteUrl: FINANCE, permission: "none" },
        { siteUrl: LEGAL, permission: "none" },
      ],
    });
    expect(calls.some((call) => call.startsWith("listSitePermissions"))).toBe(false);
    expect(calls.filter((call) => WRITES.test(call))).toEqual(["deleteApplication:obj-1", "purgeDeletedApplication:obj-1"]);

    const message = describeDeleteServerAppOutcome(outcome, [FINANCE, LEGAL]);
    expect(message).toContain(`may still remain on each of ${FINANCE} and ${LEGAL}`);
    expect(message).toMatch(/never inspected/);
    expect(message).not.toMatch(/no permission entry on .* was granted to it/i);
  });

  it("with --force-orphan, a dry run says no site was inspected", async () => {
    const { graph } = fakeGraph({ app: APP, permissions: {} });

    const outcome = await runDeleteServerApp(graph, {
      siteUrls: [FINANCE, LEGAL],
      displayName: NAME,
      confirm: false,
      forceOrphan: true,
      hasGrantIssuer: false,
    });

    expect(outcome).toEqual({
      kind: "planned",
      appId: "app-1",
      objectId: "obj-1",
      sites: [
        { siteUrl: FINANCE, permissionId: undefined },
        { siteUrl: LEGAL, permissionId: undefined },
      ],
      permissionsInspected: false,
    });
    const message = describeDeleteServerAppOutcome(outcome, [FINANCE, LEGAL]);
    expect(message).toContain(`The permissions on ${FINANCE} and ${LEGAL} were not inspected`);
    expect(message).not.toMatch(/no permission entry/i);
  });

  it("keeps the single-site wording when only one site is named", async () => {
    const { graph } = fakeGraph({ app: APP, permissions: {} });

    const outcome = await runDeleteServerApp(graph, {
      siteUrls: [FINANCE],
      displayName: NAME,
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });
    const message = describeDeleteServerAppOutcome(outcome, [FINANCE]);

    expect(message).toContain(`No permission entry on ${FINANCE} was granted to it, so none was revoked.`);
    expect(message).toContain("Onboarding this site again");
    expect(message).not.toMatch(/each of|these sites/);
  });

  it("names every site when the application is already absent", () => {
    const message = describeDeleteServerAppOutcome({ kind: "already-absent", displayName: NAME }, [FINANCE, LEGAL]);

    expect(message).toContain(`may still sit on each of ${FINANCE} and ${LEGAL}`);
  });
});
