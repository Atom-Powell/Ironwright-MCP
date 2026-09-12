import { describe, expect, it } from "vitest";
import {
  buildAppRegistrationRequest,
  buildSitePermissionRequest,
  interpretVerification,
  siteIdPathFromUrl,
} from "../../src/setup/steps.js";

describe("buildAppRegistrationRequest", () => {
  it("requests a single-tenant confidential client", () => {
    expect(buildAppRegistrationRequest("Ironwright Reconciliation")).toEqual({
      displayName: "Ironwright Reconciliation",
      signInAudience: "AzureADMyOrg",
    });
  });
});

describe("buildSitePermissionRequest", () => {
  it("grants write access to one application identity", () => {
    expect(buildSitePermissionRequest({ appId: "11111111-1111-1111-1111-111111111111", appDisplayName: "App", write: true })).toEqual({
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

describe("interpretVerification", () => {
  it("treats 200 as success", () => {
    expect(interpretVerification(200, "{}")).toEqual({ ok: true });
  });
});
