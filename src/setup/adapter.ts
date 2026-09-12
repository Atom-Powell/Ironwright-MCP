import type { AppRegistrationRequest, SitePermissionRequest } from "./steps.js";

export interface SetupGraph {
  createApplication(request: AppRegistrationRequest): Promise<{ objectId: string; appId: string }>;
  addPassword(objectId: string): Promise<{ secretText: string }>;
  resolveSite(sitePath: string): Promise<{ siteId: string }>;
  grantSitePermission(siteId: string, request: SitePermissionRequest): Promise<void>;
  verifyAppAccess(args: { appId: string; secret: string; siteId: string }): Promise<{ status: number; body: string }>;
}

const GRAPH = "https://graph.microsoft.com/v1.0";

async function graphJson<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Graph ${method} ${path} failed with ${response.status}: ${text}`);
  }
  return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
}

/**
 * Uses fetch rather than the Graph SDK. The setup command runs once per
 * deployment with a signed-in administrator's token, and pulling in the SDK's
 * auth providers here would be the only reason this phase needs them at all.
 */
export function createFetchSetupGraph(
  accessToken: string,
  acquireAppToken: (appId: string, secret: string) => Promise<string>,
): SetupGraph {
  return {
    async createApplication(request) {
      const created = await graphJson<{ id: string; appId: string }>(accessToken, "POST", "/applications", request);
      return { objectId: created.id, appId: created.appId };
    },

    async addPassword(objectId) {
      const created = await graphJson<{ secretText: string }>(
        accessToken,
        "POST",
        `/applications/${objectId}/addPassword`,
        { passwordCredential: { displayName: "ironwright-mcp" } },
      );
      return { secretText: created.secretText };
    },

    async resolveSite(sitePath) {
      const site = await graphJson<{ id: string }>(accessToken, "GET", `/sites/${sitePath}`);
      return { siteId: site.id };
    },

    async grantSitePermission(siteId, request) {
      await graphJson(accessToken, "POST", `/sites/${siteId}/permissions`, request);
    },

    async verifyAppAccess({ appId, secret, siteId }) {
      // Verification deliberately uses a token minted for the new app, not the
      // administrator's token. An administrator can read the site regardless, so
      // verifying with their token would pass while the app itself is still blocked.
      const appToken = await acquireAppToken(appId, secret);
      const response = await fetch(`${GRAPH}/sites/${siteId}/drive`, {
        headers: { authorization: `Bearer ${appToken}` },
      });
      return { status: response.status, body: await response.text() };
    },
  };
}
