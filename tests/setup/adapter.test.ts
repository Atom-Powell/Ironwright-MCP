import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchSetupGraph } from "../../src/setup/adapter.js";
import { buildAppRegistrationRequest, buildAppRoleAssignmentRequest, buildSitePermissionRequest } from "../../src/setup/steps.js";

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
  createFetchSetupGraph("admin-token", async () => appToken);

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

  it("adds a client secret to the application object", async () => {
    const calls = stubFetch([{ status: 200, body: JSON.stringify({ secretText: "secret-1" }) }]);

    const result = await graph().addPassword("object-1");

    expect(result).toEqual({ secretText: "secret-1" });
    expect(calls[0]?.url).toBe("https://graph.microsoft.com/v1.0/applications/object-1/addPassword");
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
  });
});
