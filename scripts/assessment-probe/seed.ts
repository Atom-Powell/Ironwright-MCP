// scripts/assessment-probe/seed.ts
/**
 * Creates the three probe lists on the probe site, under the grant issuer's
 * token (Sites.FullControl.All). Idempotent: a list that already exists by
 * display name is left alone and reported. Run once before the probe.
 *
 * Reads IW_BOOTSTRAP_CLIENT_ID, IW_BOOTSTRAP_CLIENT_SECRET, IW_TENANT_ID,
 * IW_SITE_URL and IW_PROBE_LIST_PREFIX (default "IW Probe").
 */
import { createGraphClient } from "../../src/graph/client.js";
import { siteLookupPath } from "../../src/graph/drive.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { clientCredentialsTokenProvider } from "../../src/graph/token.js";
import { listDefinitions } from "./lists.js";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const tokenProvider = clientCredentialsTokenProvider({
    tenantId: env("IW_TENANT_ID"),
    clientId: env("IW_BOOTSTRAP_CLIENT_ID"),
    clientSecret: env("IW_BOOTSTRAP_CLIENT_SECRET"),
  });
  const client = createGraphClient({ tokenProvider });
  const siteUrl = env("IW_SITE_URL");
  const prefix = process.env.IW_PROBE_LIST_PREFIX?.trim() || "IW Probe";

  const site = await client.get<{ id: string }>(`${siteLookupPath(siteUrl)}?$select=id`);

  for (const list of listDefinitions(prefix)) {
    try {
      await client.get<unknown>(`/sites/${site.id}/lists/${encodeURIComponent(list.displayName)}?$select=id`);
      console.log(`exists: ${list.displayName}`);
      continue;
    } catch (error) {
      if (!(error instanceof GraphRequestError && error.status === 404)) throw error;
    }
    await client.post<unknown>(`/sites/${site.id}/lists`, list.body);
    console.log(`created: ${list.displayName}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
