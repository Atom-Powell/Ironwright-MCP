/**
 * A failed Graph call from the setup command, carrying the pieces an operator
 * needs. Graph's own error code, not the HTTP status alone, is what names the
 * cause: a 403 on POST /applications and a 403 on an appRoleAssignment have
 * different remedies and different directory roles behind them.
 */
export class GraphRequestError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly code: string | undefined;
  readonly body: string;

  constructor(args: { method: string; path: string; status: number; body: string }) {
    const code = graphErrorCodeFromBody(args.body);
    super(
      `Graph ${args.method} ${args.path} failed with ${args.status}` +
        `${code === undefined ? "" : ` (${code})`}: ${args.body}`,
    );
    this.name = "GraphRequestError";
    this.method = args.method;
    this.path = args.path;
    this.status = args.status;
    this.code = code;
    this.body = args.body;
  }
}

/**
 * A driveItem's content has no range read available to this server, because the
 * Graph Excel API refuses an app-only token and the whole file is downloaded
 * instead. Nothing else caps the size of that download, so this error stands
 * in for a limit Graph does not enforce on this path. It fires from two
 * different checks in `getBytes`: one against a declared Content-Length, which
 * can be absent or untruthful, and one against the bytes actually received, so
 * a caller sees the same message regardless of which check caught it.
 */
export class GraphResponseTooLargeError extends Error {
  readonly path: string;
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(args: { path: string; bytes: number; maxBytes: number }) {
    const maxMegabytes = args.maxBytes / (1024 * 1024);
    super(
      `Graph GET ${args.path} is ${String(args.bytes)} bytes, larger than the ${String(maxMegabytes)} MB ` +
        "this server will download.",
    );
    this.name = "GraphResponseTooLargeError";
    this.path = args.path;
    this.bytes = args.bytes;
    this.maxBytes = args.maxBytes;
  }
}

/**
 * Graph nests its machine-readable code at error.code. A body that is not JSON
 * yields undefined rather than throwing, because a gateway or proxy in front of
 * Graph can return HTML and that must not become the failure the operator sees.
 */
export function graphErrorCodeFromBody(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}
