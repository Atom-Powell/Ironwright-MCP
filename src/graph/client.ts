import { GraphRequestError, GraphResponseTooLargeError } from "./errors.js";
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
  /**
   * The only mutating verb this server has. Required rather than optional on
   * the interface: a caller that had to branch on whether `patch` exists would
   * be deciding at runtime whether this deployment can write, and that decision
   * belongs to the registry's write gate, where it is reviewed once.
   */
  patch<T>(pathOrUrl: string, body: unknown, headers?: Record<string, string>): Promise<T>;
  /**
   * Bytes rather than JSON, for driveItem content. It goes through this client
   * rather than a bare fetch so the request counter and the Retry-After policy
   * still apply: the scan reports that count, and a download that bypassed it
   * would make the reported number wrong. `maxBytes`, when given, is enforced
   * twice inside this call: against a declared Content-Length before the body
   * is read, and against the bytes actually received afterward, because a
   * missing or untruthful header must not be the only guard.
   */
  getBytes(pathOrUrl: string, maxBytes?: number): Promise<Uint8Array>;
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
  method: "GET" | "POST" | "PATCH";
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
    // Per-call headers are spread first and the always-set ones overwrite them,
    // because object spread gives the later key precedence. A caller passing
    // `authorization` therefore cannot strip the bearer token, which would fail
    // as a 401 naming no cause and would look like an expired credential rather
    // than a wrong argument. The cost is deliberate: a caller that genuinely
    // needs a different `accept`, or a different `content-type` on a request
    // that carries a body, changes this function, where the change is reviewed,
    // instead of passing a header that quietly wins. A `content-type` sent on a
    // bodyless request survives, because there is none set here to take
    // precedence over it, and one on a request Graph will read no body from
    // changes nothing.
    const headers: Record<string, string> = {
      ...requestOptions.headers,
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
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

  async function sendForBytes(url: string, withAuth: boolean): Promise<Response> {
    requests += 1;
    // accept is not set to application/json here: this request wants the file,
    // not a Graph JSON envelope. redirect is manual rather than followed by
    // fetch itself, because the follow below must drop the bearer token before
    // the second request, and fetch's automatic follow would resend it.
    const headers: Record<string, string> = withAuth
      ? { authorization: `Bearer ${await options.tokenProvider.getToken()}` }
      : {};
    return fetchImpl(url, { method: "GET", headers, redirect: "manual" });
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

    async patch<T>(pathOrUrl: string, body: unknown, headers?: Record<string, string>): Promise<T> {
      // retryTransportErrors is false for the same reason it is false for POST:
      // a transport rejection leaves it unknown whether the request reached
      // Graph, and replaying a mutation that already applied is worse than
      // surfacing the failure. If-Match makes a blind replay merely refuse
      // rather than apply twice, but it would refuse with a 412, and a 412 is
      // reported to the operator as "this file changed since you planned it",
      // which would be a confident wrong answer about what happened.
      return request<T>(pathOrUrl, {
        method: "PATCH",
        retryTransportErrors: false,
        body,
        ...(headers === undefined ? {} : { headers }),
      });
    },

    async getBytes(pathOrUrl: string, maxBytes?: number): Promise<Uint8Array> {
      const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
      const label = url.startsWith(GRAPH_BASE) ? url.slice(GRAPH_BASE.length) : url;

      const first = await withRetry(
        retry,
        () => sendForBytes(url, true),
        (value) => ({ retriable: isRetriableStatus(value.status), retryAfter: value.headers.get("retry-after") }),
        isRetriableTransportError,
      );

      let response = first;
      if (first.status >= 300 && first.status < 400) {
        const location = first.headers.get("location");
        if (location === null || location.length === 0) {
          throw new Error(
            `Graph GET ${label} answered ${String(first.status)} with no location header, so there is nowhere to ` +
              "follow. A redirect without a target is a malformed response rather than a missing file.",
          );
        }
        // Deliberately without the bearer token. The redirect target is a
        // pre-authenticated storage URL that needs no credential, and sending
        // one would deliver a Graph bearer token to a host that is not Graph.
        response = await withRetry(
          retry,
          () => sendForBytes(location, false),
          (value) => ({ retriable: isRetriableStatus(value.status), retryAfter: value.headers.get("retry-after") }),
          isRetriableTransportError,
        );
      }

      if (response.status < 200 || response.status >= 300) {
        throw new GraphRequestError({
          method: "GET",
          path: label,
          status: response.status,
          body: await response.text(),
        });
      }

      // Checked against the header before the body is read, because a body
      // large enough to exceed the cap is also large enough that reading it
      // into memory before discarding it defeats the reason for the cap.
      if (maxBytes !== undefined) {
        const declared = response.headers.get("content-length");
        if (declared !== null && Number(declared) > maxBytes) {
          throw new GraphResponseTooLargeError({ path: label, bytes: Number(declared), maxBytes });
        }
      }

      const bytes = new Uint8Array(await response.arrayBuffer());

      // Checked again after the read: a missing or untruthful Content-Length
      // must not be the only guard, since the header is server-declared and
      // this server has no control over what a storage host sends.
      if (maxBytes !== undefined && bytes.length > maxBytes) {
        throw new GraphResponseTooLargeError({ path: label, bytes: bytes.length, maxBytes });
      }

      return bytes;
    },
  };
}
