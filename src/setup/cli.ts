// Pure CLI-parsing and message-formatting logic for the setup command, kept
// separate from main.ts so it can be unit tested without a live tenant. The
// network calls (device-code sign-in, the client-credentials exchange) stay
// in main.ts, which is the untestable-without-a-tenant seam.

export interface ParsedArgs {
  tenantId: string;
  siteUrl: string;
  displayName: string;
  write: boolean;
  clientId: string;
}

const DEFAULT_DISPLAY_NAME = "Ironwright Repository Reconciliation";

// The Azure CLI's own public client id. It is pre-consented in every tenant,
// which is what makes the zero-setup path possible: a user can sign in and
// create an app registration without anyone first creating a bootstrap app to
// sign in with. Documented in docs/SETUP.md, including that some tenants
// block it with Conditional Access and that --client-id lets a caller
// substitute their own bootstrap app registration instead.
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

export function parseArgs(argv: string[]): ParsedArgs {
  return {
    tenantId: requiredValue(argv, "tenant"),
    siteUrl: requiredValue(argv, "site"),
    displayName: findValue(argv, "name") ?? DEFAULT_DISPLAY_NAME,
    write: argv.includes("--write"),
    clientId: findValue(argv, "client-id") ?? DEFAULT_DEVICE_CODE_CLIENT_ID,
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
    "If your tenant blocks the Azure CLI's public client id with Conditional Access, " +
    "register a bootstrap app registration with public client flows enabled and pass its " +
    "application id with --client-id=<your-app-id>. See docs/SETUP.md for details."
  );
}
