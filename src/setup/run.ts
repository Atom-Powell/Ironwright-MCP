import type { SetupGraph } from "./adapter.js";
import { SetupFailedError } from "./errors.js";
import { GraphRequestError } from "./graph-error.js";
import {
  MICROSOFT_GRAPH_APP_ID,
  SITES_FULL_CONTROL_ROLE_CLAIM,
  SITES_SELECTED_ROLE_CLAIM,
  appRoleIdByValue,
  buildAppRegistrationRequest,
  buildAppRoleAssignmentRequest,
  buildBootstrapPasswordCredential,
  buildServerPasswordCredential,
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
  /**
   * Overridable so tests can exercise the service-principal replication-lag
   * retry below without waiting on real timers. Production always gets a real
   * delay.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Whether the run could prove the new application can reach the site. An
 * unconfirmed run is not a failed one: it leaves a live application and a live
 * grant behind, so the caller has to print the credentials and say plainly that
 * something was left in the tenant.
 */
export type VerificationResult = { confirmed: true } | { confirmed: false; message: string };

export interface SetupResult {
  appId: string;
  objectId: string;
  secret: string;
  siteId: string;
  verification: VerificationResult;
}

interface PartialSetup {
  objectId: string;
  appId: string;
  siteId: string;
  sitePermissionId: string | undefined;
  /**
   * Set the instant grantSitePermission is called, before its response is
   * read. The adapter validates that response and throws if it has no usable
   * id, which happens after Graph has already created the permission, so by
   * the time that throw reaches here sitePermissionId is still undefined even
   * though the grant may have landed. Rollback has to treat "attempted" as
   * "possibly granted", not wait for an id that a failed call will never hand it.
   */
  sitePermissionAttempted: boolean;
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

// Three attempts across roughly nine seconds, matching the delays cli.ts uses
// for the token exchange's own replication-lag retry (AADSTS7000215 /
// AADSTS700016): both problems are the same directory-replication lag showing
// up at a different call. Nothing else is retried here, because every other
// failure from this call is a real configuration or permissions error that
// more attempts cannot fix.
const SERVICE_PRINCIPAL_RETRY_DELAYS_MS = [3000, 6000] as const;

// Matched on Graph's own machine-readable code, not on the message text. The
// message carries the whole response body, so a substring match retries any
// failure whose body happens to quote this code anywhere, and each false
// positive costs nine seconds of waiting before reporting the real error.
function isDirectoryReplicationLagError(error: unknown): boolean {
  return error instanceof GraphRequestError && error.code === "Request_ResourceNotFound";
}

/**
 * POST /servicePrincipals runs immediately after POST /applications, and
 * intermittently fails with Request_ResourceNotFound because the new
 * application has not finished replicating through the directory yet. Before
 * rollback existed that failure just surfaced as an error; now it tears down
 * an otherwise-correct run, so losing this race has to produce a retry, not a
 * teardown.
 */
async function createServicePrincipalWithRetry(
  graph: SetupGraph,
  appId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<{ objectId: string }> {
  for (let index = 0; ; index += 1) {
    try {
      return await graph.createServicePrincipal(appId);
    } catch (error) {
      const delay = SERVICE_PRINCIPAL_RETRY_DELAYS_MS[index];
      if (delay === undefined || !isDirectoryReplicationLagError(error)) throw error;
      await sleep(delay);
    }
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
  const sitePermissionId = partial.sitePermissionId;
  if (partial.sitePermissionAttempted) {
    if (sitePermissionId === undefined) {
      // No request is issued, because there is nothing to address it to. The
      // id is the last path segment of DELETE /sites/{id}/permissions/{id}, so
      // a delete built without one cannot reach the permission Graph may have
      // created; it only ever appeared to clean up because Graph rejected it.
      // The notice is unconditional for the same reason: a possibly orphaned
      // grant on a customer's site is exactly what the operator has to be told
      // about, and hanging that on a failed delete meant a delete that
      // happened to succeed would have said nothing at all.
      notice(
        `The site permission grant to ${partial.appId} on site ${partial.siteId} failed before its response could ` +
          "be read, so it is not known whether Graph created it, and its id is unknown, which leaves this command " +
          `no way to remove it. Check GET /sites/${partial.siteId}/permissions for an entry granted to this app ` +
          "and remove it manually if one is there.",
      );
    } else {
      // Best-effort: the permission may already be gone, which Graph reports
      // as a 404. That failure is reported rather than thrown, because the
      // run's own failure is the more useful error to surface.
      try {
        await graph.deleteSitePermission(partial.siteId, sitePermissionId);
      } catch (error) {
        notice(
          `Could not remove the site permission granted to ${partial.appId} on site ${partial.siteId}: ` +
            `${detail(error)}. Remove it with DELETE /sites/${partial.siteId}/permissions/${sitePermissionId}.`,
        );
      }
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
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

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
  let sitePermissionAttempted = false;
  try {
    const { secretText } = await graph.addPassword(objectId, buildServerPasswordCredential());

    const servicePrincipal = await createServicePrincipalWithRetry(graph, appId, sleep);
    await graph.grantAppRole(
      buildAppRoleAssignmentRequest({
        principalId: servicePrincipal.objectId,
        resourceId: graphServicePrincipal.objectId,
        appRoleId: sitesSelectedAppRoleId,
      }),
    );

    // Marked before the call, not after: the adapter validates the grant
    // response and throws if it has no usable id, and that throw happens after
    // Graph has already created the permission. From here on, "the call was
    // made" is the only fact rollback can rely on.
    sitePermissionAttempted = true;
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
    // A refusal from a token that carries the role is the one failed
    // verification that must not roll back. It says the application permission
    // is consented and the per-site grant this run issued seconds ago exists,
    // so the configuration is correct and Entra has not caught up. Deleting a
    // correct application and a correct grant over that timing artifact
    // destroys work that is right and makes the next attempt start over, which
    // is a worse outcome than reporting an unconfirmed success. Every other
    // failure still rolls back, because in every other case what was created is
    // either wrong or unprovable.
    if (!outcome.ok && outcome.reason === "role-present-refused") {
      return {
        appId,
        objectId,
        secret: secretText,
        siteId,
        verification: { confirmed: false, message: outcome.message },
      };
    }
    if (!outcome.ok) throw new SetupFailedError(outcome);

    return { appId, objectId, secret: secretText, siteId, verification: { confirmed: true } };
  } catch (error) {
    await rollback(graph, { objectId, appId, siteId, sitePermissionId, sitePermissionAttempted }, notice);
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
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Checked before anything is created, because Graph will happily register a
  // second application with an identical display name. Two of those, both
  // holding Sites.FullControl.All, is how the wrong secret gets rotated or the
  // wrong application revoked, and neither mistake is visible in the tenant's
  // app list.
  const existing = await graph.findApplicationByDisplayName(args.displayName);
  if (existing !== undefined) {
    throw new Error(
      `An application named "${args.displayName}" already exists in this tenant (application id ${existing.appId}). ` +
        "Creating a second grant issuer would leave two tenant-wide SharePoint credentials that are hard to tell " +
        `apart. Set IW_BOOTSTRAP_CLIENT_ID to ${existing.appId} and IW_BOOTSTRAP_CLIENT_SECRET to its secret and ` +
        "run the normal setup instead. If that secret was never recorded or has expired, delete the existing " +
        "application and run this again, or pass --name to give this one a distinct name.",
    );
  }

  const graphServicePrincipal = await graph.resolveServicePrincipal(MICROSOFT_GRAPH_APP_ID);
  const fullControlAppRoleId = appRoleIdByValue(graphServicePrincipal.appRoles, SITES_FULL_CONTROL_ROLE_CLAIM);

  const { objectId, appId } = await graph.createApplication(
    buildAppRegistrationRequest(args.displayName, fullControlAppRoleId),
  );

  try {
    // Short-lived by design. The grant issuer is only needed while setup runs,
    // and a tenant-wide SharePoint credential that outlives that window is the
    // main cost of isolating this privilege in its own application.
    const { secretText } = await graph.addPassword(objectId, buildBootstrapPasswordCredential());
    const servicePrincipal = await createServicePrincipalWithRetry(graph, appId, sleep);
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
