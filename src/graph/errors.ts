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
