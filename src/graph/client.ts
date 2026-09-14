import { GraphRequestError } from "./errors.js";
import { defaultRetryPolicy, isRetriableStatus, withRetry, type RetryPolicy } from "./retry.js";
import { TokenRequestError, type TokenProvider } from "./token.js";

/**
 * `send` throws rather than returning a status for anything that never got a
 * Graph response at all: a DNS failure, a socket reset, a TLS error, or the
 * token endpoint's own equivalents, since `send` awaits `tokenProvider.getToken()`
 * before its request. Those are worth retrying, unlike the two error types below,
 * each of which already carries a decided outcome that a second attempt cannot
 * change: a `GraphRequestError` is a Graph response with a final status, and a
 * `TokenRequestError` for 401 is the client id or secret being wrong, which
 * retrying does not fix.
 */
function isRetriableTransportError(error: unknown): boolean {
  if (error instanceof GraphRequestError) return false;
  if (error instanceof TokenRequestError && error.status === 401) return false;
  return true;
}

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface GraphClient {
  get<T>(pathOrUrl: string, headers?: Record<string, string>): Promise<T>;
  post<T>(pathOrUrl: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  /** Requests issued since creation, retries included. This is the number the scan reports. */
  requests(): number;
}

export interface GraphClientOptions {
  tokenProvider: TokenProvider;
  retry?: RetryPolicy;
  fetchImpl?: typeof fetch;
}

interface RawResponse {
  status: number;
  retryAfter: string | null;
  body: string;
}

interface RequestOptions {
  method: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * A transport rejection means the request may or may not have reached the
   * server. Replaying a GET costs a duplicate read; replaying a POST can apply
   * a second mutation. So the thrown-error retry is offered to reads only, and
   * a POST that rejects surfaces immediately. Returned statuses are different:
   * a 429 or a 503 is the server declining to act, so both methods retry those.
   */
  retryTransportErrors: boolean;
}

export function createGraphClient(options: GraphClientOptions): GraphClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retry = options.retry ?? defaultRetryPolicy();
  let requests = 0;

  async function send(url: string, requestOptions: RequestOptions): Promise<RawResponse> {
    // Fetched per attempt rather than per call: a retry that spans a token's
    // expiry would otherwise replay a dead bearer and turn a throttle into a 401.
    const token = await options.tokenProvider.getToken();
    requests += 1;
    const hasBody = requestOptions.body !== undefined;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      // Merged last so a per-call header cannot shadow the bearer token above.
      ...requestOptions.headers,
    };
    const response = await fetchImpl(url, {
      method: requestOptions.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(requestOptions.body) } : {}),
    });
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body: await response.text(),
    };
  }

  async function request<T>(pathOrUrl: string, requestOptions: RequestOptions): Promise<T> {
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
    // Sliced only when the prefix is genuinely there. A blind slice of the
    // base's length turns an absolute URL from anywhere else into a fragment
    // that names no request, and that fragment is what the operator reads.
    const label = url.startsWith(GRAPH_BASE) ? url.slice(GRAPH_BASE.length) : url;

    const result = await withRetry(
      retry,
      () => send(url, requestOptions),
      (value) => ({ retriable: isRetriableStatus(value.status), retryAfter: value.retryAfter }),
      requestOptions.retryTransportErrors ? isRetriableTransportError : () => false,
    );

    if (result.status < 200 || result.status >= 300) {
      throw new GraphRequestError({ method: requestOptions.method, path: label, status: result.status, body: result.body });
    }

    if (result.body.length === 0) return undefined as T;

    try {
      return JSON.parse(result.body) as T;
    } catch {
      throw new Error(
        `Graph ${requestOptions.method} ${label} returned ${result.status} with a body that is not JSON. ` +
          "Something other than Graph answered this request, most often a proxy.",
      );
    }
  }

  return {
    requests: () => requests,

    async get<T>(pathOrUrl: string, headers?: Record<string, string>): Promise<T> {
      return request<T>(pathOrUrl, { method: "GET", retryTransportErrors: true, ...(headers === undefined ? {} : { headers }) });
    },

    async post<T>(pathOrUrl: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
      return request<T>(pathOrUrl, {
        method: "POST",
        retryTransportErrors: false,
        ...(body === undefined ? {} : { body }),
        ...(headers === undefined ? {} : { headers }),
      });
    },
  };
}
