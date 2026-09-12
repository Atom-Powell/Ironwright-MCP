import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_SECRET_LIFETIME_DAYS,
  MICROSOFT_GRAPH_APP_ID,
  appRoleIdByValue,
  appRolesFromAccessToken,
  buildAppRegistrationRequest,
  buildAppRoleAssignmentRequest,
  buildBootstrapPasswordCredential,
  buildServerPasswordCredential,
  buildSitePermissionRequest,
  interpretVerification,
  siteIdPathFromUrl,
  SITES_FULL_CONTROL_ROLE_CLAIM,
} from "../../src/setup/steps.js";

function fakeAccessToken(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `header.${encoded}.signature`;
}

describe("buildAppRegistrationRequest", () => {
  it("requests a single-tenant confidential client holding the given app role", () => {
    expect(buildAppRegistrationRequest("Ironwright Reconciliation", "role-selected")).toEqual({
      displayName: "Ironwright Reconciliation",
      signInAudience: "AzureADMyOrg",
      requiredResourceAccess: [
        {
          resourceAppId: MICROSOFT_GRAPH_APP_ID,
          resourceAccess: [{ id: "role-selected", type: "Role" }],
        },
      ],
    });
  });
});

describe("buildAppRoleAssignmentRequest", () => {
  it("assigns the given app role from the new service principal to Microsoft Graph", () => {
    expect(
      buildAppRoleAssignmentRequest({ principalId: "sp-1", resourceId: "graph-sp-1", appRoleId: "role-selected" }),
    ).toEqual({
      principalId: "sp-1",
      resourceId: "graph-sp-1",
      appRoleId: "role-selected",
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

describe("appRoleIdByValue", () => {
  const roles = [
    { id: "role-selected", value: "Sites.Selected" },
    { id: "role-full", value: "Sites.FullControl.All" },
  ];

  it("finds a role id by its value", () => {
    expect(appRoleIdByValue(roles, "Sites.Selected")).toBe("role-selected");
  });

  it("finds the full control role", () => {
    expect(appRoleIdByValue(roles, SITES_FULL_CONTROL_ROLE_CLAIM)).toBe("role-full");
  });
});

describe("password credentials", () => {
  it("labels the server application's secret for the server, with no expiry of its own", () => {
    const credential = buildServerPasswordCredential();

    expect(credential.displayName).toBe("ironwright-mcp-server");
    expect(credential.endDateTime).toBeUndefined();
  });

  it("labels the grant issuer's secret separately, so the two are distinguishable in the portal", () => {
    const credential = buildBootstrapPasswordCredential(new Date("2026-09-12T00:00:00.000Z"));

    expect(credential.displayName).toBe("ironwright-grant-issuer");
    expect(credential.displayName).not.toBe(buildServerPasswordCredential().displayName);
  });

  it("expires the grant issuer's secret a week out rather than accepting Graph's two-year default", () => {
    const credential = buildBootstrapPasswordCredential(new Date("2026-09-12T09:30:00.000Z"));

    expect(BOOTSTRAP_SECRET_LIFETIME_DAYS).toBe(7);
    expect(credential.endDateTime).toBe("2026-09-19T09:30:00.000Z");
  });
});
