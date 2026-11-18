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
 * The lists are made and checked first, so a list problem is found with the
 * grant untouched. Then the grant is created or widened to write, which is the
 * one request for it this project has measured, and with --roles=read it is
 * set to read straight after. write, the default, is what the lifecycle tools
 * need; read serves a deployment that only reads.
 *
 * --dry-run reads the site and says what is there and what a run would do. It
 * changes nothing. An argument that is not exactly one of the three is refused.
 */
import { readFileSync } from "node:fs";
import { createGraphClient, type GraphClient } from "../src/graph/client.js";
import { GraphRequestError } from "../src/graph/errors.js";
import { clientCredentialsTokenProvider } from "../src/graph/token.js";
import { loadAnyProfile } from "../src/profiles/registry.js";
import { ensureLists, grantWrite, listDefinitionsFor, readGrant, restoreRead, type WorkflowProfile } from "./pre-eon/department.js";

export interface SetupArguments {
  profile: string;
  roles: "read" | "write";
  dryRun: boolean;
}

/** The command line, or the words for what is wrong with it. Pure, so the refusals are tested. */
export function parseSetupArguments(argv: readonly string[]): SetupArguments | { refusal: string } {
  const value = (name: string): string | undefined => argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  // Exactly these three and nothing that merely begins like one: "--dry-run=true" read as an
  // unknown spelling of a known flag would be dropped, and the run would be a real one.
  const known = (argument: string): boolean => argument === "--dry-run" || argument.startsWith("--profile=") || argument.startsWith("--roles=");
  const stray = argv.filter((argument) => !known(argument));
  if (stray.length > 0) return { refusal: `Unknown argument ${stray.join(", ")}. The arguments are --profile=<file>, --roles=read|write and --dry-run.` };
  const profile = value("profile");
  if (profile === undefined || profile.length === 0) return { refusal: "--profile=<file> is required: the assessment profile whose site is to be prepared." };
  const roles = value("roles") ?? "write";
  if (roles !== "read" && roles !== "write") return { refusal: `--roles must be read or write, received ${JSON.stringify(roles)}.` };
  return { profile, roles, dryRun: argv.includes("--dry-run") };
}

export interface PrepareInputs {
  /** The grant issuer's client. */
  issuer: Pick<GraphClient, "get" | "post" | "patch">;
  profile: WorkflowProfile;
  /** The server application's client id, which the grant names. */
  clientId: string;
  roles: "read" | "write";
  dryRun: boolean;
  print: (line: string) => void;
}

/**
 * The command's work, apart from its arguments and credentials. Every line it
 * prints is something a request answered, and anything that leaves the grant
 * other than as asked is thrown in words that say where the grant may stand.
 */
export async function prepareSite(inputs: PrepareInputs): Promise<void> {
  const { issuer, profile, clientId, roles, print } = inputs;
  const site = profile.sites[0]!;
  const definitions = listDefinitionsFor(profile);
  const { siteId, entries } = await readGrant(issuer, site.siteUrl, clientId);

  if (inputs.dryRun) {
    print(`Dry run for profile "${profile.profileId}" on ${site.siteUrl}. Nothing was changed.`);
    const after = roles === "read" ? " and then to read" : "";
    if (entries.length > 1) print(`${entries.length} permission entries on the site name the server application ${clientId}. A run would refuse to choose and change nothing.`);
    else if (entries.length === 1) print(`The server application ${clientId} holds a grant with roles ${entries[0]!.roles}. A run would set it to write${after}.`);
    else print(`The server application ${clientId} holds no grant on the site. A run would create one at write${roles === "read" ? " and then set it to read" : ""}.`);
    for (const definition of definitions) {
      let present = true;
      try {
        await issuer.get<unknown>(`/sites/${siteId}/lists/${encodeURIComponent(definition.displayName)}?$select=id`);
      } catch (error) {
        if (!(error instanceof GraphRequestError && error.status === 404)) throw error;
        present = false;
      }
      const columns = (definition.body as { columns: Array<{ name: string }> }).columns.map((column) => column.name).join(", ");
      print(present ? `The list "${definition.displayName}" exists and would be checked for the columns ${columns}.` : `The list "${definition.displayName}" would be created with the columns ${columns}.`);
    }
    return;
  }

  // Before anything is made: the grant step below would refuse this, and by then the lists would exist.
  if (entries.length > 1) {
    throw new Error(`${entries.length} permission entries on ${site.siteUrl} name the server application. Nothing was changed. Remove all but one in the site's permissions and run this again.`);
  }

  // The lists first. They are made under the grant issuer's own token, so the server
  // application's role does not bear on them, and a list that fails leaves the grant as it was.
  const lists = await ensureLists(issuer, siteId, definitions);
  print(`Lists created: ${lists.created.join(", ") || "none"}. Already there: ${lists.existing.join(", ") || "none"}. Each has the columns the profile maps.`);

  const grant = await grantWrite(issuer, site.siteUrl, clientId);
  const was = grant.before === undefined ? "created" : `was ${grant.before}`;
  if (!grant.now.split(",").includes("write")) {
    throw new Error(`The grant on ${site.siteUrl} answered roles ${grant.now}, not write.${roles === "write" ? " The lifecycle tools need write." : ""}`);
  }
  if (roles === "write") {
    print(`Grant on ${site.siteUrl}: ${was}, now ${grant.now}.`);
  } else {
    let after: string;
    try {
      after = await restoreRead(issuer, grant);
    } catch (error) {
      throw new Error(`THE GRANT MAY STILL BE AT WRITE on ${site.siteUrl}: read was asked for, and the update to read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (after !== "read") throw new Error(`THE GRANT MAY STILL BE AT WRITE on ${site.siteUrl}: read was asked for, and the update to read answered roles ${after}.`);
    print(`Grant on ${site.siteUrl}: ${grant.before === undefined ? "created at write" : `was ${grant.before}, widened to write`}, then set to read as asked. Roles now ${after}.`);
  }
  print(`Add ${site.siteUrl} to IW_SITE_URL on the server, and index the columns docs/SETUP.md names.`);
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

  const issuer = createGraphClient({
    tokenProvider: clientCredentialsTokenProvider({ tenantId: env("IW_TENANT_ID"), clientId: env("IW_BOOTSTRAP_CLIENT_ID"), clientSecret: env("IW_BOOTSTRAP_CLIENT_SECRET") }),
  });
  await prepareSite({ issuer, profile: loaded as unknown as WorkflowProfile, clientId: env("IW_CLIENT_ID"), roles: args.roles, dryRun: args.dryRun, print: (line) => console.log(line) });
}

// Run only as a command, so the tests can import the argument parsing without starting it.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/department-setup.ts") === true) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
