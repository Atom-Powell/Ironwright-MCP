// scripts/pre-eon/second-site.ts
/**
 * The probe for one application holding grants on two sites, which is what
 * one server addressing a site per client rests on and what nothing here had
 * measured. Run by the sitting runner when a second site is known.
 *
 * It asks four things, in order. Is the second site refused before it is
 * granted, which is the boundary holding. Can the grant issuer grant the
 * server application on it, with the request the setup command sends for the
 * first site. Does the server application then read and write there, under
 * the same token, whose roles claim does not change. And is the first site
 * still reachable under that token. Whatever happens, the grant it issued or
 * widened is put back to read.
 *
 * The clients are passed in, so every decision here is tested against scripted
 * answers. Only the sitting runner hands it real ones.
 */
import type { GraphClient } from "../../src/graph/client.js";
import { resolveDrive, siteLookupPath } from "../../src/graph/drive.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { createFile, createFolder } from "../../src/graph/items.js";
import { driveItemPath } from "../../src/graph/paths.js";
import type { StepResult } from "./sitting-lib.js";

export interface SecondSiteInputs {
  /** The server application's own client, whose token carries exactly Sites.Selected. */
  server: Pick<GraphClient, "get" | "post" | "putBytes" | "getBytes">;
  /** The grant issuer's client. */
  issuer: Pick<GraphClient, "get" | "post" | "patch">;
  firstSiteUrl: string;
  secondSiteUrl: string;
  /** The server application's client id, which the grant names. */
  clientId: string;
  library: string;
  stamp: string;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /**
   * Called once the grant stands at write, and again once Graph has answered that it is back at
   * read. A caller that can be cut off holds the grant on its own record between the two.
   */
  onGrant?: (grant: SecondSiteGrant) => void;
  onRestored?: (grant: SecondSiteGrant) => void;
}

export interface SecondSiteGrant {
  siteUrl: string;
  siteId: string;
  permissionId: string;
}

const FOLDER = "IW-MultiSite";
const ATTEMPTS = 9;

interface PermissionEntry {
  id?: unknown;
  roles?: unknown;
  grantedToIdentitiesV2?: unknown;
  grantedToIdentities?: unknown;
}

function describe(error: unknown): string {
  if (error instanceof GraphRequestError) return `${error.status}${error.code === undefined ? "" : ` ${error.code}`}`;
  return error instanceof Error ? error.message : String(error);
}

// Graph's current shape is grantedToIdentitiesV2; the deprecated field is read as a fallback,
// since a response can echo the shape the grant was sent in.
function applicationIds(entry: PermissionEntry): string[] {
  const identities = Array.isArray(entry.grantedToIdentitiesV2) ? entry.grantedToIdentitiesV2 : Array.isArray(entry.grantedToIdentities) ? entry.grantedToIdentities : [];
  return identities.flatMap((identity: unknown) => {
    const application = typeof identity === "object" && identity !== null ? (identity as { application?: { id?: unknown } }).application : undefined;
    return typeof application?.id === "string" ? [application.id] : [];
  });
}

function rolesOf(entry: PermissionEntry): string {
  return Array.isArray(entry.roles) ? entry.roles.map(String).join(",") : "(no roles field)";
}

export async function probeSecondSite(inputs: SecondSiteInputs): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const add = (step: string, verdict: StepResult["verdict"], detail: string): void => {
    results.push({ step, verdict, detail });
    inputs.log(`${verdict.toUpperCase().padEnd(8)} ${step}: ${detail}`);
  };
  const secondLookup = `${siteLookupPath(inputs.secondSiteUrl)}?$select=id`;

  // 1. Before any grant. A refusal is the boundary holding; an answer means an earlier run's
  // grant still stands, which is not a failure and is said as what it is.
  try {
    await inputs.server.get(secondLookup);
    add("second site before its grant", "observed", "the site already answered the server application, so a grant from an earlier run stands; the refusal before a grant was not seen this time");
  } catch (error) {
    if (error instanceof GraphRequestError && (error.status === 403 || error.status === 404)) {
      add("second site before its grant", "pass", `refused with ${describe(error)}: the server application reaches no site it was not granted`);
    } else {
      add("second site before its grant", "fail", `an answer that is neither a refusal nor the site: ${describe(error)}`);
      return results;
    }
  }

  // 2. The grant, with the grant issuer's token and the request the setup command sends.
  let siteId: string;
  let permissionId: string;
  try {
    const site = await inputs.issuer.get<{ id?: unknown }>(secondLookup);
    if (typeof site.id !== "string" || site.id.length === 0) throw new Error("the grant issuer's lookup of the second site returned no id");
    siteId = site.id;

    const matches: Array<{ id: string; roles: string }> = [];
    const requested = new Set<string>();
    let next: string | undefined = `/sites/${siteId}/permissions`;
    while (next !== undefined) {
      if (requested.has(next)) throw new Error("the permissions listing repeated a page it had already requested");
      requested.add(next);
      const page: { value?: unknown; "@odata.nextLink"?: unknown } = await inputs.issuer.get(next);
      for (const entry of Array.isArray(page.value) ? (page.value as PermissionEntry[]) : []) {
        if (typeof entry.id === "string" && applicationIds(entry).includes(inputs.clientId)) matches.push({ id: entry.id, roles: rolesOf(entry) });
      }
      next = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
    }
    if (matches.length > 1) {
      add("grant on the second site", "fail", `${matches.length} permission entries on the second site name the server application; nothing was changed`);
      return results;
    }
    if (matches.length === 1) {
      const existing = matches[0]!;
      const updated = await inputs.issuer.patch<PermissionEntry>(`/sites/${siteId}/permissions/${existing.id}`, { roles: ["write"] });
      permissionId = existing.id;
      add("grant on the second site", "pass", `widened from ${existing.roles} to ${rolesOf(updated)}`);
    } else {
      const created = await inputs.issuer.post<PermissionEntry>(`/sites/${siteId}/permissions`, {
        roles: ["write"],
        grantedToIdentities: [{ application: { id: inputs.clientId, displayName: "Ironwright MCP server application" } }],
      });
      if (typeof created.id !== "string") throw new Error("Graph answered the grant without a permission id");
      permissionId = created.id;
      add("grant on the second site", "pass", `created with roles ${rolesOf(created)}`);
    }
    inputs.onGrant?.({ siteUrl: inputs.secondSiteUrl, siteId, permissionId });
  } catch (error) {
    add("grant on the second site", "fail", `the grant issuer could not grant the server application on the second site: ${describe(error)}`);
    return results;
  }

  try {
    // 3. The same server token, now against the second site. A new grant is not always in
    // effect at once, so a refusal is waited out before it is believed.
    let location: Awaited<ReturnType<typeof resolveDrive>> | undefined;
    let last = "";
    for (let attempt = 1; attempt <= ATTEMPTS && location === undefined; attempt += 1) {
      try {
        location = await resolveDrive(inputs.server, inputs.secondSiteUrl, inputs.library);
      } catch (error) {
        last = describe(error);
        if (!(error instanceof GraphRequestError && (error.status === 403 || error.status === 404))) break;
        if (attempt < ATTEMPTS) {
          inputs.log(`the second site still refuses the server application (${last}); waiting 10 seconds, attempt ${attempt} of ${ATTEMPTS}`);
          await inputs.sleep(10_000);
        }
      }
    }
    if (location === undefined) {
      add("the server application on the second site", "fail", `the site did not open to the server application after its grant: ${last}. Nothing was written there`);
      return results;
    }

    const path = `${FOLDER}/probe ${inputs.stamp}.md`;
    const bytes = new TextEncoder().encode(`Written to the second site by the sitting of ${inputs.stamp}.\n`);
    try {
      const folder = await createFolder(inputs.server, { driveId: location.driveId, parentPath: "", name: FOLDER });
      const file = await createFile(inputs.server, { driveId: location.driveId, path, bytes, contentType: "text/markdown" });
      if (file.kind !== "created") {
        add("the server application on the second site", "fail", `a file named ${path} was already there, so the write was not made`);
        return results;
      }
      const back = await inputs.server.getBytes(`${driveItemPath(location.driveId, path)}/content`);
      const same = back.byteLength === bytes.byteLength && back.every((value, index) => value === bytes[index]);
      add(
        "the server application on the second site",
        same ? "pass" : "fail",
        same
          ? `resolved the site and its ${inputs.library} library, ${folder.kind === "created" ? "created" : "found"} the folder ${FOLDER}, wrote ${path} and read back the ${bytes.byteLength} bytes it sent`
          : `wrote ${path} and read back ${back.byteLength} bytes that differ from the ${bytes.byteLength} sent`,
      );
    } catch (error) {
      add("the server application on the second site", "fail", `the site resolved, and a write or its read back failed: ${describe(error)}`);
      return results;
    }

    // 4. The first site, under the same token.
    try {
      await resolveDrive(inputs.server, inputs.firstSiteUrl, inputs.library);
      add("the first site under the same token", "pass", "still resolves with its library: one application, one token, two sites");
    } catch (error) {
      add("the first site under the same token", "fail", `the first site no longer resolved: ${describe(error)}`);
    }
    return results;
  } finally {
    // Read at rest, as the first site's grant is, whatever the steps above found.
    try {
      const restored = await inputs.issuer.patch<PermissionEntry>(`/sites/${siteId}/permissions/${permissionId}`, { roles: ["read"] });
      const roles = rolesOf(restored);
      if (roles === "read") inputs.onRestored?.({ siteUrl: inputs.secondSiteUrl, siteId, permissionId });
      add("second site grant restored to read", roles === "read" ? "pass" : "fail", roles === "read" ? "roles after the update: read" : `THE GRANT ON THE SECOND SITE MAY STILL BE AT WRITE: the update answered roles ${roles}`);
    } catch (error) {
      add("second site grant restored to read", "fail", `THE GRANT ON THE SECOND SITE MAY STILL BE AT WRITE: the update failed with ${describe(error)}`);
    }
  }
}
