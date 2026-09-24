import { appRolesFromAccessToken } from "../graph/roles.js";

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
        // Named for the evidence rather than for a cause, because the cause is
        // exactly what this case cannot establish: the token proves the role is
        // there and the run issued the grant itself, so the refusal says only
        // that access could not be confirmed yet. The former name,
        // "grant-missing", asserted a cause that the message beneath it had
        // already stopped claiming.
        | "role-present-refused"
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

export interface PasswordCredentialRequest {
  displayName: string;
  /** Omitted for the server's own secret, which keeps Graph's default lifetime. */
  endDateTime?: string;
}

/**
 * The server's own client secret. Named for the server rather than for the
 * product, because the grant issuer's secret sits beside it in the same tenant
 * and one shared label is how the wrong one gets rotated. No explicit expiry:
 * this credential is what the deployed container authenticates with, so
 * shortening it would take the server down rather than reduce exposure.
 */
export function buildServerPasswordCredential(): PasswordCredentialRequest {
  return { displayName: "ironwright-mcp-server" };
}

// Seven days. The grant issuer is only needed while setup runs, which is
// minutes, so the lifetime only has to cover onboarding a site and any retry
// or second site that follows in the same window, including one that slips
// over a weekend or into a change window. Graph's unstated default is two
// years, and a two-year tenant-wide SharePoint credential with no rotation
// story would undo the argument for isolating this privilege in the first
// place. The recommended posture is to delete the application after setup and
// recreate it with --create-bootstrap at the next onboarding; this expiry is
// what makes forgetting to do that self-correcting rather than permanent.
export const BOOTSTRAP_SECRET_LIFETIME_DAYS = 7;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export function buildBootstrapPasswordCredential(now: Date = new Date()): PasswordCredentialRequest {
  const expiry = new Date(now.getTime() + BOOTSTRAP_SECRET_LIFETIME_DAYS * MILLISECONDS_PER_DAY);
  return { displayName: "ironwright-grant-issuer", endDateTime: expiry.toISOString() };
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

export { appRolesFromAccessToken } from "../graph/roles.js";

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
      `The bootstrap application's token does not carry ${SITES_FULL_CONTROL_ROLE_CLAIM}, so it cannot issue or revoke a per-site grant. Its application permission exists on the registration but has not been admin-consented in this tenant. A Privileged Role Administrator or Global Administrator must consent it, or re-run this command with --create-bootstrap to create a correctly configured application.`,
    );
  }
}

// interpretVerification is a pure function of status, body and evidence: it
// runs before rollback and has no way to observe whether rollback succeeds.
// Every message below that follows from a rolled-back outcome uses this
// fragment rather than asserting "nothing is left behind" itself, because that
// assertion can be false: rollback can fail, and when it does, runSetup emits
// its own notice naming exactly what could not be removed, printed ahead of
// this message. Deferring to that notice, rather than repeating a claim this
// function cannot verify, is what keeps the two from contradicting each other.
const ROLLBACK_NOTE =
  "This run rolled back what it created; anything it could not remove is named in the notices above.";

// Written for a run that rolled back, which is what a missing role on the
// verification token produces. It does not claim consent was never granted:
// this command performs the role assignment itself, and reaching verification
// at all means that call succeeded, so an assignment that has not yet surfaced
// in a freshly issued token is the likelier reading of the evidence.
const CONSENT_REMEDY =
  `${ROLLBACK_NOTE} The role assignment this run made is itself what grants that consent, so the likeliest cause ` +
  "is that it had not reached a newly issued token yet; wait a minute and run this command again. If a second " +
  "attempt fails the same way, the assignment is not taking effect: granting admin consent for a Microsoft Graph " +
  "application permission needs Privileged Role Administrator or Global Administrator, because the Application " +
  "Administrator role can consent to every API except Microsoft Graph.";

// Written for a run that kept what it created, which is what a 403 from a
// token carrying the role produces. The role proves the application permission
// is in effect and this command issued the per-site grant itself moments
// earlier, so the configuration is correct and only Entra is behind. Telling
// the operator to inspect or re-issue the grant would name objects that are
// still there, which is the point of keeping them.
const GRANT_REMEDY =
  "The application and its per-site grant were kept, not rolled back: the token shows the configuration is " +
  "correct, so nothing here needs creating again. This command issued the per-site grant moments ago, so the " +
  "likeliest cause is that the grant has not propagated to this site yet. Wait a short while and try the app's " +
  "own access again. If it is still refused, check GET /sites/{site-id}/permissions for an entry naming this app, " +
  "and if none is there an administrator can issue one with POST /sites/{site-id}/permissions using the bootstrap " +
  "application's own token.";

// A separate message rather than the two above concatenated. They now describe
// opposite outcomes, one for a run that kept its application and one for a run
// that rolled back, so joining them would tell the operator both at once. This
// case rolls back, and its own honest content is short.
const UNDETERMINED_CAUSE_MESSAGE =
  `The app was denied access and its token could not be read, so neither cause can be ruled out. ${ROLLBACK_NOTE} ` +
  "Wait a minute and run this command again, signed in as a Privileged Role Administrator or Global " +
  "Administrator, since the Application Administrator role cannot consent a Microsoft Graph application " +
  "permission and a directory change made moments earlier can also need a little time. An attempt whose token " +
  "can be read will name which of the two causes applies; if the token cannot be read then either, report that, " +
  "because an unreadable application token is a defect in this command rather than a tenant setting.";

// Written for the two statuses verifyAppAccess can see that are not 403: the
// call already has a token in hand (acquireAppToken succeeded before this
// status was ever read) and the site itself was already resolved, with the
// operator's own token, earlier in this same run. So a 401 here is not a
// credential the operator can inspect, and a 404 here is not evidence the
// site URL is wrong: both would name causes this run has already disproved.
const APP_TOKEN_REMEDY =
  `${ROLLBACK_NOTE} Checking the tenant id, client id, or secret will not help: this call used a token minted ` +
  "moments ago for this run's own application, so a stale or not-yet-propagated token is the likelier cause. " +
  "Wait a minute and run this command again.";

const SITE_VISIBILITY_REMEDY =
  `${ROLLBACK_NOTE} Wait a minute and run this command again: the per-site grant this run just issued may not ` +
  "have reached this application yet.";

/**
 * Sites.Selected produces two different 403s with two different remedies, and
 * telling them apart is the reason this command exists rather than another app
 * registration walkthrough. A token with no Sites.Selected role means the
 * application permission is not in effect. A token that carries the role and is
 * still refused means the configuration is right and access could not be
 * confirmed yet; it does not mean the grant is absent.
 *
 * Each message also has to match what the run does with that outcome, which is
 * not the same for both: the role-present case keeps its application and grant,
 * and every other case rolls back. A remedy that names an object the run just
 * deleted is the defect these messages exist to avoid, so they are written per
 * outcome rather than assembled from shared fragments.
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
        message: `The app was denied access, and its token carries no Sites.Selected role, so the application permission is not in effect in this tenant yet. ${CONSENT_REMEDY}`,
      };
    }

    if (evidence.sitesSelectedRolePresent === true) {
      return {
        ok: false,
        reason: "role-present-refused",
        message: `The app was denied access even though its token carries the Sites.Selected role, so the application permission is consented and the app's access could not be confirmed yet. ${GRANT_REMEDY}`,
      };
    }

    // Labeled for what it is. Reporting this as a specific cause would be the
    // same confident wrong answer the old diagnostic gave, one layer down.
    return {
      ok: false,
      reason: "cause-undetermined",
      message: UNDETERMINED_CAUSE_MESSAGE,
    };
  }

  if (status === 401) {
    return {
      ok: false,
      reason: "token",
      message: `The application's own token was rejected by Graph on this call, even though it was minted moments ago for this run's new application. ${APP_TOKEN_REMEDY}`,
    };
  }

  if (status === 404) {
    return {
      ok: false,
      reason: "not-found",
      message: `The site was not found by this application's own token, even though this run already resolved this exact site with the signed-in operator's token earlier in the same run. Graph can return 404, not 403, when an application lacks access to a site it cannot see, so this is not evidence the site URL is wrong. ${SITE_VISIBILITY_REMEDY}`,
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
