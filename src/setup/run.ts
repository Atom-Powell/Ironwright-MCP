import type { SetupGraph } from "./adapter.js";
import { SetupFailedError } from "./errors.js";
import { GraphRequestError } from "../graph/errors.js";
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
// up at a different call. Shared by the two calls in this file that race the
// directory: POST /servicePrincipals right after POST /applications, and the
// purge right after the delete. Nothing else is retried, because every other
// failure from either call is a real configuration or permissions error that
// more attempts cannot fix.
const DIRECTORY_REPLICATION_RETRY_DELAYS_MS = [3000, 6000] as const;

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
      const delay = DIRECTORY_REPLICATION_RETRY_DELAYS_MS[index];
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
 *
 * `cause` is the error that triggered rollback. It is only inspected in the
 * one state where its shape changes what should be told to the operator: a
 * site permission grant that was attempted but produced no id. Whenever
 * rollback runs with that state, `cause` is always the error grantSitePermission
 * itself threw, because sitePermissionId is assigned synchronously the instant
 * that call resolves, with no other step able to fail in between.
 */
async function rollback(
  graph: SetupGraph,
  partial: PartialSetup,
  notice: (message: string) => void,
  cause: unknown,
): Promise<void> {
  const sitePermissionId = partial.sitePermissionId;
  if (partial.sitePermissionAttempted) {
    if (sitePermissionId === undefined) {
      // A GraphRequestError means Graph answered with a real status, such as
      // the 403 a not-yet-propagated bootstrap grant produces: the request was
      // refused and nothing was created, so there is no orphaned grant to go
      // hunt for on the customer's site. Sending the operator after one on the
      // likeliest failure of this whole design would be a false alarm on
      // every attempt. The genuinely ambiguous case is different in kind: a
      // response Graph accepted but that this command could not read (a non-JSON
      // 2xx body, or one missing the id field), surfaced as a plain Error. Only
      // that case means Graph may have created the permission, and only that
      // case gets the notice below.
      if (!(cause instanceof GraphRequestError)) {
        notice(
          `The site permission grant to ${partial.appId} on site ${partial.siteId} failed before its response ` +
            "could be read, so it is not known whether Graph created it, and its id is unknown, which leaves this " +
            `command no way to remove it. Check GET /sites/${partial.siteId}/permissions, using the bootstrap ` +
            "application's own token, for an entry granted to this app, and remove it manually if one is there.",
        );
      }
    } else {
      // Best-effort: the permission may already be gone, which Graph reports
      // as a 404. That failure is reported rather than thrown, because the
      // run's own failure is the more useful error to surface.
      try {
        await graph.deleteSitePermission(partial.siteId, sitePermissionId);
      } catch (error) {
        notice(
          `Could not remove the site permission granted to ${partial.appId} on site ${partial.siteId}: ` +
            `${detail(error)}. Remove it with DELETE /sites/${partial.siteId}/permissions/${sitePermissionId}, ` +
            "using the bootstrap application's own token.",
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
    await rollback(graph, { objectId, appId, siteId, sitePermissionId, sitePermissionAttempted }, notice, error);
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
  // app list. This call itself throws, before either branch below runs, if the
  // name already matches more than one application: findApplicationByDisplayName
  // refuses that case rather than returning one of them, so "found one" and
  // "found none" are not the only two outcomes here.
  const existing = await graph.findApplicationByDisplayName(args.displayName);
  if (existing !== undefined) {
    throw new Error(
      `An application named "${args.displayName}" already exists in this tenant (application id ${existing.appId}). ` +
        "Creating a second grant issuer would leave two tenant-wide SharePoint credentials that are hard to tell " +
        `apart. Set IW_BOOTSTRAP_CLIENT_ID to ${existing.appId} and IW_BOOTSTRAP_CLIENT_SECRET to its secret and ` +
        "run the normal setup instead. If that secret was never recorded or has expired, or if this application's " +
        "Sites.FullControl.All permission was never consented, delete the existing application and run this " +
        // The preflight this same command's normal-run path performs
        // (assertBootstrapToken, in steps.ts) sends an operator whose bootstrap
        // token lacks the role back here with --create-bootstrap. Without this
        // clause, an application this command itself created for exactly that
        // reason would refuse the operator's only prescribed next step and
        // offer no route past it.
        "again, or pass --name to give this one a distinct name.",
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

export interface DeleteServerAppArgs {
  siteUrl: string;
  displayName: string;
  confirm: boolean;
  forceOrphan: boolean;
  hasGrantIssuer: boolean;
}

export type DeleteServerAppOutcome =
  | { kind: "already-absent"; displayName: string }
  | {
      kind: "planned";
      appId: string;
      objectId: string;
      permissionId: string | undefined;
      /**
       * False when --force-orphan skipped the listing, so `permissionId` being
       * undefined means "not looked at" rather than "not there". Without this a
       * consumer cannot tell those apart, and the difference is the whole
       * distinction between reporting an absence and asserting one.
       */
      permissionsInspected: boolean;
    }
  | {
      kind: "torn-down";
      appId: string;
      objectId: string;
      permissionRevoked: boolean;
      orphanedPermission: boolean;
      /**
       * False when deleteApplication answered 404: the application was already
       * gone by the time this run tried to remove it, so this run did not
       * delete it. Without this the formatter cannot tell a real delete from a
       * tolerated absence, and it said "Deleted application X" for both.
       */
      applicationDeleted: boolean;
      /**
       * False when the purge kept answering 404 through the replication-lag
       * retry. That is not proof the object is gone: the likelier reading is
       * that it has not surfaced in deletedItems yet, which means it is sitting
       * there restorable with its credentials. Only a purge that actually
       * succeeded lets the formatter say the secret is unrecoverable.
       */
      purgeConfirmed: boolean;
    };

function statusOf(error: unknown): number | undefined {
  return error instanceof GraphRequestError ? error.status : undefined;
}

/**
 * Purges the soft-deleted application, retrying the one 404 that is a race
 * rather than an answer.
 *
 * This call fires milliseconds after deleteApplication succeeded in the same
 * run, so "somebody already purged it" is not the realistic cause of a 404
 * here. Directory replication lag is: the object has not yet surfaced in
 * deletedItems. That is the same lag, carrying the same Request_ResourceNotFound
 * code, that POST /servicePrincipals hits right after POST /applications, so it
 * gets the same ladder rather than a second mechanism of its own.
 *
 * Resolves true when Graph accepted the purge, false when a 404 outlasted the
 * ladder, and throws for every other failure, which is a real one the caller
 * has to report.
 */
async function purgeDeletedApplicationWithRetry(
  graph: SetupGraph,
  objectId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let index = 0; ; index += 1) {
    try {
      await graph.purgeDeletedApplication(objectId);
      return true;
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
      const delay = DIRECTORY_REPLICATION_RETRY_DELAYS_MS[index];
      // A 404 that is not the replication-lag code, or one that has outlasted
      // the ladder, is reported as an unconfirmed purge rather than thrown: the
      // object may be gone or may be lagging, and this run cannot tell which.
      if (delay === undefined || !isDirectoryReplicationLagError(error)) return false;
      await sleep(delay);
    }
  }
}

/**
 * Removes a server application and the per-site permission it was granted.
 *
 * The order is forced rather than chosen. The permission entry is matched to
 * the application by app id, so the revoke has to happen while that identity
 * still exists; deleting first leaves an entry naming an identity that is gone,
 * which is the residue this mode exists to stop producing. The purge is what
 * actually ends the credential's life: Entra's delete is a soft delete with a
 * 30 day restore window, so stopping at the delete schedules the removal rather
 * than performing it.
 */
export async function runDeleteServerApp(
  graph: SetupGraph,
  args: DeleteServerAppArgs,
  hooks: SetupHooks = {},
): Promise<DeleteServerAppOutcome> {
  const notice = hooks.onNotice ?? ((): void => {});
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const existing = await graph.findApplicationByDisplayName(args.displayName);
  if (existing === undefined) {
    // The outcome the operator asked for is already true. Nothing else in this
    // function can run without an app id to match a permission entry against.
    return { kind: "already-absent", displayName: args.displayName };
  }

  // resolveSite takes the hostname-and-server-relative form, not the URL as
  // typed. runSetup builds it the same way; passing the raw URL yields a 400.
  const { siteId } = await graph.resolveSite(siteIdPathFromUrl(args.siteUrl));

  let permissionId: string | undefined;
  if (args.hasGrantIssuer) {
    const permissions = await graph.listSitePermissions(siteId);
    permissionId = permissions.find((entry) => entry.appIds.includes(existing.appId))?.permissionId;
  } else if (!args.forceOrphan) {
    // Reached only when no grant issuer is configured, which is exactly when
    // the listing above did not run. So this branch cannot know whether a grant
    // exists, and saying it does would assert something nobody looked for.
    throw new Error(
      `Revoking a site permission needs a grant issuer's app-only token, and none was configured, so nothing ` +
        `was touched: application ${existing.appId} still exists, and whether it still holds a permission on ` +
        `${args.siteUrl} was not checked, because checking needs the grant issuer this run does not have. ` +
        "Create one with --create-bootstrap and re-run, or pass --force-orphan to delete and purge the " +
        "application anyway and leave any permission entry behind.",
    );
  }

  if (!args.confirm) {
    return {
      kind: "planned",
      appId: existing.appId,
      objectId: existing.objectId,
      permissionId,
      permissionsInspected: args.hasGrantIssuer,
    };
  }

  let permissionRevoked = false;
  if (permissionId !== undefined) {
    // Named by the site URL the operator typed, not by siteId: every other
    // message in this mode uses the URL, and mixing the two made stderr and
    // stdout read as though they were about two different sites.
    notice(`Revoking site permission ${permissionId} on ${args.siteUrl}.`);
    await graph.deleteSitePermission(siteId, permissionId);
    permissionRevoked = true;
  }

  notice(`Deleting application ${existing.appId} (object id ${existing.objectId}).`);
  let applicationDeleted = true;
  try {
    await graph.deleteApplication(existing.objectId);
  } catch (error) {
    if (statusOf(error) !== 404) {
      const state = permissionRevoked
        ? "The site permission was revoked, and the application still exists"
        : "No site permission was revoked, and the application still exists";
      throw new Error(
        `${state}: deleting ${existing.appId} failed. Re-running is safe and will finish the job. ` +
          `Underlying failure: ${detail(error)}`,
        // Preserved rather than flattened so describeSetupFailure can still
        // reach nextStepForGraphFailure's DELETE /applications branch, which is
        // the remedy for a 403 here and the likeliest way this call fails.
        { cause: error },
      );
    }
    // A 404 means the application was gone before this run's delete reached it,
    // most likely a concurrent teardown between the lookup and this call. The
    // outcome the operator asked for is still true, but this run did not
    // perform the delete and must not report that it did.
    applicationDeleted = false;
  }

  notice(`Purging application ${existing.objectId} from deleted items.`);
  let purgeConfirmed: boolean;
  try {
    purgeConfirmed = await purgeDeletedApplicationWithRetry(graph, existing.objectId, sleep);
  } catch (error) {
    // Unlike the delete failure above, re-running does not retry this: the
    // application is now soft-deleted, which findApplicationByDisplayName's
    // own lookup (GET /applications) does not return, so a re-run reports
    // already-absent and never calls purgeDeletedApplication again. The
    // fix is a manual purge, not another run of this command.
    throw new Error(
      `Application ${existing.appId} was deleted, but purging it from deleted items failed, so it is ` +
        "soft-deleted rather than gone: the object stays in the tenant's deleted items for 30 days and " +
        "anyone who can restore it gets its credentials back with it. Re-running this command will not " +
        "retry the purge, because the lookup this command uses to find the application does not return a " +
        `soft-deleted one, so a re-run reports it already absent. Purge it by hand: ` +
        `DELETE /directory/deletedItems/${existing.objectId}, using the operator's own delegated token. ` +
        `Underlying failure: ${detail(error)}`,
      { cause: error },
    );
  }

  return {
    kind: "torn-down",
    appId: existing.appId,
    objectId: existing.objectId,
    permissionRevoked,
    orphanedPermission: !args.hasGrantIssuer,
    applicationDeleted,
    purgeConfirmed,
  };
}

export type DeleteBootstrapOutcome =
  | { kind: "deleted"; appId: string; objectId: string }
  | { kind: "already-absent"; displayName: string };

/**
 * Removes the grant issuer. Deleting it is what actually removes the standing
 * privilege: the secret's expiry only disables one credential, while the
 * application keeps its admin-consented Sites.FullControl.All assignment and
 * anyone able to add a secret would regain tenant-wide SharePoint access
 * without further consent.
 */
export async function runDeleteBootstrap(
  graph: SetupGraph,
  args: { displayName: string },
  hooks: SetupHooks = {},
): Promise<DeleteBootstrapOutcome> {
  const notice = hooks.onNotice ?? ((): void => {});

  const existing = await graph.findApplicationByDisplayName(args.displayName);
  if (existing === undefined) {
    // Absent is the outcome the operator asked for, not a failure. Reporting it
    // as one made a correctly torn-down tenant indistinguishable from a broken
    // one, so a script enforcing teardown across tenants would retry or alert on
    // a tenant that was already finished.
    return { kind: "already-absent", displayName: args.displayName };
  }

  notice(`Deleting application ${existing.appId} (object id ${existing.objectId}).`);
  await graph.deleteApplication(existing.objectId);

  return { kind: "deleted", appId: existing.appId, objectId: existing.objectId };
}
