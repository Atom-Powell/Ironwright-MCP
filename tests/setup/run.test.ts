import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { runSetup } from "../../src/setup/run.js";
import type { AppRegistrationRequest } from "../../src/setup/steps.js";
import { MICROSOFT_GRAPH_APP_ID, SITES_SELECTED_ROLE_CLAIM } from "../../src/setup/steps.js";

const SITES_SELECTED_ROLE_ID = "role-selected";

function fakeGraph(overrides: Partial<SetupGraph> = {}): { graph: SetupGraph; calls: string[] } {
  const calls: string[] = [];
  const graph: SetupGraph = {
    resolveSite: async (sitePath) => {
      calls.push(`resolveSite:${sitePath}`);
      return { siteId: "site-1" };
    },
    createApplication: async (request) => {
      calls.push(`createApplication:${request.displayName}`);
      return { objectId: "object-1", appId: "app-1" };
    },
    addPassword: async (objectId, credential) => {
      calls.push(`addPassword:${objectId}:${credential.displayName}:${credential.endDateTime ?? "no-expiry"}`);
      return { secretText: "secret-1" };
    },
    createServicePrincipal: async (appId) => {
      calls.push(`createServicePrincipal:${appId}`);
      return { objectId: "sp-1" };
    },
    resolveServicePrincipal: async (appId) => {
      calls.push(`resolveServicePrincipal:${appId}`);
      return { objectId: "graph-sp-1", appRoles: [{ id: SITES_SELECTED_ROLE_ID, value: SITES_SELECTED_ROLE_CLAIM }] };
    },
    grantAppRole: async (request) => {
      calls.push(`grantAppRole:${request.principalId}:${request.resourceId}:${request.appRoleId}`);
    },
    grantSitePermission: async (siteId, request) => {
      calls.push(`grantSitePermission:${siteId}:${request.roles.join(",")}`);
      return { permissionId: "permission-1" };
    },
    verifyAppAccess: async () => {
      calls.push("verifyAppAccess");
      return { status: 200, body: "{}", appRoles: [SITES_SELECTED_ROLE_CLAIM] };
    },
    deleteSitePermission: async (siteId, permissionId) => {
      calls.push(`deleteSitePermission:${siteId}:${permissionId}`);
    },
    deleteApplication: async (objectId) => {
      calls.push(`deleteApplication:${objectId}`);
    },
    ...overrides,
  };
  return { graph, calls };
}

const args = {
  displayName: "Ironwright Reconciliation",
  siteUrl: "https://contoso.sharepoint.com/sites/Example",
  write: true,
};

describe("runSetup", () => {
  it("resolves the site, resolves Graph's service principal, registers, consents, grants, then verifies, in that order", async () => {
    const { graph, calls } = fakeGraph();

    const result = await runSetup(graph, args);

    expect(calls).toEqual([
      "resolveSite:contoso.sharepoint.com:/sites/Example",
      `resolveServicePrincipal:${MICROSOFT_GRAPH_APP_ID}`,
      "createApplication:Ironwright Reconciliation",
      "addPassword:object-1:ironwright-mcp-server:no-expiry",
      "createServicePrincipal:app-1",
      `grantAppRole:sp-1:graph-sp-1:${SITES_SELECTED_ROLE_ID}`,
      "grantSitePermission:site-1:write",
      "verifyAppAccess",
    ]);
    expect(result).toEqual({
      appId: "app-1",
      objectId: "object-1",
      secret: "secret-1",
      siteId: "site-1",
      verification: { confirmed: true },
    });
  });

  it("requests the Sites.Selected application permission on the registration itself, using the looked-up id", async () => {
    let request: AppRegistrationRequest | undefined;
    const { graph } = fakeGraph({
      createApplication: async (received) => {
        request = received;
        return { objectId: "object-1", appId: "app-1" };
      },
    });

    await runSetup(graph, args);

    expect(request?.requiredResourceAccess).toEqual([
      {
        resourceAppId: MICROSOFT_GRAPH_APP_ID,
        // The fake's resolveServicePrincipal reports this id for Sites.Selected;
        // no GUID is hardcoded in production code for this call any more.
        resourceAccess: [{ id: SITES_SELECTED_ROLE_ID, type: "Role" }],
      },
    ]);
  });

  it("requests read-only access when write is false", async () => {
    const { graph, calls } = fakeGraph();

    await runSetup(graph, { ...args, write: false });

    expect(calls).toContain("grantSitePermission:site-1:read");
  });

  it("rolls nothing back on a successful run", async () => {
    const { graph, calls } = fakeGraph();

    await runSetup(graph, args);

    expect(calls.some((call) => call.startsWith("delete"))).toBe(false);
  });
});

describe("the server application's client secret", () => {
  it("is labeled for the server and keeps Graph's own lifetime", async () => {
    const { graph, calls } = fakeGraph();

    await runSetup(graph, args);

    // Distinct from the grant issuer's label, so the two credentials are
    // told apart in the portal, and deliberately not shortened: this is what
    // the deployed container authenticates with.
    expect(calls).toContain("addPassword:object-1:ironwright-mcp-server:no-expiry");
  });
});

