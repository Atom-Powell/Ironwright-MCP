// Pure CLI-parsing and message-formatting logic for the setup command, kept
// separate from main.ts so it can be unit tested without a live tenant. The
// network calls (device-code sign-in, the client-credentials exchange) stay
// in main.ts, which is the untestable-without-a-tenant seam.

import { SetupFailedError } from "./errors.js";
import { GraphRequestError } from "./graph-error.js";
import { BOOTSTRAP_SECRET_LIFETIME_DAYS } from "./steps.js";

export interface ParsedArgs {
  tenantId: string;
  siteUrl: string;
  displayName: string;
  write: boolean;
  clientId: string;
  createBootstrap: boolean;
  deleteBootstrap: boolean;
  bootstrap: BootstrapCredentials | undefined;
}

const DEFAULT_DISPLAY_NAME = "Ironwright Repository Reconciliation";

// Bootstrap mode gets its own default rather than reusing the one above. Two
// applications with the same display name, one holding Sites.FullControl.All
// and one holding Sites.Selected, is how the wrong secret gets rotated or the
// wrong application revoked, and the tenant's app list shows little else.
const DEFAULT_BOOTSTRAP_DISPLAY_NAME = "Ironwright Grant Issuer";

// Microsoft's own Graph Command Line Tools application, the public client that
// Microsoft Graph PowerShell and the Graph CLI sign in as. It exists in every
// tenant, so nobody has to register a public-client sign-in application of
// their own before running this command, but it is consented per scope rather
// than pre-consented: an administrator may see a one-time consent prompt on
// first use, and this application's name is what shows up in the tenant's
// sign-in logs afterward. Anyone who would rather not consent a Microsoft
// first-party application can pass --client-id pointing at their own
// public-client app registration. That is a different thing from the bootstrap
// application, which is the confidential client that issues site permission
// grants and can carry no interactive sign-in at all. Documented in
// docs/SETUP.md, including the Conditional Access case.
export const DEFAULT_DEVICE_CODE_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";

// A present-but-empty value (--tenant=, or a variable that expanded to
// nothing) is treated the same as an absent one. Proceeding with an empty
// string would fail confusingly, much later, against Graph or Entra rather
// than here where the cause is obvious.
function findValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  if (found === undefined) return undefined;
  const value = found.slice(prefix.length);
  return value === "" ? undefined : value;
}

function requiredValue(argv: string[], name: string): string {
  const value = findValue(argv, name);
  if (value === undefined) throw new Error(`missing required argument --${name}=<value>`);
  return value;
}

export interface BootstrapCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * The environment is the documented path because these are the credentials of an
 * application holding Sites.FullControl.All over every site in the tenant, and a
 * command-line flag puts that secret in shell history. Flags exist as a
 * documented fallback for a caller that already manages secrets another way.
 */
export function resolveBootstrapCredentials(
  argv: string[],
  env: NodeJS.ProcessEnv,
): BootstrapCredentials | undefined {
  const clientId = findValue(argv, "bootstrap-client-id") ?? emptyToUndefined(env.IW_BOOTSTRAP_CLIENT_ID);
  const clientSecret =
    findValue(argv, "bootstrap-client-secret") ?? emptyToUndefined(env.IW_BOOTSTRAP_CLIENT_SECRET);
  if (clientId === undefined || clientSecret === undefined) return undefined;
  return { clientId, clientSecret };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  const createBootstrap = argv.includes("--create-bootstrap");
  const deleteBootstrap = argv.includes("--delete-bootstrap");

  // Creating and deleting the grant issuer are opposite acts on the same
  // application. Letting one silently win when both flags are given is how an
  // operator deletes the grant issuer they meant to create, or recreates the
  // one they meant to tear down, with no indication either happened.
  if (createBootstrap && deleteBootstrap) {
    throw new Error(
      "--create-bootstrap and --delete-bootstrap cannot be used together. Run one, confirm its result, then run " +
        "the other if you still need to.",
    );
  }

  // Neither bootstrap mode names a site: creation has none yet to onboard, and
  // deletion acts on the grant issuer application itself, not on any site it
  // was ever used against.
  const bootstrapMode = createBootstrap || deleteBootstrap;

  return {
    tenantId: requiredValue(argv, "tenant"),
    siteUrl: bootstrapMode ? (findValue(argv, "site") ?? "") : requiredValue(argv, "site"),
    displayName:
      findValue(argv, "name") ?? (bootstrapMode ? DEFAULT_BOOTSTRAP_DISPLAY_NAME : DEFAULT_DISPLAY_NAME),
    write: argv.includes("--write"),
    clientId: findValue(argv, "client-id") ?? DEFAULT_DEVICE_CODE_CLIENT_ID,
    createBootstrap,
    deleteBootstrap,
    bootstrap: resolveBootstrapCredentials(argv, env),
  };
}

interface TokenErrorBody {
  error?: string;
  error_description?: string;
}

/**
 * Turns the client-credentials token response into an access token or a
 * message that names the real cause. Entra returns a 400 or 401 with an
 * error and error_description on the very first call right after the app's
 * secret is created, if propagation has not finished yet, and a generic
 * "no access token" message would send whoever hits that back to Graph
 * documentation instead of to the actual, already-explained cause.
 */
export function extractAccessToken(status: number, text: string): string {
  let body: TokenErrorBody & { access_token?: string } = {};
  try {
    body = text.length > 0 ? (JSON.parse(text) as typeof body) : {};
  } catch {
    // Entra normally returns JSON even on failure. Tolerate a non-JSON body
    // rather than letting JSON.parse's own error hide the real status.
  }

  if (status >= 200 && status < 300 && body.access_token !== undefined) {
    return body.access_token;
  }

  if (body.error_description !== undefined) {
    throw new Error(`client credentials request failed with ${status}: ${body.error_description}`);
  }

  throw new Error(`client credentials request failed with ${status}: ${text}`);
}

// The two Entra codes that a correct setup produces anyway when the credential
// being exchanged was just created: 7000215 for a secret that has not
// replicated to the token endpoint yet, and 700016 for a service principal in
// the same state. Nothing else is retried, because every other cause is a real
// configuration error that more attempts cannot fix.
const PROPAGATION_TOKEN_ERROR_CODES = ["AADSTS7000215", "AADSTS700016"] as const;

// Three attempts across roughly ten seconds. A genuinely wrong secret also
// returns 7000215, so the retry is bounded: it has to outlast replication
// without turning a wrong credential into a hang.
const DEFAULT_RETRY_DELAYS_MS = [3000, 6000] as const;

export interface RetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

function isPropagationTokenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return PROPAGATION_TOKEN_ERROR_CODES.some((code) => message.includes(code));
}

export async function acquireTokenWithRetry(
  attempt: () => Promise<string>,
  options: RetryOptions = {},
): Promise<string> {
  const delaysMs = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      const delay = delaysMs[index];
      if (delay === undefined || !isPropagationTokenError(error)) throw error;
      await sleep(delay);
    }
  }
}

/**
 * Wraps an async factory so it runs at most one time per process. Used for the
 * bootstrap application's token, which the preflight, the per-site grant, and
 * that grant's rollback delete all need: minting it once takes a normal run
 * from three tenant-wide-privileged tokens down to one, and the fewer of those
 * that exist, the less there is to leak or to have to reason about. There is no
 * lifetime here on purpose. A run lasts seconds and a token lasts an hour, so a
 * cache with an expiry would be machinery for a case that cannot arise.
 */
export function once<T>(factory: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    // The promise is stored, not the resolved value, so callers that overlap
    // share one acquisition rather than starting a second.
    pending ??= factory();
    return pending;
  };
}

/**
 * A failed or cancelled device-code sign-in is the one failure mode this
 * project's own documentation calls out by name: a tenant's Conditional
 * Access policy blocking the default client id. Naming the --client-id
 * escape hatch here, instead of letting the credential's own error surface
 * alone, is what turns a stack trace back into an actionable next step.
 */
export function describeSignInFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    `Sign-in failed: ${detail} ` +
    "If your tenant blocks Microsoft's Graph Command Line Tools client id with Conditional Access, " +
    "register a public-client sign-in application of your own, with public client flows enabled, and pass its " +
    "application id with --client-id=<your-app-id>. That is not the bootstrap application: the bootstrap " +
    "application is a confidential client that issues site permission grants and cannot carry a device-code " +
    "sign-in. See docs/SETUP.md for details."
  );
}

/**
 * The full `--create-bootstrap` success block, printed on stdout. A pure
 * function, rather than inline console.log calls in main.ts, so its wording
 * can be pinned by a test.
 *
 * The secret's expiry is stated here because this block is the only place
 * IW_BOOTSTRAP_CLIENT_SECRET is ever shown; docs/SETUP.md covers the expiry
 * too, but an operator who copies the value straight from the terminal has no
 * reason to go read it there first.
 *
 * The consent sentence is not a "still needs consent" notice: for an
 * application permission, the appRoleAssignedTo call runCreateBootstrap just
 * made *is* admin consent, and it only succeeds for a signed-in Privileged
 * Role Administrator or Global Administrator in the first place. If this
 * prints at all, that call already succeeded, so the permission is already
 * usable.
 */
export function describeBootstrapSuccess(result: { appId: string; secret: string }): string {
  return (
    "Bootstrap application created. Store these as the grant-issuing application's credentials, not in the " +
    "repository.\n" +
    `  IW_BOOTSTRAP_CLIENT_ID=${result.appId}\n` +
    `  IW_BOOTSTRAP_CLIENT_SECRET=${result.secret}\n` +
    `This secret expires in ${BOOTSTRAP_SECRET_LIFETIME_DAYS} days; recreate it with --create-bootstrap when it ` +
    "does. Its Sites.FullControl.All application permission is already admin-consented: the role assignment this " +
    "command just made is what performs that for an application permission, so there is no separate consent step " +
    "to do in the portal. Set the two values above and run this command again without --create-bootstrap."
  );
}

/**
 * The full `--delete-bootstrap` success block, printed on stdout. A pure
 * function for the same reason describeBootstrapSuccess above is one: so its
 * wording can be pinned by a test.
 *
 * Deletion, not the secret's own seven-day expiry, is what this command can
 * actually claim removed the standing privilege: deleteApplication succeeding
 * means Graph has removed the application object, and with it every role
 * assignment it held, including Sites.FullControl.All. An expired secret only
 * disables one credential and leaves that assignment, and the application
 * that carries it, in place for anyone able to add a new secret.
 *
 * That claim still needs a caveat DELETE /applications does not remove: Graph
 * soft-deletes an application, holding it in the tenant's deleted items for
 * 30 days where the same Application Administrator rights this command
 * needed can restore it. This paragraph reads as the answer to a client
 * security review, and a 30-day restore window is exactly the kind of thing
 * that review would ask about, so it names the window and the permanent purge
 * available for it, rather than leaving deletion sounding more final than it
 * is in the live directory.
 *
 * It also names the one piece of operator cleanup this command cannot do
 * itself: IW_BOOTSTRAP_CLIENT_ID and IW_BOOTSTRAP_CLIENT_SECRET, wherever they
 * were stored, now name an application that no longer exists. Left in place,
 * a later normal run picks them up and fails at its preflight with a
 * rejected-credentials message that reads like a wrong secret, not a deleted
 * application, which sends whoever hits it after the wrong cause entirely.
 */
export function describeDeleteBootstrapSuccess(result: { appId: string }): string {
  return (
    `Deleted application ${result.appId}. That removes the standing Sites.FullControl.All permission it held, not ` +
    "just its secret: a deleted application keeps no access, where an expired secret alone would not have. This " +
    "delete is a soft delete in the directory: the application is recoverable for 30 days by anyone with the same " +
    "Application Administrator rights this command needed, so if that recovery window matters, for example ahead " +
    "of a client security review, purge it permanently from deleted items in the Entra admin portal rather than " +
    "relying on this deletion alone. Remove IW_BOOTSTRAP_CLIENT_ID and IW_BOOTSTRAP_CLIENT_SECRET from wherever " +
    "they were stored: they now name an application that no longer exists, and a later run that still reads them " +
    "will fail with a rejected-credentials message that reads like a wrong secret rather than a deleted " +
    "application. Onboarding another site later needs a grant issuer again, so run this command with " +
    "--create-bootstrap first."
  );
}

// Identical on both the confirmed and unconfirmed arm. Only the clause naming
// whether the grant issuer is still needed for this site differs between the
// two; every claim after it is true regardless of whether verification could
// confirm access, so there is no reason for it to read differently.
const GRANT_ISSUER_TEARDOWN_TAIL =
  "Only deleting it removes that standing permission: letting its secret expire disables a credential, not the " +
  "application or the permission it holds. Run this command with --delete-bootstrap to delete it. Onboarding " +
  "another site later needs a grant issuer again, so recreate it first with --create-bootstrap.";

/**
 * The closing note printed after a normal run's four deployment values, on
 * both the confirmed and the unconfirmed verification path. It is not a
 * separate success message: describeSetupSuccess below appends it to the one
 * tail both paths already share, so this function carries no result data of
 * its own beyond which arm printed it.
 *
 * It prints while the grant issuer certainly still exists, so every sentence
 * states what deleting it would do rather than claiming anything has already
 * happened. It also draws the same line describeDeleteBootstrapSuccess draws:
 * the secret's own seven-day expiry disables a credential, not the
 * application or the Sites.FullControl.All assignment it holds, so only
 * deletion removes the standing privilege. Collapsing that distinction here
 * is a mistake this module has made before.
 *
 * The `confirmed` flag matters because only two of the opening sentence's
 * three claims are actually observed at this point in the run: that the
 * grant issuer still exists, and that it still holds Sites.FullControl.All,
 * both established by this same execution's own preflight. Whether it is "no
 * longer needed for this site" is not observed on the unconfirmed arm, since
 * that arm exists precisely because the run could not prove the new
 * application can reach the site. Asserting it anyway told an operator to
 * destroy the one credential able to reissue the per-site grant, in the same
 * breath as a message four lines above saying that credential might still be
 * needed.
 */
export function describeGrantIssuerTeardownNote(confirmed: boolean): string {
  const openingClause = confirmed
    ? "The grant issuer application is not needed for this site any longer, but it still exists and still holds " +
      "Sites.FullControl.All across every site in this tenant."
    : "This site's access has not been confirmed yet, and the grant issuer is the only credential that can " +
      "reissue the per-site grant, so deleting it should wait until this application's own access is confirmed. " +
      "It still exists and still holds Sites.FullControl.All across every site in this tenant.";

  return `${openingClause} ${GRANT_ISSUER_TEARDOWN_TAIL}`;
}

export interface SetupSuccessDetails {
  /** Whether verifyAppAccess could confirm the new application can reach the site. */
  confirmed: boolean;
  /**
   * Present only when confirmed is false: the reason verification could not
   * confirm access, already formatted by interpretVerification.
   */
  verificationMessage?: string;
  tenantId: string;
  appId: string;
  secret: string;
  siteId: string;
}

/**
 * The full success block for a normal run, printed on stdout, covering both
 * the confirmed and unconfirmed verification path. A pure function, rather
 * than a sequence of console.log calls in main.ts, so the teardown note's
 * position relative to the four printed values, and its wording on each arm,
 * can both be pinned by a test without running main.ts itself.
 *
 * The four deployment values come last among the "what happened" lines, and
 * the teardown note comes after those, not before: someone scrolling back for
 * the secret should not have to read past advice to find it.
 */
export function describeSetupSuccess(details: SetupSuccessDetails): string {
  const lines: string[] = [];

  if (details.confirmed) {
    lines.push("Setup complete. Store these as deployment secrets, not in the repository.");
  } else {
    // An unconfirmed verification prints the credentials exactly as a success
    // does, because the application and its grant are live either way and the
    // secret is shown once. What changes is that the operator has to be told a
    // run that could not confirm access still left both behind.
    lines.push(
      "Setup finished without confirming access. It kept what it created: the app registration, its client " +
        "secret, and the per-site permission grant are all live in this tenant now, and no second run is needed.",
    );
    if (details.verificationMessage !== undefined) lines.push(details.verificationMessage);
    lines.push("Store these as deployment secrets, not in the repository.");
  }

  lines.push(`  AZURE_TENANT_ID=${details.tenantId}`);
  lines.push(`  AZURE_CLIENT_ID=${details.appId}`);
  lines.push(`  AZURE_CLIENT_SECRET=${details.secret}`);
  lines.push(`  IW_SITE_ID=${details.siteId}`);
  lines.push(describeGrantIssuerTeardownNote(details.confirmed));

  return lines.join("\n");
}

/**
 * True for the two calls that use the bootstrap application's app-only token
 * rather than the signed-in operator's: grantSitePermission's POST and
 * deleteSitePermission's rollback DELETE, both against
 * /sites/{site-id}/permissions[/{permission-id}]. A failure on this path
 * family is never about the signed-in operator's directory roles or about
 * site ownership, because the operator's token never reaches this endpoint.
 */
function isSitePermissionsPath(path: string): boolean {
  return /^\/sites\/[^/]+\/permissions(\/[^/]+)?$/.test(path);
}

// Matches DELETE /applications/{id} (deleteApplication) but not POST
// /applications (createApplication, no id segment) or
// /applications/{id}/addPassword (an extra segment). Method is checked by the
// caller, not here, because the same path shape never arises for any other
// verb this command issues.
function isApplicationObjectPath(path: string): boolean {
  return /^\/applications\/[^/]+$/.test(path);
}

function nextStepForGraphFailure(error: GraphRequestError): string {
  if (error.status === 403 && error.path.endsWith("/appRoleAssignedTo")) {
    return (
      "This is the admin consent step. Granting admin consent for a Microsoft Graph application permission needs " +
      "Privileged Role Administrator or Global Administrator: the Application Administrator role can consent to " +
      "every API except Microsoft Graph."
    );
  }

  // Site owner rights are not a cause here, and have not been since the
  // per-site grant and its rollback moved to the bootstrap application's
  // token: the signed-in operator's token never reaches this endpoint, so a
  // 403 here says something about that application, not about this person.
  if (error.status === 403 && isSitePermissionsPath(error.path)) {
    return (
      "This call runs on the bootstrap application's own token, not the signed-in user's, so it is not about the " +
      "signed-in user's directory roles or about site ownership. The likely cause is that the bootstrap " +
      "application's Sites.FullControl.All permission is not admin-consented in this tenant, or that consent " +
      "granted moments earlier by --create-bootstrap has not yet reached a freshly issued token. Confirm " +
      "IW_BOOTSTRAP_CLIENT_ID and IW_BOOTSTRAP_CLIENT_SECRET name a bootstrap application created with " +
      "--create-bootstrap, and if the permission is already consented, wait a short while and try again."
    );
  }

  // DELETE /applications/{id} is issued by --delete-bootstrap and by every
  // rollback that removes an application, never by a create step, so a 403
  // here is a refused deletion, not a refused creation. The generic 403
  // branch below said "Creating the app registration and its service
  // principal needs Application Administrator", which named the wrong verb
  // on this path family even though the role it names happens to be right;
  // docs/SETUP.md draws the same distinction for the same reason: deleting is
  // a directory-object operation with no consent step, so it needs only
  // Application Administrator, never Privileged Role Administrator or Global
  // Administrator the way the create-and-consent steps do.
  if (error.status === 403 && error.method === "DELETE" && isApplicationObjectPath(error.path)) {
    return (
      "The signed-in user is not allowed to delete this application registration. Deleting one needs Application " +
      "Administrator or Cloud Application Administrator rights over it; no admin consent is involved in deleting, " +
      "so Privileged Role Administrator or Global Administrator is not required for this step."
    );
  }

  if (error.status === 403) {
    return (
      "The signed-in user is not allowed to do this. Creating the app registration and its service principal needs " +
      "Application Administrator or Cloud Application Administrator."
    );
  }

  // Same reasoning as the 403 branch above: this endpoint never sees the
  // signed-in operator's token, so "sign in again" would send them to fix the
  // wrong credential.
  if (error.status === 401 && isSitePermissionsPath(error.path)) {
    return (
      "The bootstrap application's token was rejected. Check that IW_BOOTSTRAP_CLIENT_ID and " +
      "IW_BOOTSTRAP_CLIENT_SECRET are correct and belong to a bootstrap application created with --create-bootstrap."
    );
  }

  if (error.status === 401) {
    return "The signed-in token was rejected. Sign in again.";
  }

  // Same reasoning as the 403 and 401 branches above, and for the same
  // underlying reason interpretVerification's own 404 remedy was rewritten:
  // this call runs after resolveSite already proved the site URL correct, so
  // a 404 here is not that. Graph can mask a site an application cannot see
  // as 404 rather than 403, which the 403 branch above already names as the
  // likely cause for this exact path family.
  if (error.status === 404 && isSitePermissionsPath(error.path)) {
    return (
      "This call runs on the bootstrap application's own token, and this run already resolved this exact site " +
      "with the signed-in user's token earlier, so this is not evidence the site URL is wrong. Graph can return " +
      "404, not 403, when an application lacks access to a site it cannot see. The likely cause is the same as a " +
      "403 here: the bootstrap application's Sites.FullControl.All permission is not admin-consented in this " +
      "tenant, or consent granted moments earlier by --create-bootstrap has not yet reached a freshly issued " +
      "token. Confirm IW_BOOTSTRAP_CLIENT_ID and IW_BOOTSTRAP_CLIENT_SECRET name a bootstrap application created " +
      "with --create-bootstrap, and if the permission is already consented, wait a short while and try again."
    );
  }

  // The generic branch below blames the site URL, which does not exist on
  // this call at all: DELETE /applications/{id} names an object id, not a
  // site. A 404 here most likely means the application was already removed,
  // for instance by a concurrent teardown, or that the object id is stale.
  if (error.status === 404 && error.method === "DELETE" && isApplicationObjectPath(error.path)) {
    return (
      "The application registration was not found. It may already have been deleted, including by a concurrent " +
      "run, or the object id no longer names an application in this tenant."
    );
  }

  if (error.status === 404) {
    return "Check the site URL, including its /sites/ segment.";
  }

  if (error.status === 429 || (error.status >= 500 && error.status < 600)) {
    return "This looks like throttling or a transient server-side failure, so a retry may succeed.";
  }

  return "This does not match a known cause, so report it with the response body above.";
}

/** Which of the three modes main.ts was running when a failure reached the top level. */
export type SetupMode = "setup" | "create-bootstrap" | "delete-bootstrap";

// One command with three modes, and only one of them is actually "setup": a
// teardown refusal prefixed "Setup failed" reads as though the normal run
// failed, when nothing was being set up at all. --create-bootstrap creates
// rather than tears down, so it gets its own prefix for the same reason.
function failurePrefix(mode: SetupMode): string {
  switch (mode) {
    case "create-bootstrap":
      return "Bootstrap creation failed";
    case "delete-bootstrap":
      return "Bootstrap deletion failed";
    case "setup":
      return "Setup failed";
  }
}

/**
 * The last stop before the process exits. Without it any failure that is not a
 * SetupFailedError reaches the top-level await unhandled and prints a raw stack
 * trace, which covers the likeliest failure of all: a 403 from POST
 * /applications because the signed-in user has no rights to create one. Nothing
 * here reads error.stack, so no filesystem path reaches the terminal.
 *
 * `mode` defaults to "setup" because most callers of this function, including
 * every existing test, are exercising the normal run; main.ts passes the mode
 * it actually parsed, which is the only way this function can know a run was
 * a teardown rather than a setup, since parseArgs can itself throw before any
 * mode is known.
 */
export function describeSetupFailure(error: unknown, mode: SetupMode = "setup"): string {
  const prefix = failurePrefix(mode);

  if (error instanceof SetupFailedError) {
    return `${prefix}: ${error.message}`;
  }

  if (error instanceof GraphRequestError) {
    const code = error.code === undefined ? "" : ` (${error.code})`;
    return (
      `${prefix}: Graph ${error.method} ${error.path} returned ${error.status}${code}. ` +
      `${nextStepForGraphFailure(error)} Response body: ${error.body}`
    );
  }

  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
