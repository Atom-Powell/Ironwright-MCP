import type { SetupGraph } from "./adapter.js";
import { SetupFailedError } from "./errors.js";
import {
  MICROSOFT_GRAPH_APP_ID,
  SITES_SELECTED_ROLE_CLAIM,
  appRoleIdByValue,
  buildAppRegistrationRequest,
  buildAppRoleAssignmentRequest,
  buildSitePermissionRequest,
  interpretVerification,
  siteIdPathFromUrl,
} from "./steps.js";

export { SetupFailedError } from "./errors.js";

export interface SetupArgs {
  displayName: string;
  siteUrl: string;
  write: boolean;
}

export interface SetupHooks {
  /**
   * Progress and rollback notices. Rollback is the one thing this orchestrator
   * does that the caller cannot infer from the thrown error, and an operator who
   * is not told whether a credential was cleaned up has to go and check.
   */
  onNotice?: (message: string) => void;
}

export interface SetupResult {
  appId: string;
  objectId: string;
  secret: string;
  siteId: string;
}

interface PartialSetup {
  objectId: string;
  appId: string;
  siteId: string;
  sitePermissionId: string | undefined;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Undoes what a failed run created. Every step after the application exists can
 * fail, and without this each failed attempt would leave behind a confidential
 * client holding a secret nobody recorded, plus an identity entry on a
 * customer's site. Failures here are reported rather than thrown, because the
 * cause of the run's failure is the more useful error to surface.
 */
async function rollback(graph: SetupGraph, partial: PartialSetup, notice: (message: string) => void): Promise<void> {
  if (partial.sitePermissionId !== undefined) {
    try {
      await graph.deleteSitePermission(partial.siteId, partial.sitePermissionId);
    } catch (error) {
      notice(
        `Could not remove the site permission granted to ${partial.appId} on site ${partial.siteId}: ${detail(error)}. ` +
          `Remove it with DELETE /sites/${partial.siteId}/permissions/${partial.sitePermissionId}.`,
      );
    }
  }

  try {
    await graph.deleteApplication(partial.objectId);
    notice(`Rolled back the partially configured app registration ${partial.appId}, so no client secret was left behind.`);
  } catch (error) {
    notice(
      `Could not remove the partially configured app registration ${partial.appId} (object id ${partial.objectId}): ${detail(error)}. ` +
        "It holds a client secret, so delete it manually before trying again.",
    );
  }
}

/**
 * Sites.Selected takes two grants, not one. The application permission has to be
 * requested on the registration and admin-consented in the tenant, and only then
 * does the per-site grant mean anything. A run that performs the per-site grant
 * alone produces an app whose token carries no roles and whose every call is
 * refused with a 403 that reads like a broken registration.
 */
export async function runSetup(graph: SetupGraph, args: SetupArgs, hooks: SetupHooks = {}): Promise<SetupResult> {
  const notice = hooks.onNotice ?? ((): void => {});

  // Resolved first because a mistyped site URL is the likeliest input error, and
  // catching it here costs nothing: no application exists yet to roll back.
  const { siteId } = await graph.resolveSite(siteIdPathFromUrl(args.siteUrl));

  const { objectId, appId } = await graph.createApplication(buildAppRegistrationRequest(args.displayName));

  let sitePermissionId: string | undefined;
  try {
    const { secretText } = await graph.addPassword(objectId);

    const servicePrincipal = await graph.createServicePrincipal(appId);
    const graphServicePrincipal = await graph.resolveServicePrincipal(MICROSOFT_GRAPH_APP_ID);
    await graph.grantAppRole(
      buildAppRoleAssignmentRequest({
        principalId: servicePrincipal.objectId,
        resourceId: graphServicePrincipal.objectId,
        appRoleId: appRoleIdByValue(graphServicePrincipal.appRoles, SITES_SELECTED_ROLE_CLAIM),
      }),
    );

    const granted = await graph.grantSitePermission(
      siteId,
      buildSitePermissionRequest({ appId, appDisplayName: args.displayName, write: args.write }),
    );
    sitePermissionId = granted.permissionId;

    const verification = await graph.verifyAppAccess({ appId, secret: secretText, siteId });
    const outcome = interpretVerification(verification.status, verification.body, {
      sitesSelectedRolePresent:
        verification.appRoles === undefined ? undefined : verification.appRoles.includes(SITES_SELECTED_ROLE_CLAIM),
    });
    if (!outcome.ok) throw new SetupFailedError(outcome);

    return { appId, objectId, secret: secretText, siteId };
  } catch (error) {
    await rollback(graph, { objectId, appId, siteId, sitePermissionId }, notice);
    throw error;
  }
}
