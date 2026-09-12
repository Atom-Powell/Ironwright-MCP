// Pure CLI-parsing and message-formatting logic for the setup command, kept
// separate from main.ts so it can be unit tested without a live tenant. The
// network calls (device-code sign-in, the client-credentials exchange) stay
// in main.ts, which is the untestable-without-a-tenant seam.

import { SetupFailedError } from "./errors.js";
import { GraphRequestError } from "./graph-error.js";

export interface ParsedArgs {
  tenantId: string;
  siteUrl: string;
  displayName: string;
  write: boolean;
  clientId: string;
  createBootstrap: boolean;
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
  return {
    tenantId: requiredValue(argv, "tenant"),
    siteUrl: createBootstrap ? (findValue(argv, "site") ?? "") : requiredValue(argv, "site"),
    displayName: findValue(argv, "name") ?? (createBootstrap ? DEFAULT_BOOTSTRAP_DISPLAY_NAME : DEFAULT_DISPLAY_NAME),
    write: argv.includes("--write"),
    clientId: findValue(argv, "client-id") ?? DEFAULT_DEVICE_CODE_CLIENT_ID,
    createBootstrap,
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

// The two Entra codes that a correct setup produces anyway, because this token
// request runs seconds after the secret and the service principal were created:
// 7000215 for a secret that has not replicated to the token endpoint yet, and
// 700016 for a service principal in the same state. Nothing else is retried,
// because every other cause is a real configuration error that more attempts
// cannot fix.
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

  if (error.status === 404) {
    return "Check the site URL, including its /sites/ segment.";
  }

  if (error.status === 429 || (error.status >= 500 && error.status < 600)) {
    return "This looks like throttling or a transient server-side failure, so a retry may succeed.";
  }

  return "This does not match a known cause, so report it with the response body above.";
}

/**
 * The last stop before the process exits. Without it any failure that is not a
 * SetupFailedError reaches the top-level await unhandled and prints a raw stack
 * trace, which covers the likeliest failure of all: a 403 from POST
 * /applications because the signed-in user has no rights to create one. Nothing
 * here reads error.stack, so no filesystem path reaches the terminal.
 */
export function describeSetupFailure(error: unknown): string {
  if (error instanceof SetupFailedError) {
    return `Setup failed: ${error.message}`;
  }

  if (error instanceof GraphRequestError) {
    const code = error.code === undefined ? "" : ` (${error.code})`;
    return (
      `Setup failed: Graph ${error.method} ${error.path} returned ${error.status}${code}. ` +
      `${nextStepForGraphFailure(error)} Response body: ${error.body}`
    );
  }

  return `Setup failed: ${error instanceof Error ? error.message : String(error)}`;
}
