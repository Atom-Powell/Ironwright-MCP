import type { GraphClient } from "./client.js";

export interface DriveLocation {
  siteId: string;
  driveId: string;
}

export class LibraryNotFoundError extends Error {
  readonly library: string;
  readonly available: string[];

  /**
   * `rawCount` is how many entries the listing carried before the shape filter,
   * and it is what separates two situations that both leave `available` empty:
   * a site with no libraries, and a site whose libraries arrived in a shape this
   * code could not read. Reporting the second as the first sends an operator to
   * correct a site URL that was right.
   */
  constructor(library: string, available: string[], rawCount: number) {
    const tail =
      rawCount === 0
        ? "That site has no document libraries at all, which usually means the site URL in the profile names the wrong site."
        : available.length === 0
          ? `That site returned ${rawCount} ${rawCount === 1 ? "entry" : "entries"} for its libraries, but none carried both an id and a name, so none could be matched. That is an unexpected response shape rather than a wrong site URL.`
          : `The libraries on that site are: ${available.map((name) => `"${name}"`).join(", ")}.`;
    super(`No document library named "${library}" was found. ${tail}`);
    this.name = "LibraryNotFoundError";
    this.library = library;
    this.available = available;
  }
}

/**
 * Graph addresses a site by hostname and server-relative path rather than by the
 * URL as typed. A root site has no path segment and takes the short form; giving
 * it the colon form yields a 400 rather than the site.
 */
export function siteLookupPath(siteUrl: string): string {
  const url = new URL(siteUrl);
  const serverRelative = url.pathname.replace(/\/+$/, "");
  if (serverRelative.length === 0 || serverRelative === "/") return `/sites/${url.hostname}`;
  return `/sites/${url.hostname}:${serverRelative}`;
}

interface DriveListing {
  value?: Array<{ id?: unknown; name?: unknown; webUrl?: unknown }>;
}

export interface SiteDrive {
  id: string;
  name: string;
  /**
   * Optional because id and name are the only fields the shape filter below
   * requires; a listing entry that is otherwise usable but happens to lack a
   * webUrl should still resolve for `resolveDrive`, which never reads it.
   * The Microsoft Search cross-check is the one caller that needs it, to
   * search a library and to strip its own root back off a hit's webUrl, and
   * it is positioned to decide what an absent webUrl means for its own job.
   */
  webUrl?: string;
}

/**
 * Narrowed to `get` alone, which is the only member this function calls (the
 * site lookup and the drive listing, both below). A caller whose own client
 * cannot download content, such as the seeder's write-only client, still has
 * a library to resolve, and a parameter typed as the full `GraphClient` would
 * force it to carry a `getBytes` it never uses just to call this function.
 *
 * `resolveDrive` and the Microsoft Search cross-check both need a site's
 * libraries, so the enumeration lives here once rather than once per caller.
 *
 * `rawCount` rides alongside `drives` for `resolveDrive`'s own use below: it is
 * how many entries the listing carried before the shape filter, which is what
 * `LibraryNotFoundError` needs to tell a site with no libraries apart from a
 * site whose libraries arrived in a shape this code could not read. A caller
 * that only wants the libraries, such as the search cross-check, can ignore it.
 */
export async function listDrives(
  client: Pick<GraphClient, "get">,
  siteUrl: string,
): Promise<{ siteId: string; drives: SiteDrive[]; rawCount: number }> {
  const site = await client.get<{ id?: unknown }>(siteLookupPath(siteUrl));
  if (typeof site.id !== "string" || site.id.length === 0) {
    // Without this the site id interpolates as the literal text "undefined" into
    // the next path and the failure surfaces one call away from its cause.
    throw new Error(`Resolving the site "${siteUrl}" returned a response with no id.`);
  }

  const listing = await client.get<DriveListing>(`/sites/${site.id}/drives?$select=id,name,webUrl`);
  const rawValue = listing.value ?? [];
  const drives = rawValue.flatMap((drive) =>
    typeof drive.id === "string" && typeof drive.name === "string"
      ? [{ id: drive.id, name: drive.name, ...(typeof drive.webUrl === "string" ? { webUrl: drive.webUrl } : {}) }]
      : [],
  );

  return { siteId: site.id, drives, rawCount: rawValue.length };
}

export async function resolveDrive(
  client: Pick<GraphClient, "get">,
  siteUrl: string,
  library: string,
): Promise<DriveLocation> {
  const { siteId, drives, rawCount } = await listDrives(client, siteUrl);

  // Exact first. SharePoint permits two libraries whose names differ only in
  // case, so falling straight to a case-insensitive match could pick the wrong one.
  const exact = drives.find((drive) => drive.name === library);
  const insensitive = drives.find((drive) => drive.name.toLowerCase() === library.toLowerCase());
  const matched = exact ?? insensitive;

  if (matched === undefined) {
    throw new LibraryNotFoundError(
      library,
      drives.map((drive) => drive.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      rawCount,
    );
  }

  return { siteId, driveId: matched.id };
}
