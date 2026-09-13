import { GraphRequestError } from "./errors.js";
import { defaultRetryPolicy, isRetriableStatus, withRetry, type RetryPolicy } from "./retry.js";
import type { TokenProvider } from "./token.js";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface GraphClient {
  get<T>(pathOrUrl: string): Promise<T>;
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

export function createGraphClient(options: GraphClientOptions): GraphClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retry = options.retry ?? defaultRetryPolicy();
  let requests = 0;

  async function send(url: string): Promise<RawResponse> {
    // Fetched per attempt rather than per call: a retry that spans a token's
    // expiry would otherwise replay a dead bearer and turn a throttle into a 401.
    const token = await options.tokenProvider.getToken();
    requests += 1;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body: await response.text(),
    };
  }

  return {
    requests: () => requests,

    async get<T>(pathOrUrl: string): Promise<T> {
      const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
      // The path is what an operator recognizes in an error; the absolute URL of
      // a deltaLink is opaque and carries an encoded continuation token.
      const label = pathOrUrl.startsWith("https://") ? url.slice(GRAPH_BASE.length) : pathOrUrl;

      const result = await withRetry(
        retry,
        () => send(url),
        (value) => ({ retriable: isRetriableStatus(value.status), retryAfter: value.retryAfter }),
      );

      if (result.status < 200 || result.status >= 300) {
        throw new GraphRequestError({ method: "GET", path: label, status: result.status, body: result.body });
      }

      if (result.body.length === 0) return undefined as T;

      try {
        return JSON.parse(result.body) as T;
      } catch {
        throw new Error(
          `Graph GET ${label} returned ${result.status} with a body that is not JSON. ` +
            "Something other than Graph answered this request, most often a proxy.",
        );
      }
    },
  };
}
