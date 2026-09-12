import type { SetupGraph } from "./adapter.js";
import { SetupFailedError } from "./errors.js";
import {
  MICROSOFT_GRAPH_APP_ID,
  SITES_FULL_CONTROL_ROLE_CLAIM,
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
 * The application-deleting half of rollback, split out so runCreateBootstrap can
 * reuse it: that mode never grants a site permission, so it has nothing that
 * corresponds to the other half below.
 */
async function rollbackApplication(
  graph: SetupGraph,
  objectId: string,
  appId: string,
  notice: (message: string) => void,
): Promise<void> {
  try {
    await graph.deleteApplication(objectId);
    notice(`Rolled back the partially configured app registration ${appId}, so no client secret was left behind.`);
  } catch (error) {
    notice(
      `Could not remove the partially configured app registration ${appId} (object id ${objectId}): ${detail(error)}. ` +
        "It holds a client secret, so delete it manually before trying again.",
    );
  }
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

  await rollbackApplication(graph, partial.objectId, partial.appId, notice);
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

  // Also resolved before anything is created, for the same reason: this is a
  // read-only GET against a well-known object (Graph's own service principal)
  // that depends on nothing this run creates, so a failure here leaves nothing
  // to roll back either. Doing it here, rather than after the application
  // exists, is what lets the registration request below name its role by a
  // looked-up id instead of a hardcoded one, and the same appRoles list is
  // reused for the role assignment further down so Graph's service principal
  // is fetched only once.
  const graphServicePrincipal = await graph.resolveServicePrincipal(MICROSOFT_GRAPH_APP_ID);
  const sitesSelectedAppRoleId = appRoleIdByValue(graphServicePrincipal.appRoles, SITES_SELECTED_ROLE_CLAIM);

  const { objectId, appId } = await graph.createApplication(
    buildAppRegistrationRequest(args.displayName, sitesSelectedAppRoleId),
  );

  let sitePermissionId: string | undefined;
  try {
    const { secretText } = await graph.addPassword(objectId);

    const servicePrincipal = await graph.createServicePrincipal(appId);
    await graph.grantAppRole(
      buildAppRoleAssignmentRequest({
        principalId: servicePrincipal.objectId,
        resourceId: graphServicePrincipal.objectId,
        appRoleId: sitesSelectedAppRoleId,
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

/**
 * Creates the grant-issuing application. This is the one place a
 * Sites.FullControl.All credential is created deliberately, and it is a separate
 * mode rather than part of a normal run so that creating a tenant-wide
 * credential is always an explicit act. The server's own application never holds
 * this role, not even transiently, which is the reason for the split: removing a
 * role assignment does not revoke a token already issued under it.
 *
 * Graph's service principal is resolved before the application is created, not
 * after, for the same reason runSetup resolves it first for Sites.Selected: the
 * registration itself has to name the real Sites.FullControl.All app role id,
 * which only exists on that response.
 */
export async function runCreateBootstrap(
  graph: SetupGraph,
  args: { displayName: string },
  hooks: SetupHooks = {},
): Promise<{ appId: string; objectId: string; secret: string }> {
  const notice = hooks.onNotice ?? ((): void => {});

  const graphServicePrincipal = await graph.resolveServicePrincipal(MICROSOFT_GRAPH_APP_ID);
  const fullControlAppRoleId = appRoleIdByValue(graphServicePrincipal.appRoles, SITES_FULL_CONTROL_ROLE_CLAIM);

  const { objectId, appId } = await graph.createApplication(
    buildAppRegistrationRequest(args.displayName, fullControlAppRoleId),
  );

  try {
    const { secretText } = await graph.addPassword(objectId);
    const servicePrincipal = await graph.createServicePrincipal(appId);
    await graph.grantAppRole(
      buildAppRoleAssignmentRequest({
        principalId: servicePrincipal.objectId,
        resourceId: graphServicePrincipal.objectId,
        appRoleId: fullControlAppRoleId,
      }),
    );
    return { appId, objectId, secret: secretText };
  } catch (error) {
    await rollbackApplication(graph, objectId, appId, notice);
    throw error;
  }
}
