// Microsoft Graph's own application id, identical in every tenant. The service
// principal object that represents Graph inside a tenant has a different,
// per-tenant object id, so it has to be looked up by this value rather than
// hardcoded.
export const MICROSOFT_GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";

// How Sites.Selected appears in the roles claim of an application token. Its
// presence is the only direct evidence that admin consent was actually granted,
// which is what separates the two causes of a 403 from the site.
export const SITES_SELECTED_ROLE_CLAIM = "Sites.Selected";

// The claim name for the bootstrap application's permission. A second app role
// id is about to be needed for it, and it is looked up the same way as
// Sites.Selected's rather than hardcoded, for the same reason.
export const SITES_FULL_CONTROL_ROLE_CLAIM = "Sites.FullControl.All";

export interface GraphAppRole {
  id: string;
  value: string;
}

/**
 * Looked up rather than hardcoded. The command already fetches Graph's service
 * principal to get the resourceId for a role assignment, and that same response
 * carries every app role Graph publishes, so a constant GUID here would be an
 * unverified copy of data already in hand.
 */
export function appRoleIdByValue(appRoles: GraphAppRole[], value: string): string {
  const match = appRoles.find((role) => role.value === value);
  if (match === undefined) {
    throw new Error(
      `Microsoft Graph does not publish an application role named "${value}". This usually means the service principal response was truncated or the role was renamed; report it with the value shown here.`,
    );
  }
  return match.id;
}

export interface RequiredResourceAccess {
  resourceAppId: string;
  resourceAccess: { id: string; type: "Role" }[];
}

export interface AppRegistrationRequest {
  displayName: string;
  signInAudience: "AzureADMyOrg";
  requiredResourceAccess: RequiredResourceAccess[];
}

export interface AppRoleAssignmentRequest {
  principalId: string;
  resourceId: string;
  appRoleId: string;
}

export interface SitePermissionRequest {
  roles: ("read" | "write")[];
  grantedToIdentities: { application: { id: string; displayName: string } }[];
}

export interface VerificationEvidence {
  /**
   * Whether the application token used for verification carried the
   * Sites.Selected role. `undefined` means the token could not be read, so
   * neither cause of a 403 can be ruled out.
   */
  sitesSelectedRolePresent: boolean | undefined;
}

export type VerificationOutcome =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "permission-not-consented"
        | "grant-missing"
        | "cause-undetermined"
        | "token"
        | "not-found"
        | "unknown";
      message: string;
    };

/**
 * One instance serves one customer tenant, so the app is single-tenant. A
 * multi-tenant audience would imply a cross-tenant consent story this product
 * deliberately does not have.
 *
 * Sites.Selected is a two-step permission and this is step one: the app role has
 * to be requested on the registration before anyone can consent to it. Step two
 * is the per-site grant. An app that holds only the per-site grant gets a token
 * with no roles claim at all, and every Graph call it makes returns 403.
 *
 * `appRoleId` is supplied by the caller rather than hardcoded here, because
 * this function has no way to look it up itself: Graph's own service
 * principal has to be resolved first, before anything else this run creates.
 */
export function buildAppRegistrationRequest(displayName: string, appRoleId: string): AppRegistrationRequest {
  return {
    displayName,
    signInAudience: "AzureADMyOrg",
    requiredResourceAccess: [
      {
        resourceAppId: MICROSOFT_GRAPH_APP_ID,
        resourceAccess: [{ id: appRoleId, type: "Role" }],
      },
    ],
  };
}

/**
 * Admin consent for an application permission is an appRoleAssignment on the
 * resource's service principal. Requesting the permission on the registration
 * does not grant it; without this assignment the app's token carries no roles.
 */
export function buildAppRoleAssignmentRequest(args: {
  principalId: string;
  resourceId: string;
  appRoleId: string;
}): AppRoleAssignmentRequest {
  return {
    principalId: args.principalId,
    resourceId: args.resourceId,
    appRoleId: args.appRoleId,
  };
}

export function buildSitePermissionRequest(args: {
  appId: string;
  appDisplayName: string;
  write: boolean;
}): SitePermissionRequest {
  return {
    roles: [args.write ? "write" : "read"],
    grantedToIdentities: [{ application: { id: args.appId, displayName: args.appDisplayName } }],
  };
}

export function siteIdPathFromUrl(siteUrl: string): string {
  const url = new URL(siteUrl);
  const path = url.pathname.replace(/\/+$/, "");
  // A colon with nothing after it has no meaning in Graph's path-addressing
  // syntax. A bare host (or a root URL with only a trailing slash) means the
  // tenant's default site, which Graph addresses by the plain host with no
  // trailing colon.
  return path === "" ? url.host : `${url.host}:${path}`;
}

/**
 * Reads the roles claim out of an application access token. The signature is
 * deliberately not validated: this token was just minted for this command by
 * Entra, and the claim is used only to tell two failure causes apart, never to
 * make an access decision.
 *
 * An empty array and `undefined` mean different things. An empty array is a
 * readable token that carries no roles, which is direct evidence that admin
 * consent is missing. `undefined` means the token could not be read at all, so
 * nothing can be concluded from it.
 */
export function appRolesFromAccessToken(token: string): string[] | undefined {
  const segments = token.split(".");
  const payload = segments[1];
  if (segments.length !== 3 || payload === undefined || payload === "") return undefined;

  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return undefined;
    const roles = (decoded as { roles?: unknown }).roles;
    if (roles === undefined) return [];
    if (!Array.isArray(roles)) return undefined;
    return roles.filter((role): role is string => typeof role === "string");
  } catch {
    return undefined;
  }
}

/**
 * Checked before a normal run creates anything. A bootstrap application whose
 * role was never consented fails at the grant call, which is the last step, so
 * without this check a misconfigured bootstrap costs a created-then-rolled-back
 * application on every attempt and reports a failure two steps from its cause.
 */
export function assertBootstrapToken(token: string): void {
  const roles = appRolesFromAccessToken(token);
  if (roles === undefined) {
    throw new Error(
      "The bootstrap application's token could not be read, so its permissions cannot be checked before proceeding. Confirm IW_BOOTSTRAP_CLIENT_ID and IW_BOOTSTRAP_CLIENT_SECRET belong to the grant-issuing application.",
    );
  }
  if (!roles.includes(SITES_FULL_CONTROL_ROLE_CLAIM)) {
    throw new Error(
      `The bootstrap application's token does not carry ${SITES_FULL_CONTROL_ROLE_CLAIM}, so it cannot issue a per-site grant. Its application permission exists on the registration but has not been admin-consented in this tenant. A Privileged Role Administrator or Global Administrator must consent it, or re-run this command with --create-bootstrap to create a correctly configured application.`,
    );
  }
}

const CONSENT_REMEDY =
  "Grant admin consent for Microsoft Graph's Sites.Selected application permission to this app registration. " +
  "A Privileged Role Administrator or Global Administrator has to do that, because the Application Administrator " +
  "role can consent to every API except Microsoft Graph. An assignment made moments ago can also take a short " +
  "time to appear in a newly issued token.";

const GRANT_REMEDY =
  "Grant the app access to this one site with POST /sites/{site-id}/permissions, naming the app id reported above.";

/**
 * Sites.Selected produces two different 403s with two different remedies, and
 * telling them apart is the reason this command exists rather than another app
 * registration walkthrough. A token with no Sites.Selected role means the
 * application permission was never admin-consented. A token that carries the
 * role and is still refused means the per-site grant is missing. Neither is
 * fixed by re-running this command, which would create a second registration,
 * so neither message suggests it.
 */
export function interpretVerification(
  status: number,
  body: string,
  evidence: VerificationEvidence,
): VerificationOutcome {
  if (status >= 200 && status < 300) return { ok: true };

  if (status === 403) {
    if (evidence.sitesSelectedRolePresent === false) {
      return {
        ok: false,
        reason: "permission-not-consented",
        message: `The app was denied access, and its token carries no Sites.Selected role, so the application permission itself is not consented in this tenant. ${CONSENT_REMEDY}`,
      };
    }

    if (evidence.sitesSelectedRolePresent === true) {
      return {
        ok: false,
        reason: "grant-missing",
        message: `The app was denied access even though its token carries the Sites.Selected role, so the application permission is consented and the per-site grant is what is missing. ${GRANT_REMEDY}`,
      };
    }

    // Labeled for what it is. Reporting this as grant-missing would be the same
    // confident wrong answer the old diagnostic gave, one layer down.
    return {
      ok: false,
      reason: "cause-undetermined",
      message: `The app was denied access and its token could not be read, so both causes are still open. Check the application permission first: ${CONSENT_REMEDY} If the role is present, the per-site grant is the remaining cause. ${GRANT_REMEDY}`,
    };
  }

  if (status === 401) {
    return {
      ok: false,
      reason: "token",
      message: "Could not acquire an application token. Check the tenant id, client id, and client secret.",
    };
  }

  if (status === 404) {
    return {
      ok: false,
      reason: "not-found",
      message: "The site was not found. Check the site URL, including its /sites/ segment.",
    };
  }

  // 429 and 5xx are the plausible operational statuses that fall through to
  // here: throttling and transient server-side failures are worth retrying.
  // Anything else does not match a known cause and is worth reporting with
  // the full response text.
  const isTransient = status === 429 || (status >= 500 && status < 600);
  const nextStep = isTransient
    ? "This looks like throttling or a transient server-side failure, so retrying may succeed."
    : "This does not match a known cause, so report it with the full response text.";

  return {
    ok: false,
    reason: "unknown",
    message: `Graph returned an unrecognized status (${status}). Check the error code in the response body first, since it names the real cause. ${nextStep} Response body: ${body}`,
  };
}
