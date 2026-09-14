import { GRAPH_BASE } from "../graph/client.js";
import { GraphRequestError } from "../graph/errors.js";
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
  findApplicationByDisplayName(displayName: string): Promise<{ objectId: string; appId: string } | undefined>;
  createApplication(request: AppRegistrationRequest): Promise<{ objectId: string; appId: string }>;
  addPassword(objectId: string, credential: PasswordCredentialRequest): Promise<{ secretText: string }>;
  createServicePrincipal(appId: string): Promise<{ objectId: string }>;
  resolveServicePrincipal(appId: string): Promise<{ objectId: string; appRoles: GraphAppRole[] }>;
  grantAppRole(request: AppRoleAssignmentRequest): Promise<void>;
  grantSitePermission(siteId: string, request: SitePermissionRequest): Promise<{ permissionId: string }>;
  /** Each entry's id, with the application ids inside its granted identities. */
  listSitePermissions(siteId: string): Promise<Array<{ permissionId: string; appIds: string[] }>>;
  verifyAppAccess(args: {
    appId: string;
    secret: string;
    siteId: string;
  }): Promise<{ status: number; body: string; appRoles: string[] | undefined }>;
  deleteSitePermission(siteId: string, permissionId: string): Promise<void>;
  deleteApplication(objectId: string): Promise<void>;
  /**
   * Removes an already soft-deleted application from the tenant's deleted
   * items, so it cannot be restored with its credentials intact. A teardown
   * that stops at deleteApplication has scheduled that removal, not performed it.
   */
  purgeDeletedApplication(objectId: string): Promise<void>;
}

interface GraphResponse {
  method: string;
  path: string;
  status: number;
  value: unknown;
}

/**
 * `path` may be a Graph-relative path, or an absolute Graph URL when it came
 * from an `@odata.nextLink`, which Graph returns fully qualified. Either way,
 * what a GraphRequestError reports is a relative label, sliced from
 * GRAPH_BASE the same way src/graph/client.ts's own `get` does: an absolute
 * URL that does not start with GRAPH_BASE is reported whole rather than having
 * its first characters cut off by a blind slice, but a followed nextLink page
 * is reported exactly like a first-page request, so isSitePermissionsPath and
 * the other path matchers in cli.ts recognize a failure on it.
 */
async function graphRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<GraphResponse> {
  const url = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;
  const label = url.startsWith(GRAPH_BASE) ? url.slice(GRAPH_BASE.length) : url;

  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new GraphRequestError({ method, path: label, status: response.status, body: text });
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
        `Graph ${method} ${label} returned ${response.status} with a body that is not JSON. ` +
          "Something other than Graph answered this request, so the setup cannot continue.",
      );
    }
  }

  return { method, path: label, status: response.status, value };
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

/**
 * Reads the application ids out of one permission entry's granted identities.
 * Graph's current shape is grantedToIdentitiesV2, but the deprecated
 * grantedToIdentities is still a real possibility here, not a hypothetical
 * one: grantSitePermission's own request body (steps.ts's
 * SitePermissionRequest) is written in that older shape, so a response that
 * echoes back what was sent, rather than Graph's newer field, is exactly the
 * kind of response this teardown will actually see. V2 is preferred when
 * present; the legacy field is read only as a fallback, so an entry carrying
 * both is not double-counted.
 */
function applicationIdsFromGrant(entry: Record<string, unknown>): string[] {
  const identities = Array.isArray(entry.grantedToIdentitiesV2)
    ? entry.grantedToIdentitiesV2
    : Array.isArray(entry.grantedToIdentities)
      ? entry.grantedToIdentities
      : [];

  return identities.flatMap((identity: unknown) => {
    const application =
      typeof identity === "object" && identity !== null
        ? (identity as { application?: { id?: unknown } }).application
        : undefined;
    return typeof application?.id === "string" ? [application.id] : [];
  });
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

    async findApplicationByDisplayName(displayName) {
      // A single quote delimits an OData string, so an unescaped one in a
      // display name makes this a syntax error rather than a lookup. Doubling
      // is how OData escapes it.
      const filter = `displayName eq '${displayName.replace(/'/g, "''")}'`;
      const response = await graphRequest(
        adminToken,
        "GET",
        `/applications?$filter=${encodeURIComponent(filter)}&$select=id,appId`,
      );
      const body = typeof response.value === "object" && response.value !== null ? response.value : {};
      const matches = (body as { value?: unknown }).value;
      const list = Array.isArray(matches) ? matches : [];
      if (list.length === 0) return undefined;
      // displayName is not unique in Entra, so this filter can return more than
      // one application. Silently taking the first would let a caller believe a
      // single application was found, acted on, and (on the delete path)
      // removed, while an identically named one is left behind for a later run
      // to trip over.
      if (list.length > 1) {
        throw new Error(
          `Found ${list.length} applications named "${displayName}" in this tenant, so which one is meant is ` +
            "ambiguous. --name cannot tell them apart after the fact: it selects by this same display name, and " +
            "renaming one of two applications that already share it is not something this command can do for " +
            "you. Rename the one you do not want in the Entra portal, then pass --name matching the survivor's " +
            "display name, or delete the extra application there directly.",
        );
      }
      const found = requireFields({ ...response, value: list[0] }, ["id", "appId"]);
      return { objectId: found.id, appId: found.appId };
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

    async listSitePermissions(siteId) {
      // Same endpoint family as the grant and its rollback delete, so this
      // read needs the bootstrap application's token too: Graph refuses a
      // delegated token on /sites/{id}/permissions regardless of the caller's
      // directory roles. Minted once for the whole listing rather than per
      // page: a page loop here lasts seconds and a token lasts an hour.
      const bootstrapToken = await acquireBootstrapToken();

      // Paged rather than read from the first response alone. The one consumer
      // of this listing, --delete-server-app, treats a missing match as "no
      // permission entry is granted to this application" and then deletes and
      // purges. A match sitting on a second page would make that an asserted
      // absence nothing established, and would produce exactly the orphaned
      // entry the mode exists to prevent while reporting a clean teardown.
      // Following @odata.nextLink is the treatment src/graph/delta.ts gives the
      // same field; the difference is that a collection GET has no terminal
      // marker of its own, so the absence of a nextLink is the end of the
      // listing rather than the ambiguity delta.ts refuses on.
      const results: Array<{ permissionId: string; appIds: string[] }> = [];
      const requested = new Set<string>();
      let next: string | undefined = `/sites/${siteId}/permissions`;

      while (next !== undefined) {
        // A link that repeats one already followed cannot end, and quietly
        // looping on it is the other half of what delta.ts refuses: an
        // enumeration that either never terminates or terminates silently
        // incomplete.
        if (requested.has(next)) {
          throw new Error(
            `Listing the permissions on site ${siteId} was sent back to a page it had already requested, so ` +
              "the listing cannot be completed without looping. The permission entries on this site cannot be " +
              "read, so the teardown cannot tell whether one is granted to this application.",
          );
        }
        requested.add(next);

        const response: GraphResponse = await graphRequest(bootstrapToken, "GET", next);
        const body = typeof response.value === "object" && response.value !== null ? response.value : {};
        const entries = (body as { value?: unknown }).value;
        const list = Array.isArray(entries) ? entries : [];

        // An entry this cannot make sense of is skipped rather than refused,
        // unlike the scan layer, which refuses loudly on an item it cannot read
        // because that item might be a file the reconciliation would otherwise
        // silently lose track of. A permission entry we cannot parse here is not
        // that: it is metadata about who a grant was extended to, and skipping
        // it means the entry contributes no application id rather than a bogus
        // one, not that the whole listing is thrown away.
        for (const raw of list) {
          const entry = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
          if (typeof entry.id !== "string") continue;
          results.push({ permissionId: entry.id, appIds: applicationIdsFromGrant(entry) });
        }

        // A continuation link of any other type is refused rather than
        // coerced: a non-string there means the response is not the shape this
        // code reads, and stopping on it would report a partial listing as a
        // complete one.
        const link: unknown = (body as Record<string, unknown>)["@odata.nextLink"];
        if (link === undefined) {
          next = undefined;
        } else if (typeof link === "string") {
          next = link;
        } else {
          throw new Error(
            `A permissions page for site ${siteId} carried an @odata.nextLink that is not a URL, so the rest of ` +
              "the listing cannot be fetched and the entries read so far are not the whole set.",
          );
        }
      }

      return results;
    },

    async verifyAppAccess({ appId, secret, siteId }) {
      // Verification deliberately uses a token minted for the new app, not the
      // administrator's token. An administrator can read the site regardless, so
      // verifying with their token would pass while the app itself is still blocked.
      const appToken = await acquireAppToken(appId, secret);
      const response = await fetch(`${GRAPH_BASE}/sites/${siteId}/drive`, {
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

    async purgeDeletedApplication(objectId) {
      // Entra's delete of an application registration is a soft delete: the
      // object sits in the tenant's deleted items for 30 days, where anyone
      // holding Application Administrator can restore it along with its
      // credentials. This call, like deleteApplication before it, is on the
      // operator's own delegated token: deletedItems is not part of the
      // /sites/{id}/permissions family the bootstrap token exists for.
      await graphRequest(adminToken, "DELETE", `/directory/deletedItems/${objectId}`);
    },
  };
}
