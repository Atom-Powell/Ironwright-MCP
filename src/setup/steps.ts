export interface AppRegistrationRequest {
  displayName: string;
  signInAudience: "AzureADMyOrg";
}

export interface SitePermissionRequest {
  roles: string[];
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
  return `${url.host}:${path}`;
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

  return { ok: false, reason: "unknown", message: `Unexpected response ${status}: ${body}` };
}
