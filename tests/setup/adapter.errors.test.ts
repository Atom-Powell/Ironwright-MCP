import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchSetupGraph } from "../../src/setup/adapter.js";
import { GraphRequestError } from "../../src/setup/graph-error.js";
import { buildAppRegistrationRequest, buildServerPasswordCredential } from "../../src/setup/steps.js";

function stubFetch(response: { status: number; body: string }): void {
  // A 204 is defined as having no body, and the Response constructor rejects one
  // that does, so the stub has to model that rather than send "".
  vi.stubGlobal("fetch", async () => new Response(response.status === 204 ? null : response.body, { status: response.status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const graph = (): ReturnType<typeof createFetchSetupGraph> =>
  createFetchSetupGraph({
    adminToken: "admin-token",
    acquireAppToken: async () => "app-token",
    acquireBootstrapToken: async () => "bootstrap-token",
  });

describe("Graph failures", () => {
  it("carries the status and the Graph error code, not just the text", async () => {
    stubFetch({ status: 403, body: '{"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges."}}' });

    await expect(graph().createApplication(buildAppRegistrationRequest("App", "role-selected"))).rejects.toThrow(GraphRequestError);
    await expect(graph().createApplication(buildAppRegistrationRequest("App", "role-selected"))).rejects.toMatchObject({
      status: 403,
      code: "Authorization_RequestDenied",
      method: "POST",
      path: "/applications",
    });
  });

  it("still reports a failure whose body is not JSON at all", async () => {
    stubFetch({ status: 502, body: "<html>gateway</html>" });

    await expect(graph().resolveSite("contoso.sharepoint.com")).rejects.toMatchObject({
      status: 502,
      code: undefined,
    });
  });
});

describe("unexpected success shapes", () => {
  // A 2xx of the wrong shape used to yield undefined for appId or secretText,
  // which then interpolated as the literal text "undefined" into a later Graph
  // path and failed several calls downstream of the real cause.
  it("names the missing field when a created application has no appId", async () => {
    stubFetch({ status: 201, body: JSON.stringify({ id: "object-1" }) });

    await expect(graph().createApplication(buildAppRegistrationRequest("App", "role-selected"))).rejects.toThrow(/"appId"/);
  });

  it("names the missing field when a 2xx carries no body at all", async () => {
    stubFetch({ status: 200, body: "" });

    await expect(graph().addPassword("object-1", buildServerPasswordCredential())).rejects.toThrow(/"secretText"/);
  });

  it("rejects an empty string as a usable id", async () => {
    stubFetch({ status: 201, body: JSON.stringify({ id: "" }) });

    await expect(graph().createServicePrincipal("app-1")).rejects.toThrow(/"id"/);
  });

  it("rejects a permission response with no id, since a failed run could not then remove it", async () => {
    stubFetch({ status: 201, body: JSON.stringify({ roles: ["write"] }) });

    await expect(
      graph().grantSitePermission("site-1", { roles: ["write"], grantedToIdentities: [] }),
    ).rejects.toThrow(/"id"/);
  });

  it("says something other than Graph answered when a 2xx body is not JSON", async () => {
    stubFetch({ status: 200, body: "<html>sign in</html>" });

    await expect(graph().resolveSite("contoso.sharepoint.com")).rejects.toThrow(/not JSON/);
  });

  it("accepts a 2xx with no body for a call that promises no fields", async () => {
    stubFetch({ status: 204, body: "" });

    await expect(graph().deleteApplication("object-1")).resolves.toBeUndefined();
  });
});

describe("findApplicationByDisplayName ambiguous match", () => {
  // displayName is not unique in Entra. Silently returning the first match
  // would tell a caller on the delete path that one application was removed
  // while an identically named one remains, and a second run would then
  // delete that one too.
  it("refuses rather than silently picking the first of several matches", async () => {
    stubFetch({
      status: 200,
      body: JSON.stringify({
        value: [
          { id: "object-1", appId: "app-1" },
          { id: "object-2", appId: "app-2" },
        ],
      }),
    });

    await expect(graph().findApplicationByDisplayName("Ironwright Grant Issuer")).rejects.toThrow(
      /Found 2 applications named "Ironwright Grant Issuer"/,
    );
  });

  it("tells the operator how to disambiguate", async () => {
    stubFetch({
      status: 200,
      body: JSON.stringify({
        value: [
          { id: "object-1", appId: "app-1" },
          { id: "object-2", appId: "app-2" },
        ],
      }),
    });

    await expect(graph().findApplicationByDisplayName("Ironwright Grant Issuer")).rejects.toThrow(/--name/);
  });
});
