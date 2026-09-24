import { appRolesFromAccessToken } from "./roles.js";

export interface TokenProvider {
  getToken(): Promise<string>;
}

export interface ClientCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface TokenProviderOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Refresh this far before the stated expiry, so a token cannot expire in flight. */
  skewSeconds?: number;
}

/**
 * The body is carried but the credential never is. An operator pasting a failure
 * into a ticket must not paste the client secret with it, and the token endpoint
 * echoes enough in `error_description` to diagnose without it.
 */
export class TokenRequestError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(args: { status: number; body: string }) {
    super(
      `Acquiring a Microsoft Graph token failed with ${args.status}. ` +
        "This is about the server application's own client id and secret, not about the site " +
        `or the signed-in operator. Response: ${args.body}`,
    );
    this.name = "TokenRequestError";
    this.status = args.status;
    this.body = args.body;
  }
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export function clientCredentialsTokenProvider(
  credentials: ClientCredentials,
  options: TokenProviderOptions = {},
): TokenProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const skewMs = (options.skewSeconds ?? 120) * 1000;
  const endpoint = `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`;

  let cached: CachedToken | undefined;
  // A cold start fans out: the drive resolution and the first delta page can ask
  // at the same moment. Without this they mint two tokens and the second
  // overwrites the first for no benefit.
  let inFlight: Promise<CachedToken> | undefined;

  async function request(): Promise<CachedToken> {
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    });

    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    const text = await response.text();
    if (!response.ok) throw new TokenRequestError({ status: response.status, body: text });

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `The token endpoint returned ${response.status} with a body that is not JSON. ` +
          "Something other than Entra answered this request.",
      );
    }

    const token = (parsed as { access_token?: unknown }).access_token;
    const expiresIn = (parsed as { expires_in?: unknown }).expires_in;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(`The token endpoint returned ${response.status} with no access_token.`);
    }

    // An absent expires_in is treated as the shortest lifetime Entra issues
    // rather than as forever, because caching a token past its life produces a
    // 401 on a call that has nothing to do with authentication.
    const lifetimeSeconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 600;
    return { token, expiresAtMs: now() + lifetimeSeconds * 1000 };
  }

  return {
    async getToken(): Promise<string> {
      if (cached !== undefined && now() < cached.expiresAtMs - skewMs) return cached.token;

      inFlight ??= request();
      try {
        cached = await inFlight;
        return cached.token;
      } finally {
        // Cleared on both paths: a cached rejection would make one outage
        // permanent for the life of the process.
        inFlight = undefined;
      }
    },
  };
}

/**
 * The one application role the server's own token may carry. Anything more
 * defeats the least-privilege boundary the Decision Record rests on: a Microsoft
 * Q&A moderator answered, as by design, that an application holding
 * Sites.Selected alongside Files.Read.All or User.Read.All could read sites it
 * was never granted.
 */
export const SERVER_TOKEN_ROLES = ["Sites.Selected"] as const;

/**
 * A token was minted whose application roles are not the expected set, so the
 * server refused to use it. `found` is undefined when the token could not be
 * read at all, which is refused rather than trusted: a check that fails open is
 * not a check.
 */
export class UnexpectedTokenRolesError extends Error {
  readonly found: string[] | undefined;
  readonly extra: string[];
  readonly missing: string[];

  constructor(args: { found: string[] | undefined; extra: string[]; missing: string[] }) {
    super(describeRoleMismatch(args));
    this.name = "UnexpectedTokenRolesError";
    this.found = args.found;
    this.extra = args.extra;
    this.missing = args.missing;
  }
}

function describeRoleMismatch(args: { found: string[] | undefined; extra: string[]; missing: string[] }): string {
  const refusal = "The server refused to use it, and made no Microsoft Graph request with it.";
  if (args.found === undefined) {
    return `The server application's Graph token could not be read, so its permissions could not be checked. ${refusal}`;
  }
  if (args.found.length === 0) {
    return (
      "The server application's Graph token carries no application permissions, so its Sites.Selected " +
      `permission is probably not admin-consented. ${refusal}`
    );
  }
  const parts: string[] = [];
  if (args.extra.length > 0) parts.push(`permissions beyond Sites.Selected: ${args.extra.join(", ")}`);
  if (args.missing.length > 0) parts.push(`missing: ${args.missing.join(", ")}`);
  // No sentence about when the fix takes effect: this error has no context.
  // At startup the process exits on it, and while running the inner provider
  // keeps the refused token cached until it expires. The callers that know
  // which of those applies say it.
  return (
    `The server application's Graph token carries ${parts.join("; ")}. ${refusal} Remove every permission ` +
    "except Sites.Selected from the server application in Entra."
  );
}

/**
 * Checks every token the inner provider mints before anything uses it. The
 * inner provider owns caching and refresh; this remembers only the last token
 * it approved, so a reused token costs nothing and a newly minted one, which
 * the inner provider produces roughly hourly, is checked again. That is what
 * catches a permission added while the server is running.
 */
export function requireExactRoles(provider: TokenProvider, expected: readonly string[]): TokenProvider {
  const wanted = new Set(expected);
  let approved: string | undefined;

  return {
    async getToken(): Promise<string> {
      const token = await provider.getToken();
      if (token === approved) return token;

      const found = appRolesFromAccessToken(token);
      if (found === undefined) throw new UnexpectedTokenRolesError({ found, extra: [], missing: [...expected] });
      const have = new Set(found);
      const extra = found.filter((role) => !wanted.has(role)).sort();
      const missing = expected.filter((role) => !have.has(role));
      if (found.length === 0 || extra.length > 0 || missing.length > 0) {
        throw new UnexpectedTokenRolesError({ found, extra, missing });
      }

      approved = token;
      return token;
    },
  };
}
