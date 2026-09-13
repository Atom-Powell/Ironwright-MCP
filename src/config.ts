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
        "These are the server application's own credentials, produced by npm run setup.",
    );
  }

  return { tenantId: tenantId as string, clientId: clientId as string, clientSecret: clientSecret as string };
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
