import { GraphRequestError } from "./graph-error.js";
import { appRolesFromAccessToken } from "./steps.js";
import type {
  AppRegistrationRequest,
  AppRoleAssignmentRequest,
  GraphAppRole,
  PasswordCredentialRequest,
  SitePermissionRequest,
} from "./steps.js";

export interface SetupGraph {
  resolveSite(sitePath: string): Promise<{ siteId: string }>;
  createApplication(request: AppRegistrationRequest): Promise<{ objectId: string; appId: string }>;
  addPassword(objectId: string, credential: PasswordCredentialRequest): Promise<{ secretText: string }>;
  createServicePrincipal(appId: string): Promise<{ objectId: string }>;
  resolveServicePrincipal(appId: string): Promise<{ objectId: string; appRoles: GraphAppRole[] }>;
  grantAppRole(request: AppRoleAssignmentRequest): Promise<void>;
  grantSitePermission(siteId: string, request: SitePermissionRequest): Promise<{ permissionId: string }>;
  verifyAppAccess(args: {
    appId: string;
    secret: string;
    siteId: string;
  }): Promise<{ status: number; body: string; appRoles: string[] | undefined }>;
  deleteSitePermission(siteId: string, permissionId: string): Promise<void>;
  deleteApplication(objectId: string): Promise<void>;
}

const GRAPH = "https://graph.microsoft.com/v1.0";

interface GraphResponse {
  method: string;
  path: string;
  status: number;
  value: unknown;
}

async function graphRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<GraphResponse> {
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
    throw new GraphRequestError({ method, path, status: response.status, body: text });
  }

  let value: unknown = undefined;
  if (text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      // A 2xx that is not JSON means something other than Graph answered, most
      // often a proxy. Treating it as an empty body would hide that behind a
      // missing-field error naming the wrong cause.
      throw new Error(
        `Graph ${method} ${path} returned ${response.status} with a body that is not JSON. ` +
          "Something other than Graph answered this request, so the setup cannot continue.",
      );
    }
  }

  return { method, path, status: response.status, value };
}

/**
 * Pulls named string fields out of a Graph response and fails loudly when one is
 * absent. Without this a 2xx of an unexpected shape yields undefined, which then
 * interpolates as the literal text "undefined" into a later Graph path and fails
 * several calls downstream from the real cause.
 */
function requireFields<K extends string>(response: GraphResponse, names: readonly K[]): Record<K, string> {
  const record =
    typeof response.value === "object" && response.value !== null
      ? (response.value as Record<string, unknown>)
      : {};

  const result = {} as Record<K, string>;
  for (const name of names) {
    const found = record[name];
    if (typeof found !== "string" || found === "") {
      throw new Error(
        `Graph ${response.method} ${response.path} returned ${response.status} without a usable "${name}" field. ` +
          "The response shape is not what this command expects, so the setup cannot continue.",
      );
    }
    result[name] = found;
  }
  return result;
}

export interface FetchSetupGraphOptions {
  /** The signed-in operator's delegated token. Used for everything except the site permission endpoint. */
  adminToken: string;
  /** Mints an app-only token for a newly created application, used only to verify its own access. */
  acquireAppToken: (appId: string, secret: string) => Promise<string>;
  /**
   * Mints an app-only token for the bootstrap application. Graph
   * refuses a delegated token on /sites/{id}/permissions regardless of the
   * caller's directory roles, confirmed live against a Global Administrator on
   * 2026-09-12, so the grant and its rollback must both use this.
   */
  acquireBootstrapToken: () => Promise<string>;
}

/**
 * Uses fetch rather than the Graph SDK. The setup command runs once per
 * deployment with a signed-in administrator's token, and pulling in the SDK's
 * auth providers here would be the only reason this phase needs them at all.
 */
export function createFetchSetupGraph(options: FetchSetupGraphOptions): SetupGraph {
  const { adminToken, acquireAppToken, acquireBootstrapToken } = options;

  return {
    async resolveSite(sitePath) {
      const response = await graphRequest(adminToken, "GET", `/sites/${sitePath}`);
      return { siteId: requireFields(response, ["id"]).id };
    },

    async createApplication(request) {
      const response = await graphRequest(adminToken, "POST", "/applications", request);
      const created = requireFields(response, ["id", "appId"]);
      return { objectId: created.id, appId: created.appId };
    },

    async addPassword(objectId, credential) {
      // The caller supplies the label and any expiry, because the two
      // applications this command creates need different ones: the grant
      // issuer's secret is deliberately short-lived and the server's is not.
      const response = await graphRequest(adminToken, "POST", `/applications/${objectId}/addPassword`, {
        passwordCredential: credential,
      });
      return { secretText: requireFields(response, ["secretText"]).secretText };
    },

    async createServicePrincipal(appId) {
      // POST /applications creates only the registration. The service principal
      // is the tenant-local identity that actually holds role assignments and
      // that the token endpoint resolves a client id against, so without this
      // call a client-credentials request fails with AADSTS700016.
      const response = await graphRequest(adminToken, "POST", "/servicePrincipals", { appId });
      return { objectId: requireFields(response, ["id"]).id };
    },

    async resolveServicePrincipal(appId) {
      // Addressed by appId rather than filtered, because the key-lookup form is
      // exact: a $filter query would need paging and could return nothing for a
      // resource that certainly exists in the tenant. $select is narrowed to the
      // two fields this command actually uses, since the full service principal
      // object is large.
      const response = await graphRequest(
        adminToken,
        "GET",
        `/servicePrincipals(appId='${appId}')?$select=id,appRoles`,
      );
      const found = requireFields(response, ["id"]);
      const body = typeof response.value === "object" && response.value !== null ? response.value : {};
      const appRoles = Array.isArray((body as { appRoles?: unknown }).appRoles)
        ? ((body as { appRoles: unknown[] }).appRoles as GraphAppRole[])
        : [];
      return { objectId: found.id, appRoles };
    },

    async grantAppRole(request) {
      // The assignment is created on the resource's service principal, which is
      // Microsoft Graph's, not on the client's. This is the admin-consent step.
      await graphRequest(
        adminToken,
        "POST",
        `/servicePrincipals/${request.resourceId}/appRoleAssignedTo`,
        request,
      );
    },

    async grantSitePermission(siteId, request) {
      // Graph refuses a delegated token here even for a Global Administrator, so
      // this call needs the bootstrap application's app-only token,
      // not the operator's.
      const bootstrapToken = await acquireBootstrapToken();
      const response = await graphRequest(bootstrapToken, "POST", `/sites/${siteId}/permissions`, request);
      return { permissionId: requireFields(response, ["id"]).id };
    },

    async verifyAppAccess({ appId, secret, siteId }) {
      // Verification deliberately uses a token minted for the new app, not the
      // administrator's token. An administrator can read the site regardless, so
      // verifying with their token would pass while the app itself is still blocked.
      const appToken = await acquireAppToken(appId, secret);
      const response = await fetch(`${GRAPH}/sites/${siteId}/drive`, {
        headers: { authorization: `Bearer ${appToken}` },
      });
      // The roles claim is carried out with the result because it is the only
      // direct evidence separating an unconsented application permission from a
      // missing per-site grant, and both look identical in the response body.
      return {
        status: response.status,
        body: await response.text(),
        appRoles: appRolesFromAccessToken(appToken),
      };
    },

    async deleteSitePermission(siteId, permissionId) {
      // Same endpoint family as the grant, so the rollback delete needs the same
      // bootstrap token: a failed run cleaning up with the operator's delegated
      // token would be refused for the identical reason the grant itself would be.
      const bootstrapToken = await acquireBootstrapToken();
      await graphRequest(bootstrapToken, "DELETE", `/sites/${siteId}/permissions/${permissionId}`);
    },

    async deleteApplication(objectId) {
      // Deleting the application also removes its service principal and every
      // role assignment held by it, and the client secret lives on the
      // application object, so this one call revokes the whole credential.
      await graphRequest(adminToken, "DELETE", `/applications/${objectId}`);
    },
  };
}
