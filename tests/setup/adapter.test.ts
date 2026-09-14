import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchSetupGraph } from "../../src/setup/adapter.js";
import {
  buildAppRegistrationRequest,
  buildAppRoleAssignmentRequest,
  buildServerPasswordCredential,
  buildSitePermissionRequest,
} from "../../src/setup/steps.js";

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
}

function stubFetch(responses: { status: number; body: string }[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let index = 0;

  vi.stubGlobal("fetch", async (url: string, init: RequestInit | undefined) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.authorization,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error(`unexpected fetch call to ${url}`);
    // A 204 is defined as having no body, and the Response constructor rejects
    // one that does, so the stub has to model that rather than send "".
    return new Response(next.status === 204 ? null : next.body, { status: next.status });
  });

  return calls;
}

function appTokenWithRoles(roles: string[]): string {
  const payload = Buffer.from(JSON.stringify({ roles }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const graph = (appToken = appTokenWithRoles(["Sites.Selected"])): ReturnType<typeof createFetchSetupGraph> =>
  createFetchSetupGraph({
    adminToken: "admin-token",
    acquireAppToken: async () => appToken,
    acquireBootstrapToken: async () => "bootstrap-token",
  });

describe("createFetchSetupGraph", () => {
  it("resolves a site by its path form", async () => {
    const calls = stubFetch([{ status: 200, body: JSON.stringify({ id: "site-1" }) }]);

    const result = await graph().resolveSite("contoso.sharepoint.com:/sites/Example");

    expect(result).toEqual({ siteId: "site-1" });
    expect(calls[0]).toMatchObject({
      url: "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/Example",
      method: "GET",
      authorization: "Bearer admin-token",
    });
  });

  it("creates the application with the requested app role", async () => {
    const calls = stubFetch([{ status: 201, body: JSON.stringify({ id: "object-1", appId: "app-1" }) }]);

    const result = await graph().createApplication(buildAppRegistrationRequest("App", "role-selected"));

    expect(result).toEqual({ objectId: "object-1", appId: "app-1" });
    expect(calls[0]).toMatchObject({ url: "https://graph.microsoft.com/v1.0/applications", method: "POST" });
    expect(calls[0]?.body).toMatchObject({ displayName: "App", signInAudience: "AzureADMyOrg" });
  });

  it("adds a client secret to the application object, with the label and expiry it was given", async () => {
    const calls = stubFetch([{ status: 200, body: JSON.stringify({ secretText: "secret-1" }) }]);

    const result = await graph().addPassword("object-1", {
      displayName: "ironwright-grant-issuer",
      endDateTime: "2026-09-19T09:30:00.000Z",
    });

    expect(result).toEqual({ secretText: "secret-1" });
    expect(calls[0]?.url).toBe("https://graph.microsoft.com/v1.0/applications/object-1/addPassword");
    expect(calls[0]?.body).toEqual({
      passwordCredential: { displayName: "ironwright-grant-issuer", endDateTime: "2026-09-19T09:30:00.000Z" },
    });
  });

  it("sends no expiry for a credential that was given none", async () => {
    const calls = stubFetch([{ status: 200, body: JSON.stringify({ secretText: "secret-1" }) }]);

    await graph().addPassword("object-1", { displayName: "ironwright-mcp-server" });

    expect(calls[0]?.body).toEqual({ passwordCredential: { displayName: "ironwright-mcp-server" } });
  });

  it("finds an existing application by display name", async () => {
    const calls = stubFetch([
      { status: 200, body: JSON.stringify({ value: [{ id: "object-1", appId: "app-1" }] }) },
    ]);

    const result = await graph().findApplicationByDisplayName("Ironwright Grant Issuer");

    expect(result).toEqual({ objectId: "object-1", appId: "app-1" });
    expect(calls[0]?.url).toBe(
      "https://graph.microsoft.com/v1.0/applications?$filter=displayName%20eq%20'Ironwright%20Grant%20Issuer'&$select=id,appId",
    );
    expect(calls[0]?.authorization).toBe("Bearer admin-token");
  });

  it("reports no match rather than throwing when the display name is unused", async () => {
    stubFetch([{ status: 200, body: JSON.stringify({ value: [] }) }]);

    await expect(graph().findApplicationByDisplayName("Nothing Named This")).resolves.toBeUndefined();
  });

  it("doubles a quote in the display name rather than letting it break the filter", async () => {
    const calls = stubFetch([{ status: 200, body: JSON.stringify({ value: [] }) }]);

    await graph().findApplicationByDisplayName("O'Brien");

    // A single quote is OData's string delimiter, so it has to be doubled or
    // the filter is a syntax error rather than a lookup.
    expect(calls[0]?.url).toContain("displayName%20eq%20'O''Brien'");
  });

  it("creates the service principal the token endpoint resolves the client id against", async () => {
    const calls = stubFetch([{ status: 201, body: JSON.stringify({ id: "sp-1" }) }]);

    const result = await graph().createServicePrincipal("app-1");

    expect(result).toEqual({ objectId: "sp-1" });
    expect(calls[0]).toMatchObject({ url: "https://graph.microsoft.com/v1.0/servicePrincipals", method: "POST" });
    expect(calls[0]?.body).toEqual({ appId: "app-1" });
  });

  it("resolves a service principal by application id, along with its app roles", async () => {
    const calls = stubFetch([
      {
        status: 200,
        body: JSON.stringify({
          id: "graph-sp-1",
          appRoles: [{ id: "role-selected", value: "Sites.Selected" }],
        }),
      },
    ]);

    const result = await graph().resolveServicePrincipal("00000003-0000-0000-c000-000000000000");

    expect(result).toEqual({
      objectId: "graph-sp-1",
      appRoles: [{ id: "role-selected", value: "Sites.Selected" }],
    });
    expect(calls[0]?.url).toBe(
      "https://graph.microsoft.com/v1.0/servicePrincipals(appId='00000003-0000-0000-c000-000000000000')?$select=id,appRoles",
    );
  });

  it("returns an empty app role list when the service principal response carries none", async () => {
    stubFetch([{ status: 200, body: JSON.stringify({ id: "graph-sp-1" }) }]);

    const result = await graph().resolveServicePrincipal("00000003-0000-0000-c000-000000000000");

    expect(result).toEqual({ objectId: "graph-sp-1", appRoles: [] });
  });

  it("assigns the app role on the resource service principal, which is the admin consent step", async () => {
    const calls = stubFetch([{ status: 201, body: JSON.stringify({ id: "assignment-1" }) }]);
    const request = buildAppRoleAssignmentRequest({
      principalId: "sp-1",
      resourceId: "graph-sp-1",
      appRoleId: "role-selected",
    });

    await graph().grantAppRole(request);

    expect(calls[0]).toMatchObject({
      url: "https://graph.microsoft.com/v1.0/servicePrincipals/graph-sp-1/appRoleAssignedTo",
      method: "POST",
    });
    expect(calls[0]?.body).toEqual(request);
  });

  it("returns the id of the site permission it granted, so a failed run can remove it", async () => {
    const calls = stubFetch([{ status: 201, body: JSON.stringify({ id: "permission-1" }) }]);

    const result = await graph().grantSitePermission(
      "site-1",
      buildSitePermissionRequest({ appId: "app-1", appDisplayName: "App", write: true }),
    );

    expect(result).toEqual({ permissionId: "permission-1" });
    expect(calls[0]?.url).toBe("https://graph.microsoft.com/v1.0/sites/site-1/permissions");
    expect(calls[0]?.authorization).toBe("Bearer bootstrap-token");
  });

  it("verifies with a token minted for the new app and reports that token's roles", async () => {
    const calls = stubFetch([{ status: 200, body: '{"id":"drive-1"}' }]);

    const result = await graph().verifyAppAccess({ appId: "app-1", secret: "secret-1", siteId: "site-1" });

    expect(result).toEqual({ status: 200, body: '{"id":"drive-1"}', appRoles: ["Sites.Selected"] });
    expect(calls[0]).toMatchObject({
      url: "https://graph.microsoft.com/v1.0/sites/site-1/drive",
      authorization: `Bearer ${appTokenWithRoles(["Sites.Selected"])}`,
    });
  });

  it("reports no roles when the application token carries none", async () => {
    stubFetch([{ status: 403, body: '{"error":{"code":"accessDenied"}}' }]);

    const result = await graph(appTokenWithRoles([])).verifyAppAccess({
      appId: "app-1",
      secret: "secret-1",
      siteId: "site-1",
    });

    expect(result.appRoles).toEqual([]);
    expect(result.status).toBe(403);
  });

  it("deletes a site permission and an application by id", async () => {
    const calls = stubFetch([
      { status: 204, body: "" },
      { status: 204, body: "" },
    ]);

    await graph().deleteSitePermission("site-1", "permission-1");
    await graph().deleteApplication("object-1");

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "DELETE https://graph.microsoft.com/v1.0/sites/site-1/permissions/permission-1",
      "DELETE https://graph.microsoft.com/v1.0/applications/object-1",
    ]);
    expect(calls[0]?.authorization).toBe("Bearer bootstrap-token");
    expect(calls[1]?.authorization).toBe("Bearer admin-token");
  });

  it("lists a site's permissions with the application ids inside each grant", async () => {
    const calls = stubFetch([
      {
        status: 200,
        body: JSON.stringify({
          value: [
            {
              id: "perm-1",
              grantedToIdentitiesV2: [{ application: { id: "app-a", displayName: "A" } }],
            },
            {
              id: "perm-2",
              grantedToIdentitiesV2: [
                { application: { id: "app-b", displayName: "B" } },
                { application: { id: "app-c", displayName: "C" } },
              ],
            },
          ],
        }),
      },
    ]);

    const result = await graph().listSitePermissions("site-1");

    expect(result).toEqual([
      { permissionId: "perm-1", appIds: ["app-a"] },
      { permissionId: "perm-2", appIds: ["app-b", "app-c"] },
    ]);
    expect(calls[0]?.url).toBe("https://graph.microsoft.com/v1.0/sites/site-1/permissions");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.authorization).toBe("Bearer bootstrap-token");
  });

  it("reads an entry that carries no granted identities as granting to nobody", async () => {
    stubFetch([{ status: 200, body: JSON.stringify({ value: [{ id: "perm-1" }] }) }]);

    await expect(graph().listSitePermissions("site-1")).resolves.toEqual([
      { permissionId: "perm-1", appIds: [] },
    ]);
  });

  it("falls back to the deprecated grantedToIdentities field when a response carries no V2 identities", async () => {
    // grantSitePermission's own request body is written in this deprecated
    // shape (steps.ts's SitePermissionRequest), so a response that echoes back
    // what was sent, rather than Graph's newer grantedToIdentitiesV2 shape, is
    // a real possibility, not a hypothetical one.
    stubFetch([
      {
        status: 200,
        body: JSON.stringify({
          value: [{ id: "perm-1", grantedToIdentities: [{ application: { id: "app-a", displayName: "A" } }] }],
        }),
      },
    ]);

    await expect(graph().listSitePermissions("site-1")).resolves.toEqual([
      { permissionId: "perm-1", appIds: ["app-a"] },
    ]);
  });

  it("skips an entry with no usable id rather than refusing the whole listing", async () => {
    stubFetch([
      {
        status: 200,
        body: JSON.stringify({
          value: [
            { grantedToIdentitiesV2: [{ application: { id: "app-a", displayName: "A" } }] },
            { id: "perm-2", grantedToIdentitiesV2: [{ application: { id: "app-b", displayName: "B" } }] },
          ],
        }),
      },
    ]);

    await expect(graph().listSitePermissions("site-1")).resolves.toEqual([
      { permissionId: "perm-2", appIds: ["app-b"] },
    ]);
  });

  it("purges a deleted application from the tenant's deleted items", async () => {
    const calls = stubFetch([{ status: 204, body: "" }]);

    await expect(graph().purgeDeletedApplication("object-1")).resolves.toBeUndefined();

    expect(calls[0]).toMatchObject({
      url: "https://graph.microsoft.com/v1.0/directory/deletedItems/object-1",
      method: "DELETE",
      authorization: "Bearer admin-token",
    });
  });
});

describe("token routing", () => {
  it("uses the bootstrap token for the per-site grant and the admin token elsewhere", async () => {
    const calls = stubFetch([
      { status: 200, body: JSON.stringify({ id: "site-1" }) },
      { status: 201, body: JSON.stringify({ id: "permission-1" }) },
    ]);

    const graph = createFetchSetupGraph({
      adminToken: "ADMIN",
      acquireAppToken: async () => "APP",
      acquireBootstrapToken: async () => "BOOTSTRAP",
    });

    await graph.resolveSite("host:/sites/X");
    await graph.grantSitePermission("site-1", { roles: ["read"], grantedToIdentities: [] });

    expect(calls[0]?.authorization).toBe("Bearer ADMIN");
    expect(calls[1]?.url).toContain("/sites/site-1/permissions");
    expect(calls[1]?.authorization).toBe("Bearer BOOTSTRAP");
  });

  // Table-driven over every SetupGraph method, not just the two exercised
  // above: five of them (createApplication, addPassword,
  // createServicePrincipal, resolveServicePrincipal, grantAppRole) had no
  // authorization assertion at all, so misrouting one to the bootstrap or app
  // token would have passed the suite. This closes that gap for the current
  // ten methods and for any added later.
  const ADMIN = "ADMIN-TOKEN";
  const BOOTSTRAP = "BOOTSTRAP-TOKEN";
  const APP = "APP-TOKEN";

  function tokenRoutingGraph(): ReturnType<typeof createFetchSetupGraph> {
    return createFetchSetupGraph({
      adminToken: ADMIN,
      acquireAppToken: async () => APP,
      acquireBootstrapToken: async () => BOOTSTRAP,
    });
  }

  const authorizationCases: {
    name: string;
    token: string;
    status: number;
    body: string;
    call: (graph: ReturnType<typeof createFetchSetupGraph>) => Promise<unknown>;
  }[] = [
    {
      name: "resolveSite",
      token: ADMIN,
      status: 200,
      body: JSON.stringify({ id: "site-1" }),
      call: (g) => g.resolveSite("host:/sites/x"),
    },
    {
      name: "createApplication",
      token: ADMIN,
      status: 201,
      body: JSON.stringify({ id: "object-1", appId: "app-1" }),
      call: (g) => g.createApplication(buildAppRegistrationRequest("App", "role-1")),
    },
    {
      name: "addPassword",
      token: ADMIN,
      status: 200,
      body: JSON.stringify({ secretText: "secret-1" }),
      call: (g) => g.addPassword("object-1", buildServerPasswordCredential()),
    },
    {
      name: "createServicePrincipal",
      token: ADMIN,
      status: 201,
      body: JSON.stringify({ id: "sp-1" }),
      call: (g) => g.createServicePrincipal("app-1"),
    },
    {
      name: "resolveServicePrincipal",
      token: ADMIN,
      status: 200,
      body: JSON.stringify({ id: "graph-sp-1", appRoles: [] }),
      call: (g) => g.resolveServicePrincipal("00000003-0000-0000-c000-000000000000"),
    },
    {
      name: "grantAppRole",
      token: ADMIN,
      status: 201,
      body: "{}",
      call: (g) =>
        g.grantAppRole(
          buildAppRoleAssignmentRequest({ principalId: "sp-1", resourceId: "graph-sp-1", appRoleId: "role-1" }),
        ),
    },
    {
      name: "grantSitePermission",
      token: BOOTSTRAP,
      status: 201,
      body: JSON.stringify({ id: "permission-1" }),
      call: (g) =>
        g.grantSitePermission("site-1", buildSitePermissionRequest({ appId: "app-1", appDisplayName: "App", write: true })),
    },
    {
      name: "verifyAppAccess",
      token: APP,
      status: 200,
      body: '{"id":"drive-1"}',
      call: (g) => g.verifyAppAccess({ appId: "app-1", secret: "secret-1", siteId: "site-1" }),
    },
    {
      name: "deleteSitePermission",
      token: BOOTSTRAP,
      status: 204,
      body: "",
      call: (g) => g.deleteSitePermission("site-1", "permission-1"),
    },
    {
      name: "deleteApplication",
      token: ADMIN,
      status: 204,
      body: "",
      call: (g) => g.deleteApplication("object-1"),
    },
    {
      name: "listSitePermissions",
      token: BOOTSTRAP,
      status: 200,
      body: JSON.stringify({ value: [] }),
      call: (g) => g.listSitePermissions("site-1"),
    },
    {
      name: "purgeDeletedApplication",
      token: ADMIN,
      status: 204,
      body: "",
      call: (g) => g.purgeDeletedApplication("object-1"),
    },
  ];

  it.each(authorizationCases)("uses the expected token for $name", async ({ token, status, body, call }) => {
    const calls = stubFetch([{ status, body }]);

    await call(tokenRoutingGraph());

    expect(calls[0]?.authorization).toBe(`Bearer ${token}`);
  });
});
