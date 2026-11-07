// scripts/assessment-probe/grant.ts
/**
 * Shows or changes the roles of the server application's permission entry on
 * one site, under the grant issuer's token (Sites.FullControl.All). This is the
 * procedure docs/SETUP.md describes under "Running the normal setup" for
 * widening an existing grant, as a command instead of hand-built requests.
 *
 *   npm run probe:assessment:grant                  shows the current roles
 *   npm run probe:assessment:grant -- --roles=write  widens to write
 *   npm run probe:assessment:grant -- --roles=read   restores read
 *
 * Reads IW_TENANT_ID, IW_BOOTSTRAP_CLIENT_ID, IW_BOOTSTRAP_CLIENT_SECRET (the
 * grant issuer), IW_CLIENT_ID (the server application whose grant this is) and
 * IW_SITE_URL. It matches the permission entry on the application id rather
 * than on position, so another application's grant on the same site cannot be
 * changed by accident, and it refuses when zero or several entries match.
 */
import { createGraphClient } from "../../src/graph/client.js";
import { siteLookupPath } from "../../src/graph/drive.js";
import { clientCredentialsTokenProvider } from "../../src/graph/token.js";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

interface PermissionEntry {
  id?: unknown;
  roles?: unknown;
  grantedToIdentitiesV2?: unknown;
  grantedToIdentities?: unknown;
}

// Graph's current shape is grantedToIdentitiesV2; the deprecated field is read
// only as a fallback, for the same reason src/setup/adapter.ts reads both: the
// grant request body is written in the older shape and a response that echoes
// it is a real possibility.
function applicationIds(entry: PermissionEntry): string[] {
  const identities = Array.isArray(entry.grantedToIdentitiesV2)
    ? entry.grantedToIdentitiesV2
    : Array.isArray(entry.grantedToIdentities)
      ? entry.grantedToIdentities
      : [];
  return identities.flatMap((identity: unknown) => {
    const application =
      typeof identity === "object" && identity !== null ? (identity as { application?: { id?: unknown } }).application : undefined;
    return typeof application?.id === "string" ? [application.id] : [];
  });
}

function rolesOf(entry: PermissionEntry): string {
  return Array.isArray(entry.roles) ? entry.roles.map(String).join(",") : "(no roles field)";
}

async function main(): Promise<void> {
  const roles = argValue("roles");
  if (roles !== undefined && roles !== "read" && roles !== "write") {
    throw new Error(`--roles must be read or write, received ${JSON.stringify(roles)}`);
  }

  const tokenProvider = clientCredentialsTokenProvider({
    tenantId: env("IW_TENANT_ID"),
    clientId: env("IW_BOOTSTRAP_CLIENT_ID"),
    clientSecret: env("IW_BOOTSTRAP_CLIENT_SECRET"),
  });
  const client = createGraphClient({ tokenProvider });
  const serverAppId = env("IW_CLIENT_ID");
  const siteUrl = env("IW_SITE_URL");

  const site = await client.get<{ id?: unknown }>(`${siteLookupPath(siteUrl)}?$select=id`);
  if (typeof site.id !== "string" || site.id.length === 0) throw new Error(`resolving ${siteUrl} returned no site id`);

  // A collection GET ends when there is no nextLink; a link seen twice cannot
  // end, so it is refused rather than looped on.
  const matches: Array<{ id: string; roles: string }> = [];
  const requested = new Set<string>();
  let next: string | undefined = `/sites/${site.id}/permissions`;
  while (next !== undefined) {
    if (requested.has(next)) throw new Error("the permissions listing repeated a page it had already requested");
    requested.add(next);
    const page: { value?: unknown; "@odata.nextLink"?: unknown } = await client.get(next);
    const entries = Array.isArray(page.value) ? (page.value as PermissionEntry[]) : [];
    for (const entry of entries) {
      if (typeof entry.id === "string" && applicationIds(entry).includes(serverAppId)) {
        matches.push({ id: entry.id, roles: rolesOf(entry) });
      }
    }
    next = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
  }

  if (matches.length === 0) throw new Error("no permission entry on this site is granted to IW_CLIENT_ID; run the normal setup against this site first");
  if (matches.length > 1) throw new Error(`${matches.length} permission entries on this site are granted to IW_CLIENT_ID; resolve that in Entra before changing roles`);
  const entry = matches[0]!;
  console.log(`current roles: ${entry.roles}`);

  if (roles === undefined) return;

  const updated = await client.patch<PermissionEntry>(`/sites/${site.id}/permissions/${entry.id}`, { roles: [roles] });
  // The PATCH response is the updated entry, so the line reports what Graph
  // returned rather than what was sent.
  console.log(`roles after PATCH: ${rolesOf(updated)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
