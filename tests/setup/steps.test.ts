import { describe, expect, it } from "vitest";
import {
  MICROSOFT_GRAPH_APP_ID,
  SITES_SELECTED_APP_ROLE_ID,
  appRolesFromAccessToken,
  buildAppRegistrationRequest,
  buildAppRoleAssignmentRequest,
  buildSitePermissionRequest,
  interpretVerification,
  siteIdPathFromUrl,
} from "../../src/setup/steps.js";

function fakeAccessToken(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `header.${encoded}.signature`;
}

describe("buildAppRegistrationRequest", () => {
  it("requests a single-tenant confidential client holding the Sites.Selected application permission", () => {
    expect(buildAppRegistrationRequest("Ironwright Reconciliation")).toEqual({
      displayName: "Ironwright Reconciliation",
      signInAudience: "AzureADMyOrg",
      requiredResourceAccess: [
        {
          resourceAppId: MICROSOFT_GRAPH_APP_ID,
          resourceAccess: [{ id: SITES_SELECTED_APP_ROLE_ID, type: "Role" }],
        },
      ],
    });
  });
});

describe("buildAppRoleAssignmentRequest", () => {
  it("assigns the Sites.Selected app role from the new service principal to Microsoft Graph", () => {
    expect(buildAppRoleAssignmentRequest({ principalId: "sp-1", resourceId: "graph-sp-1" })).toEqual({
      principalId: "sp-1",
      resourceId: "graph-sp-1",
      appRoleId: SITES_SELECTED_APP_ROLE_ID,
    });
  });
});

describe("buildSitePermissionRequest", () => {
  it("grants write access to one application identity", () => {
    expect(
      buildSitePermissionRequest({
        appId: "11111111-1111-1111-1111-111111111111",
        appDisplayName: "App",
        write: true,
      }),
    ).toEqual({
      roles: ["write"],
      grantedToIdentities: [{ application: { id: "11111111-1111-1111-1111-111111111111", displayName: "App" } }],
    });
  });

  it("grants read access when write is not requested", () => {
    const request = buildSitePermissionRequest({ appId: "abc", appDisplayName: "App", write: false });
    expect(request.roles).toEqual(["read"]);
  });
});

describe("siteIdPathFromUrl", () => {
  it("converts a site URL into the Graph host and server-relative path form", () => {
    expect(siteIdPathFromUrl("https://contoso.sharepoint.com/sites/Example")).toBe(
      "contoso.sharepoint.com:/sites/Example",
    );
  });

  it("drops a trailing slash", () => {
    expect(siteIdPathFromUrl("https://contoso.sharepoint.com/sites/Example/")).toBe(
      "contoso.sharepoint.com:/sites/Example",
    );
  });

  it("addresses the root site with a bare host and no trailing colon", () => {
    expect(siteIdPathFromUrl("https://contoso.sharepoint.com")).toBe("contoso.sharepoint.com");
  });

  it("addresses the root site from a trailing-slash root URL", () => {
    expect(siteIdPathFromUrl("https://contoso.sharepoint.com/")).toBe("contoso.sharepoint.com");
  });

  it("ignores a query string", () => {
    expect(siteIdPathFromUrl("https://contoso.sharepoint.com/sites/Example?foo=bar")).toBe(
      "contoso.sharepoint.com:/sites/Example",
    );
  });

  it("ignores a fragment", () => {
    expect(siteIdPathFromUrl("https://contoso.sharepoint.com/sites/Example#section")).toBe(
      "contoso.sharepoint.com:/sites/Example",
    );
  });

  it("lowercases a mixed-case host", () => {
    expect(siteIdPathFromUrl("https://CONTOSO.SharePoint.com/sites/Example")).toBe(
      "contoso.sharepoint.com:/sites/Example",
    );
  });
});

describe("appRolesFromAccessToken", () => {
  it("reads the roles claim out of an application token", () => {
    expect(appRolesFromAccessToken(fakeAccessToken({ roles: ["Sites.Selected"] }))).toEqual(["Sites.Selected"]);
  });

  it("reports no roles for a token whose payload carries no roles claim", () => {
    expect(appRolesFromAccessToken(fakeAccessToken({ aud: "https://graph.microsoft.com" }))).toEqual([]);
  });
});

describe("interpretVerification", () => {
  it("treats 200 as success", () => {
    expect(interpretVerification(200, "{}", { sitesSelectedRolePresent: true })).toEqual({ ok: true });
  });
});
