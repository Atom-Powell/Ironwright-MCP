export interface AppRegistrationRequest {
  displayName: string;
  signInAudience: "AzureADMyOrg";
}

export interface SitePermissionRequest {
  roles: ("read" | "write")[];
  grantedToIdentities: { application: { id: string; displayName: string } }[];
}

export type VerificationOutcome =
  | { ok: true }
  | { ok: false; reason: "grant-missing" | "token" | "not-found" | "unknown"; message: string };

/**
 * One instance serves one customer tenant, so the app is single-tenant. A
 * multi-tenant audience would imply a cross-tenant consent story this product
 * deliberately does not have.
 */
export function buildAppRegistrationRequest(displayName: string): AppRegistrationRequest {
  return { displayName, signInAudience: "AzureADMyOrg" };
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
 * Sites.Selected access needs a per-site grant after the app registration
 * exists. Skipping it produces a 403 that reads like a broken registration, so
 * the 403 message names the grant explicitly. This mapping is the whole reason
 * the setup command exists rather than another app-registration walkthrough.
 */
export function interpretVerification(status: number, body: string): VerificationOutcome {
  if (status >= 200 && status < 300) return { ok: true };

  if (status === 403) {
    return {
      ok: false,
      reason: "grant-missing",
      message:
        "The app was denied access to the site. With Sites.Selected this almost always means the per-site grant is missing, not that the app registration is wrong. Re-run this command, or grant it manually with POST /sites/{site-id}/permissions.",
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
    ? "This looks like throttling or a transient server-side failure, so retrying is worth trying."
    : "This does not match a known cause, so report it with the full response text.";

  return {
    ok: false,
    reason: "unknown",
    message: `Graph returned an unrecognized status (${status}). Check the error code in the response body first, since it names the real cause. ${nextStep} Response body: ${body}`,
  };
}
