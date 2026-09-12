import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { SetupFailedError, runSetup } from "../../src/setup/run.js";
import { SITES_SELECTED_ROLE_CLAIM } from "../../src/setup/steps.js";

interface Fake {
  graph: SetupGraph;
  calls: string[];
  notices: string[];
}

function fakeGraph(overrides: Partial<SetupGraph> = {}): Fake {
  const calls: string[] = [];
  const graph: SetupGraph = {
    resolveSite: async () => ({ siteId: "site-1" }),
    createApplication: async () => {
      calls.push("createApplication");
      return { objectId: "object-1", appId: "app-1" };
    },
    addPassword: async () => ({ secretText: "secret-1" }),
    createServicePrincipal: async () => ({ objectId: "sp-1" }),
    resolveServicePrincipal: async () => ({ objectId: "graph-sp-1" }),
    grantAppRole: async () => {},
    grantSitePermission: async () => ({ permissionId: "permission-1" }),
    verifyAppAccess: async () => ({ status: 200, body: "{}", appRoles: [SITES_SELECTED_ROLE_CLAIM] }),
    deleteSitePermission: async (siteId, permissionId) => {
      calls.push(`deleteSitePermission:${siteId}:${permissionId}`);
    },
    deleteApplication: async (objectId) => {
      calls.push(`deleteApplication:${objectId}`);
    },
    ...overrides,
  };
  return { graph, calls, notices: [] };
}

function run(fake: Fake): Promise<unknown> {
  return runSetup(
    fake.graph,
    { displayName: "App", siteUrl: "https://contoso.sharepoint.com/sites/Example", write: true },
    { onNotice: (message) => fake.notices.push(message) },
  );
}

describe("runSetup verification diagnostics", () => {
  it("blames the unconsented application permission when the app token carries no roles", async () => {
    const fake = fakeGraph({ verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [] }) });

    await expect(run(fake)).rejects.toThrow(SetupFailedError);
    await expect(run(fake)).rejects.toThrow(/admin consent/i);
  });

  it("does not tell the operator to re-run a command that creates a second registration", async () => {
    const fake = fakeGraph({ verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [] }) });

    await expect(run(fake)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("Re-run") }) as Error,
    );
  });

  it("blames the per-site grant only when the application permission is demonstrably consented", async () => {
    const fake = fakeGraph({
      verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [SITES_SELECTED_ROLE_CLAIM] }),
    });

    await expect(run(fake)).rejects.toThrow(/\/sites\/\{site-id\}\/permissions/);
  });

  it("surfaces a credential problem separately from a permission problem", async () => {
    const fake = fakeGraph({ verifyAppAccess: async () => ({ status: 401, body: "", appRoles: undefined }) });

    await expect(run(fake)).rejects.toThrow(/client secret/);
  });

  it("does not swallow a failure from the grant call itself", async () => {
    const fake = fakeGraph({
      grantSitePermission: async () => {
        throw new Error("Graph POST /sites/site-1/permissions failed with 403: accessDenied");
      },
    });

    await expect(run(fake)).rejects.toThrow(/permissions failed with 403/);
  });
});

describe("runSetup rollback", () => {
  it("removes the site permission and the credentialed registration when verification fails", async () => {
    const fake = fakeGraph({ verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [] }) });

    await expect(run(fake)).rejects.toThrow(SetupFailedError);
    expect(fake.calls).toEqual([
      "createApplication",
      "deleteSitePermission:site-1:permission-1",
      "deleteApplication:object-1",
    ]);
  });

  it("removes the registration without inventing a site permission that was never granted", async () => {
    const fake = fakeGraph({
      grantAppRole: async () => {
        throw new Error("Graph POST appRoleAssignedTo failed with 403: Authorization_RequestDenied");
      },
    });

    await expect(run(fake)).rejects.toThrow(/Authorization_RequestDenied/);
    expect(fake.calls).toEqual(["createApplication", "deleteApplication:object-1"]);
  });

  it("attempts no rollback when nothing was created yet", async () => {
    const fake = fakeGraph({
      resolveSite: async () => {
        throw new Error("Graph GET /sites/contoso.sharepoint.com:/sites/Example failed with 404: itemNotFound");
      },
    });

    await expect(run(fake)).rejects.toThrow(/itemNotFound/);
    expect(fake.calls).toEqual([]);
  });

  it("reports the registration for manual deletion when rollback itself fails, without masking the cause", async () => {
    const fake = fakeGraph({
      verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [] }),
      deleteApplication: async () => {
        throw new Error("Graph DELETE /applications/object-1 failed with 403: Authorization_RequestDenied");
      },
    });

    await expect(run(fake)).rejects.toThrow(SetupFailedError);
    expect(fake.notices.join("\n")).toContain("app-1");
    expect(fake.notices.join("\n")).toMatch(/delete it manually/i);
  });

  it("confirms the rollback when it succeeds, so no credential is assumed to be loose", async () => {
    const fake = fakeGraph({ verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [] }) });

    await expect(run(fake)).rejects.toThrow(SetupFailedError);
    expect(fake.notices.join("\n")).toMatch(/rolled back/i);
  });
});
