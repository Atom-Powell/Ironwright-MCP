
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
