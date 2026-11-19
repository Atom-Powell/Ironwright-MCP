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
  listSiteUrls,
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
  /**
   * Every site the application was granted, in the order the operator gave.
   * One run has to cover all of them: the entries are found by app id, and
   * once the application is deleted nothing can find the ones left behind.
   */
  siteUrls: string[];
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
      /** One entry per site, in the order given; `permissionId` is this application's entry there. */
      sites: Array<{ siteUrl: string; permissionId: string | undefined }>;
      /**
       * False when --force-orphan skipped the listing, so a `permissionId` being
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
      /**
       * One entry per site, in the order given. `none` covers both a site
       * whose listing found no entry and, under orphanedPermission, one nobody
       * listed; orphanedPermission is what tells those apart. `already-gone`
       * is an entry the listing found that the revoke then answered 404 for:
       * this run did not remove it and must not say it did.
       */
      sites: Array<{ siteUrl: string; permission: "revoked" | "already-gone" | "none" }>;
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
      /**
       * True only when the ladder actually slept at least once waiting on
       * directory replication, as distinct from purgeConfirmed being false.
       * A 404 whose code does not match Request_ResourceNotFound, or one from
       * something other than Graph, gives up after the first attempt with no
       * sleep at all: the formatter must not tell the operator lag was ruled
       * out on a run that never waited for it.
       */
      purgeRetried: boolean;
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
 * Resolves `{ purged: true, ... }` when Graph accepted the purge, `{ purged:
 * false, ... }` when a 404 outlasted the ladder or never matched it, and
 * throws for every other failure, which is a real one the caller has to
 * report. `retried` carries whether the ladder actually slept at least once,
 * separately from `purged`: a 404 whose code does not match
 * Request_ResourceNotFound gives up on the first attempt with no sleep at
 * all, and the caller's message must not claim replication lag was ruled out
 * on a run that never tested for it.
 */
async function purgeDeletedApplicationWithRetry(
  graph: SetupGraph,
  objectId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<{ purged: boolean; retried: boolean }> {
  let retried = false;
  for (let index = 0; ; index += 1) {
    try {
      await graph.purgeDeletedApplication(objectId);
      return { purged: true, retried };
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
      const delay = DIRECTORY_REPLICATION_RETRY_DELAYS_MS[index];
      // A 404 that is not the replication-lag code, or one that has outlasted
      // the ladder, is reported as an unconfirmed purge rather than thrown: the
      // object may be gone or may be lagging, and this run cannot tell which.
      if (delay === undefined || !isDirectoryReplicationLagError(error)) return { purged: false, retried };
      await sleep(delay);
      retried = true;
    }
  }
}

/**
 * Removes a server application and the per-site permission it was granted on
 * every site named.
 *
 * The order is forced rather than chosen. The permission entries are matched to
 * the application by app id, so every revoke has to happen while that identity
 * still exists; deleting first leaves entries naming an identity that is gone,
 * which is the residue this mode exists to stop producing. The purge is what
 * actually ends the credential's life: Entra's delete is a soft delete with a
 * 30 day restore window, so stopping at the delete schedules the removal rather
 * than performing it.
 *
 * Every site is read before anything is written. A deployment granted on
 * several sites would otherwise revoke the first site's entry and then fail to
 * resolve the third, leaving a partial teardown that a typo caused.
 */
export async function runDeleteServerApp(
  graph: SetupGraph,
  args: DeleteServerAppArgs,
  hooks: SetupHooks = {},
): Promise<DeleteServerAppOutcome> {
  const notice = hooks.onNotice ?? ((): void => {});
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const several = args.siteUrls.length > 1;

  const existing = await graph.findApplicationByDisplayName(args.displayName);
  if (existing === undefined) {
    // The outcome the operator asked for is already true. Nothing else in this
    // function can run without an app id to match a permission entry against.
    return { kind: "already-absent", displayName: args.displayName };
  }

  if (!args.hasGrantIssuer && !args.forceOrphan) {
    // Without a grant issuer the listing below cannot run, so this cannot know
    // whether a grant exists, and saying it does would assert something nobody
    // looked for. Checked before resolving any site, which this refusal does
    // not need.
    const where = several ? `any of ${listSiteUrls(args.siteUrls)}` : args.siteUrls[0];
    throw new Error(
      `Revoking a site permission needs a grant issuer's app-only token, and none was configured, so nothing ` +
        `was touched: application ${existing.appId} still exists, and whether it still holds a permission on ` +
        `${where} was not checked, because checking needs the grant issuer this run does not have. ` +
        "Create one with --create-bootstrap and re-run, or pass --force-orphan to delete and purge the " +
        "application anyway and leave any permission entry behind.",
    );
  }

  // With one site a raw Graph failure already names the only site there is,
  // and describeSetupFailure gives it the path-specific remedy and response
  // body it always has. With several, the operator has to be told which one
  // failed and that the earlier ones were only read, not changed.
  const readFailure = (step: string, siteUrl: string, error: unknown): unknown =>
    several
      ? new Error(
          `${step} ${siteUrl} failed, so nothing was changed: no permission was revoked on any site and ` +
            `application ${existing.appId} still exists. Every site is read before any is written, so a re-run ` +
            `after fixing this starts from the same point. Underlying failure: ${detail(error)}`,
          { cause: error },
        )
      : error;

  const sites: Array<{ siteUrl: string; siteId: string; permissionId: string | undefined }> = [];
  for (const siteUrl of args.siteUrls) {
    let siteId: string;
    try {
      // resolveSite takes the hostname-and-server-relative form, not the URL as
      // typed. runSetup builds it the same way; passing the raw URL yields a 400.
      ({ siteId } = await graph.resolveSite(siteIdPathFromUrl(siteUrl)));
    } catch (error) {
      throw readFailure("Resolving", siteUrl, error);
    }

    // The parser refuses the spellings it can see through, but Graph resolves
    // more than text comparison can, a percent encoded letter for one. Two
    // URLs for one site would revoke its entry and then fail on the second
    // attempt after the first had already written, so it is refused here,
    // while nothing has been written yet.
    const earlier = sites.find((site) => site.siteId === siteId);
    if (earlier !== undefined) {
      throw new Error(
        `${earlier.siteUrl} and ${siteUrl} name the same site, so nothing was changed: no permission was ` +
          `revoked on any site and application ${existing.appId} still exists. List each granted site once ` +
          "and run this again.",
      );
    }

    let permissionId: string | undefined;
    if (args.hasGrantIssuer) {
      try {
        const permissions = await graph.listSitePermissions(siteId);
        permissionId = permissions.find((entry) => entry.appIds.includes(existing.appId))?.permissionId;
      } catch (error) {
        throw readFailure("Listing the permissions on", siteUrl, error);
      }
    }

    sites.push({ siteUrl, siteId, permissionId });
  }

  if (!args.confirm) {
    return {
      kind: "planned",
      appId: existing.appId,
      objectId: existing.objectId,
      sites: sites.map(({ siteUrl, permissionId }) => ({ siteUrl, permissionId })),
      permissionsInspected: args.hasGrantIssuer,
    };
  }

  const revoked: string[] = [];
  const results: Array<{ siteUrl: string; permission: "revoked" | "already-gone" | "none" }> = [];
  for (const [index, site] of sites.entries()) {
    if (site.permissionId === undefined) {
      results.push({ siteUrl: site.siteUrl, permission: "none" });
      continue;
    }
    // Named by the site URL the operator typed, not by siteId: every other
    // message in this mode uses the URL, and mixing the two made stderr and
    // stdout read as though they were about two different sites.
    notice(`Revoking site permission ${site.permissionId} on ${site.siteUrl}.`);
    try {
      await graph.deleteSitePermission(site.siteId, site.permissionId);
    } catch (error) {
      // A 404 means the entry was gone before this revoke reached it, most
      // likely a concurrent run or a removal by hand since the listing. What
      // the operator asked for is true on this site, so the run carries on,
      // but this run did not remove it and records that it did not.
      if (statusOf(error) === 404) {
        results.push({ siteUrl: site.siteUrl, permission: "already-gone" });
        continue;
      }
      // The application is deliberately left in place. Its app id is the only
      // thing a re-run can match the remaining entries by, so deleting it now
      // would turn a recoverable stop into permanent residue on every site
      // after this one.
      const later = sites.slice(index + 1);
      const pending = later.filter((next) => next.permissionId !== undefined).map((next) => next.siteUrl);
      const empty = later.filter((next) => next.permissionId === undefined).map((next) => next.siteUrl);
      // The per-site lists only say something when there are other sites; with
      // one the message reads as a single-site teardown always has.
      const progress = several
        ? `Already revoked: ${revoked.length === 0 ? "none" : listSiteUrls(revoked)}. ` +
          `Not yet attempted: ${pending.length === 0 ? "none" : listSiteUrls(pending)}. ` +
          (empty.length === 0 ? "" : `Nothing to revoke on: ${listSiteUrls(empty)}. `)
        : "";
      throw new Error(
        `Revoking permission entry ${site.permissionId} on ${site.siteUrl} failed, so this run stopped there ` +
          `and did not delete the application: application ${existing.appId} still exists, and it is the only ` +
          `key a re-run has to find the remaining entries by. ${progress}` +
          "Re-running is safe: it reads every site again, revokes what is still there, then deletes and purges " +
          `the application. Underlying failure: ${detail(error)}`,
        // Preserved so describeSetupFailure can still reach the site
        // permissions remedy, which names the grant issuer's consent as the
        // likely cause of a 403 on this call.
        { cause: error },
      );
    }
    revoked.push(site.siteUrl);
    results.push({ siteUrl: site.siteUrl, permission: "revoked" });
  }

  notice(`Deleting application ${existing.appId} (object id ${existing.objectId}).`);
  let applicationDeleted = true;
  try {
    await graph.deleteApplication(existing.objectId);
  } catch (error) {
    if (statusOf(error) !== 404) {
      // The single-site wording is kept as it was. Several sites name which
      // ones were revoked, since those are the ones a re-run finds nothing on.
      const state =
        revoked.length === 0
          ? "No site permission was revoked, and the application still exists"
          : !several
            ? "The site permission was revoked, and the application still exists"
            : `The site permission${revoked.length === 1 ? "" : "s"} on ${listSiteUrls(revoked)} ` +
              `${revoked.length === 1 ? "was" : "were"} revoked, and the application still exists`;
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
  let purgeRetried: boolean;
  try {
    const purgeResult = await purgeDeletedApplicationWithRetry(graph, existing.objectId, sleep);
    purgeConfirmed = purgeResult.purged;
    purgeRetried = purgeResult.retried;
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
    sites: results,
    orphanedPermission: !args.hasGrantIssuer,
    applicationDeleted,
    purgeConfirmed,
    purgeRetried,
  };
}

export interface DeleteBootstrapArgs {
  displayName: string;
  confirm: boolean;
}

export type DeleteBootstrapOutcome =
  | { kind: "already-absent"; displayName: string }
  | { kind: "planned"; appId: string; objectId: string }
  | {
      kind: "deleted";
      appId: string;
      objectId: string;
      /**
       * Same meaning as runDeleteServerApp's own applicationDeleted: false
       * when deleteApplication answered 404, meaning the application was
       * already gone before this run's delete reached it, most likely a
       * concurrent teardown or a manual removal in the portal between the
       * lookup and this call. The outcome the operator asked for is still
       * true, but this run did not perform the delete and must not report
       * that it did.
       */
      applicationDeleted: boolean;
      /**
       * Same meaning as runDeleteServerApp's own purgeConfirmed: false when the
       * purge kept answering 404 through the replication-lag retry, which is
       * not proof the object is gone. The grant issuer holds the broader of
       * the two permissions this project isolates, so understating what this
       * run actually observed here is the worse of the two places to get it
       * wrong.
       */
      purgeConfirmed: boolean;
      /**
       * Same meaning as runDeleteServerApp's own purgeRetried: true only when
       * the ladder actually slept at least once. A 404 that never matched
       * Request_ResourceNotFound gives up after one attempt with no sleep at
       * all, and the formatter must not tell the operator lag was ruled out
       * on a run that never tested for it.
       */
      purgeRetried: boolean;
    };

/**
 * Removes the grant issuer. Deleting it is what actually removes the standing
 * privilege: the secret's expiry only disables one credential, while the
 * application keeps its admin-consented Sites.FullControl.All assignment and
 * anyone able to add a secret would regain tenant-wide SharePoint access
 * without further consent.
 *
 * Confirmed deletion purges the application from the tenant's deleted items
 * afterward, the same way runDeleteServerApp does for the server application,
 * and for the same reason: Entra's delete is a soft delete with a 30 day
 * restore window, so stopping at the delete schedules the removal of a
 * tenant-wide credential rather than performing it, and the grant issuer
 * holds the broader of the two permissions this project isolates. It reuses
 * purgeDeletedApplicationWithRetry unchanged, since the race it retries, a
 * purge landing before the delete has replicated through the directory, is
 * identical here.
 *
 * Purging is irreversible and, unlike the delete alone, cannot be undone by
 * recreating the application under the same name: a fresh --create-bootstrap
 * run mints a new object id and a new secret, not the one just purged. Dry
 * run is therefore the default here too, matching --delete-server-app: without
 * --confirm this resolves the application and reports what would be removed,
 * issuing no destructive call.
 *
 * A delete that answers 404 is tolerated, not thrown, and still falls through
 * to the purge, mirroring runDeleteServerApp's own applicationDeleted
 * handling. Stopping at a delete-404 would have reproduced this command's own
 * founding bug (docs/OPEN-ITEMS.md: an already-absent target reported as a
 * failure) in a narrower window, and would have skipped the purge on exactly
 * the run most likely to find an unpurged, still credentialed object already
 * sitting in deleted items.
 */
export async function runDeleteBootstrap(
  graph: SetupGraph,
  args: DeleteBootstrapArgs,
  hooks: SetupHooks = {},
): Promise<DeleteBootstrapOutcome> {
  const notice = hooks.onNotice ?? ((): void => {});
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const existing = await graph.findApplicationByDisplayName(args.displayName);
  if (existing === undefined) {
    // Absent is the outcome the operator asked for, not a failure, on either
    // arm: there is nothing to plan or to delete either way. Reporting it as a
    // failure made a correctly torn-down tenant indistinguishable from a
    // broken one, so a script enforcing teardown across tenants would retry or
    // alert on a tenant that was already finished.
    return { kind: "already-absent", displayName: args.displayName };
  }

  if (!args.confirm) {
    return { kind: "planned", appId: existing.appId, objectId: existing.objectId };
  }

  notice(`Deleting application ${existing.appId} (object id ${existing.objectId}).`);
  let applicationDeleted = true;
  try {
    await graph.deleteApplication(existing.objectId);
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
    // A 404 here is this command's own founding bug in a narrower window: an
    // already-absent grant issuer must report the finished state, not a
    // failure, and a concurrent or manual removal between the lookup above
    // and this call produces the identical situation. Falling through to the
    // purge below rather than stopping here matters more than the wording
    // does: a delete-404 is exactly the case where a soft-deleted, still
    // credentialed grant issuer is most likely already sitting in deleted
    // items unpurged, which is the state this whole change exists to end.
    // Mirrors runDeleteServerApp's own applicationDeleted handling above.
    applicationDeleted = false;
  }

  notice(`Purging application ${existing.objectId} from deleted items.`);
  let purgeConfirmed: boolean;
  let purgeRetried: boolean;
  try {
    const purgeResult = await purgeDeletedApplicationWithRetry(graph, existing.objectId, sleep);
    purgeConfirmed = purgeResult.purged;
    purgeRetried = purgeResult.retried;
  } catch (error) {
    // Unlike a failed delete above, re-running does not retry this: the
    // application is now soft-deleted, which findApplicationByDisplayName's
    // own lookup (GET /applications) does not return, so a re-run reports
    // already-absent and never calls purgeDeletedApplication again. The fix
    // is a manual purge, not another run of this command. Mirrors the
    // equivalent failure in runDeleteServerApp above, with the credential's
    // own permission named rather than left generic, since it is the broader
    // of the two this project isolates.
    throw new Error(
      `Application ${existing.appId} was deleted, but purging it from deleted items failed, so it is ` +
        "soft-deleted rather than gone: the object stays in the tenant's deleted items for 30 days and " +
        "anyone who can restore it gets its Sites.FullControl.All permission back with it. Re-running this " +
        "command will not retry the purge, because the lookup this command uses to find the application does " +
        "not return a soft-deleted one, so a re-run reports it already absent. Purge it by hand: " +
        `DELETE /directory/deletedItems/${existing.objectId}, using the operator's own delegated token. ` +
        `Underlying failure: ${detail(error)}`,
      { cause: error },
    );
  }

  return {
    kind: "deleted",
    appId: existing.appId,
    objectId: existing.objectId,
    applicationDeleted,
    purgeConfirmed,
    purgeRetried,
  };
}
