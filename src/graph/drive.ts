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
  value?: Array<{ id?: unknown; name?: unknown }>;
}

export async function resolveDrive(
  client: GraphClient,
  siteUrl: string,
  library: string,
): Promise<DriveLocation> {
  const site = await client.get<{ id?: unknown }>(siteLookupPath(siteUrl));
  if (typeof site.id !== "string" || site.id.length === 0) {
    // Without this the site id interpolates as the literal text "undefined" into
    // the next path and the failure surfaces one call away from its cause.
    throw new Error(`Resolving the site "${siteUrl}" returned a response with no id.`);
  }

  const listing = await client.get<DriveListing>(`/sites/${site.id}/drives?$select=id,name`);
  const rawValue = listing.value ?? [];
  const drives = rawValue.flatMap((drive) =>
    typeof drive.id === "string" && typeof drive.name === "string" ? [{ id: drive.id, name: drive.name }] : [],
  );

  // Exact first. SharePoint permits two libraries whose names differ only in
  // case, so falling straight to a case-insensitive match could pick the wrong one.
  const exact = drives.find((drive) => drive.name === library);
  const insensitive = drives.find((drive) => drive.name.toLowerCase() === library.toLowerCase());
  const matched = exact ?? insensitive;

  if (matched === undefined) {
    throw new LibraryNotFoundError(
      library,
      drives.map((drive) => drive.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      rawValue.length,
    );
  }

  return { siteId: site.id, driveId: matched.id };
}
