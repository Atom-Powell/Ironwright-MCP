// scripts/department-setup.ts
/**
 * npm run department:setup -- --profile=<file> [--roles=read|write] [--dry-run]
 *
 * Prepares the site one assessment profile addresses, so the server can run
 * that profile's workflow there: grants the server application on the site,
 * creates the three lists the profile names where they are absent, and checks
 * that each list has the columns the profile maps. For a deployment whose
 * departments each keep a site, it is run once per profile.
 *
 * It is setup, so it acts under the grant issuer's token and belongs on the
 * operator's workstation with the setup command, never on the server. Reads
 * IW_TENANT_ID, IW_BOOTSTRAP_CLIENT_ID and IW_BOOTSTRAP_CLIENT_SECRET (the
 * grant issuer) and IW_CLIENT_ID (the server application the grant names).
 *
 * --roles is what the grant is left at. write, the default, is what the
 * lifecycle tools need; read serves a deployment that only reads. The grant
 * is created or widened to write first either way, because that is the one
 * request for it this project has measured, and is then set to read if asked.
 *
 * --dry-run reads the site and says what would be done. It changes nothing.
 */
import { readFileSync } from "node:fs";
import { createGraphClient } from "../src/graph/client.js";
import { siteLookupPath } from "../src/graph/drive.js";
import { GraphRequestError } from "../src/graph/errors.js";
import { clientCredentialsTokenProvider } from "../src/graph/token.js";
import { loadAnyProfile } from "../src/profiles/registry.js";
import { ensureLists, grantWrite, listDefinitionsFor, restoreRead, type WorkflowProfile } from "./pre-eon/department.js";

export interface SetupArguments {
  profile: string;
  roles: "read" | "write";
  dryRun: boolean;
}

/** The command line, or the words for what is wrong with it. Pure, so the refusals are tested. */
export function parseSetupArguments(argv: readonly string[]): SetupArguments | { refusal: string } {
  const value = (name: string): string | undefined => argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const known = ["--profile=", "--roles=", "--dry-run"];
  const stray = argv.filter((argument) => argument.startsWith("--") && !known.some((prefix) => argument === prefix || argument.startsWith(prefix)));
  if (stray.length > 0) return { refusal: `Unknown argument ${stray.join(", ")}. The arguments are --profile=<file>, --roles=read|write and --dry-run.` };
  const profile = value("profile");
  if (profile === undefined || profile.length === 0) return { refusal: "--profile=<file> is required: the assessment profile whose site is to be prepared." };
  const roles = value("roles") ?? "write";
  if (roles !== "read" && roles !== "write") return { refusal: `--roles must be read or write, received ${JSON.stringify(roles)}.` };
  return { profile, roles, dryRun: argv.includes("--dry-run") };
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const args = parseSetupArguments(process.argv.slice(2));
  if ("refusal" in args) throw new Error(args.refusal);

  const loaded = loadAnyProfile(JSON.parse(readFileSync(args.profile, "utf8"))) as { kind?: string };
  if (loaded.kind !== "assessment") throw new Error(`${args.profile} is a ${loaded.kind ?? "compliance"} profile. This command prepares the site of an assessment profile.`);
  const profile = loaded as unknown as WorkflowProfile;
  const site = profile.sites[0]!;
  const definitions = listDefinitionsFor(profile);

  const issuer = createGraphClient({
    tokenProvider: clientCredentialsTokenProvider({ tenantId: env("IW_TENANT_ID"), clientId: env("IW_BOOTSTRAP_CLIENT_ID"), clientSecret: env("IW_BOOTSTRAP_CLIENT_SECRET") }),
  });
  const clientId = env("IW_CLIENT_ID");

  if (args.dryRun) {
    const found = await issuer.get<{ id?: unknown }>(`${siteLookupPath(site.siteUrl)}?$select=id`);
    if (typeof found.id !== "string") throw new Error(`resolving ${site.siteUrl} returned no site id`);
    console.log(`Dry run for profile "${profile.profileId}" on ${site.siteUrl}. Nothing was changed.`);
    console.log(`The server application ${clientId} would be granted ${args.roles} on the site.`);
    for (const definition of definitions) {
      let present = true;
      try {
        await issuer.get<unknown>(`/sites/${found.id}/lists/${encodeURIComponent(definition.displayName)}?$select=id`);
      } catch (error) {
        if (!(error instanceof GraphRequestError && error.status === 404)) throw error;
        present = false;
      }
      const columns = (definition.body as { columns: Array<{ name: string }> }).columns.map((column) => column.name).join(", ");
      console.log(present ? `The list "${definition.displayName}" exists and would be checked for the columns ${columns}.` : `The list "${definition.displayName}" would be created with the columns ${columns}.`);
    }
    return;
  }

  const grant = await grantWrite(issuer, site.siteUrl, clientId);
  console.log(`Grant on ${site.siteUrl}: ${grant.before === undefined ? "created" : `was ${grant.before}`}, now ${grant.now}.`);
  // The lists are made while the grant is whatever it now is; they are created under the grant
  // issuer's own token, so the server application's role does not bear on them.
  const lists = await ensureLists(issuer, grant.siteId, definitions);
  console.log(`Lists created: ${lists.created.join(", ") || "none"}. Already there: ${lists.existing.join(", ") || "none"}. Each has the columns the profile maps.`);
  if (args.roles === "read") console.log(`Grant set to read, as asked: roles now ${await restoreRead(issuer, grant)}.`);
  console.log(`Add ${site.siteUrl} to IW_SITE_URL on the server, and index the columns docs/SETUP.md names.`);
}

// Run only as a command, so the tests can import the argument parsing without starting it.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/department-setup.ts") === true) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
