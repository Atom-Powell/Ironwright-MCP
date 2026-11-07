import { MIN_INBOUND_KEY_LENGTH, type InboundAuthConfig, type InboundAuthMode } from "./server/auth.js";

export interface GraphCredentialsConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Every missing variable is named in one message. Reporting the first one only
 * costs an operator one failed run per variable, and this command is most often
 * run for the first time against a tenant somebody else set up.
 *
 * No rejected value is ever echoed. One of the three is a client secret, and a
 * message an operator pastes into a ticket must not carry it.
 */
export function loadGraphCredentials(env: NodeJS.ProcessEnv): GraphCredentialsConfig {
  const tenantId = env.IW_TENANT_ID;
  const clientId = env.IW_CLIENT_ID;
  const clientSecret = env.IW_CLIENT_SECRET;

  const missing = [
    present(tenantId) ? undefined : "IW_TENANT_ID",
    present(clientId) ? undefined : "IW_CLIENT_ID",
    present(clientSecret) ? undefined : "IW_CLIENT_SECRET",
  ].filter((name): name is string => name !== undefined);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment ${missing.length === 1 ? "variable" : "variables"}: ${missing.join(", ")}. ` +
        "These are the server application's own credentials. npm run setup prints the same three " +
        "values under different names: AZURE_TENANT_ID is IW_TENANT_ID, AZURE_CLIENT_ID is " +
        "IW_CLIENT_ID, and AZURE_CLIENT_SECRET is IW_CLIENT_SECRET.",
    );
  }

  return { tenantId: tenantId as string, clientId: clientId as string, clientSecret: clientSecret as string };
}

/**
 * Required rather than optional, and required for more than this tool. A
 * server that does not know which site its Sites.Selected grant covers cannot
 * check a profile against it, so a profile pointed at the wrong site fails as
 * a 403 on its first Graph call, which is the misleading failure the setup
 * command was already corrected for once.
 *
 * The value is echoed in its own error, unlike the credentials above: a site
 * URL is what an operator already pasted into the setup command, not a secret.
 */
export function loadGrantedSiteUrl(env: NodeJS.ProcessEnv): string {
  const value = env.IW_SITE_URL;
  if (!present(value)) {
    throw new Error(
      "Missing required environment variable: IW_SITE_URL. This is the site the server's Sites.Selected " +
        "grant covers, and npm run setup takes it as --site. The server cannot validate a profile, or " +
        "answer which site it can reach, without it.",
    );
  }
  return value;
}

/**
 * Absent selects the in-memory store rather than failing, so a local run needs
 * no cloud account. The scan's output says which store it used, because an
 * in-memory run cannot demonstrate the incremental path and an operator reading
 * "full scan" twice deserves to know why.
 */
export function loadStoreConnectionString(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.IW_TABLE_CONNECTION_STRING;
  return present(value) ? value : undefined;
}

/**
 * How long shutdown waits for in-flight requests to drain before exiting
 * anyway. Defaults to 25 seconds, which sits under a platform's usual 30
 * second grace period so the process exits on its own terms and can say why,
 * rather than being killed silently once the grace period runs out.
 *
 * Optional, unlike the credentials and site URL above: a deployment that
 * never sets it still shuts down safely on the default, so there is nothing
 * to add to their missing-variable message.
 */
export function loadShutdownDeadlineMs(env: NodeJS.ProcessEnv): number {
  const raw = env.IW_SHUTDOWN_DEADLINE_MS;
  if (!present(raw)) return 25_000;

  // Matched before parsing, for the same reason src/server/config.ts matches
  // PORT before parsing it: parseInt stops at the first character it cannot
  // read, so "25000abc" would otherwise silently run with a real deadline and
  // give an operator no sign that the value they set was wrong.
  const deadlineMs = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`IW_SHUTDOWN_DEADLINE_MS must be a positive integer of milliseconds, received "${raw}"`);
  }
  return deadlineMs;
}

/**
 * Fails closed: no key means no start, and mode none needs a second variable
 * that says the operator meant it. The key is never echoed, for the same
 * reason the client secret above is not.
 */
export function loadInboundAuth(env: NodeJS.ProcessEnv): InboundAuthConfig {
  const rawMode = env.IW_INBOUND_AUTH?.trim() ?? "apikey";
  if (rawMode !== "apikey" && rawMode !== "bearer" && rawMode !== "none") {
    throw new Error(`IW_INBOUND_AUTH must be apikey, bearer or none, received "${rawMode}"`);
  }
  const mode: InboundAuthMode = rawMode;
  const header = env.IW_INBOUND_KEY_HEADER?.trim() || "x-api-key";

  if (mode === "none") {
    if (env.IW_ALLOW_ANONYMOUS !== "1") {
      throw new Error(
        "IW_INBOUND_AUTH=none starts a server that answers anyone who can reach it. Set IW_ALLOW_ANONYMOUS=1 " +
          "as well to confirm that this process is reachable from loopback only.",
      );
    }
    return { mode, header };
  }

  const key = env.IW_INBOUND_KEY;
  if (!present(key) || key.length < MIN_INBOUND_KEY_LENGTH) {
    throw new Error(
      `IW_INBOUND_KEY is required and must be at least ${MIN_INBOUND_KEY_LENGTH} characters: it is the shared key every ` +
        "request to this server must carry. Generate one with: node -e \"console.log(require('node:crypto').randomBytes(24).toString('hex'))\"",
    );
  }
  return { mode, key, header };
}
