import type { GraphClient } from "../graph/client.js";
import { listDrives, resolveDrive, type SiteDrive } from "../graph/drive.js";
import { searchDriveItems, type SearchHit } from "../graph/search.js";
import type { RepositoryFile } from "../domain/reconcile/index.js";
import type { Profile } from "../domain/profile/schema.js";

/**
 * The operator's remedy differs for each, which is the whole reason this is a
 * closed set rather than a message string: "no-region" means configure
 * searchRegion on the profile, "search-failed" means investigate a Graph
 * failure, and "page-cap-reached" means the site has more matching files in
 * one library than this cross-check is willing to page through.
 */
export type CrossCheckSkipReason = "no-region" | "search-failed" | "page-cap-reached";

export interface CrossCheckResult {
  files: RepositoryFile[];
  complete: boolean;
  reason?: CrossCheckSkipReason;
}

/**
 * The literal suffix of `naming.template` from its final "." onward, when
 * that suffix names a fixed extension rather than a placeholder. A template
 * ending "...{deliverable}.xlsx" narrows a search to "xlsx"; one ending
 * "...{deliverable}.{ext}" cannot narrow at all, because the segment after
 * the last "." is itself a placeholder rather than a literal value.
 *
 * Returning undefined for the unnarrowable case is not a failure: an
 * unnarrowed search still runs and is still correct, merely more expensive,
 * so there is nothing here worth refusing over.
 */
function literalExtension(template: string): string | undefined {
  const lastDot = template.lastIndexOf(".");
  if (lastDot === -1) return undefined;

  const suffix = template.slice(lastDot + 1);
  if (suffix.length === 0 || suffix.includes("{")) return undefined;
  return suffix;
}

/**
 * A hit's webUrl relative to the library's own webUrl, so a qualified file's
 * path means the same thing a local file's path means: library-relative, no
 * leading slash.
 *
 * Only the folder segments are decoded. `hit.name` is already the literal
 * file name Graph reported on the hit itself, unencoded, so decoding it a
 * second time out of the URL would turn a real file called "a%20b.xlsx" into
 * "a b.xlsx" and misreport it, the same trap `libraryRelativePath` in
 * graph/paths.ts exists to avoid.
 *
 * Returns undefined when the hit's webUrl does not sit under the library's
 * own webUrl at all, or when either URL cannot be parsed: a path this code
 * cannot compute with confidence is worse than a path it does not report.
 */
function relativePathWithinLibrary(hit: SearchHit, libraryWebUrl: string): string | undefined {
  let hitUrl: URL;
  let libraryUrl: URL;
  try {
    hitUrl = new URL(hit.webUrl);
    libraryUrl = new URL(libraryWebUrl);
  } catch {
    return undefined;
  }

  const libraryPath = libraryUrl.pathname.replace(/\/+$/, "");
  const prefix = `${libraryPath}/`;
  if (!hitUrl.pathname.startsWith(prefix)) return undefined;

  const segments = hitUrl.pathname
    .slice(prefix.length)
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;

  const folderSegments = segments.slice(0, -1).map((segment) => decodeURIComponent(segment));
  return [...folderSegments, hit.name].join("/");
}

/**
 * Converts one search hit into a `RepositoryFile`, or refuses it, per three
 * separate rulings that each guard a different way a hit can be untrustworthy:
 *
 * - The path scope given to Microsoft Search is a filter, not a guarantee, so
 *   the hit's own driveId is checked against the library actually being
 *   searched rather than trusted.
 * - `size` and `lastModified` are required on `RepositoryFile` and are never
 *   defaulted here: the Graph layer already chose to report their absence
 *   rather than invent a value, specifically so this decision could be made
 *   knowingly, and a hit this code cannot fully describe is refused rather
 *   than reported half true.
 * - The etag is always the empty string, never fetched, because Microsoft
 *   Search carries no etag on a driveItem hit and fetching one per hit would
 *   cost a Graph call per candidate. `reconcile`'s duplicate tiebreaker reads
 *   etag only to break a tie between two candidates at the same path, where
 *   an empty string loses to any real one, so a local file wins a tie against
 *   a cross-library one, which is the preference wanted here.
 */
function toRepositoryFile(hit: SearchHit, library: SiteDrive & { webUrl: string }): RepositoryFile | undefined {
  if (hit.driveId !== library.id) return undefined;
  if (hit.size === undefined || hit.lastModified === undefined) return undefined;

  const path = relativePathWithinLibrary(hit, library.webUrl);
  if (path === undefined) return undefined;

  return {
    path,
    name: hit.name,
    size: hit.size,
    modified: hit.lastModified,
    etag: "",
    library: library.name,
  };
}

/**
 * Searches every document library on the profile's site other than the
 * profile's own, and returns the correctly named deliverables it finds
 * elsewhere, qualified with the library they were found in.
 *
 * The profile's own library is excluded by drive id, resolved through
 * `resolveDrive`, never by comparing library names. This is not a detail:
 * the reconciliation engine treats the mere presence of `RepositoryFile.library`
 * as meaning "not the profile's own library", without re-checking the name
 * against anything. If this function ever stamped the profile's own library
 * name onto a file that was already in the profile's own library, that file
 * would be silently reclassified as misplaced and become permanently exempt
 * from ever being reported as an orphan, with nothing downstream able to
 * notice. Comparing by id, resolved by the one function that already
 * implements the exact-then-case-insensitive matching rule, avoids a second,
 * independent name comparison that could disagree with it.
 *
 * A failure anywhere in here is caught and reported through `reason`, never
 * thrown: a reconciliation report without a cross-check is still worth
 * having, and a thrown exception here would take down the whole report over
 * one degraded check.
 */
export async function crossCheckOtherLibraries(
  client: Pick<GraphClient, "get" | "post">,
  profile: Profile,
): Promise<CrossCheckResult> {
  const region = profile.identity.searchRegion;
  // Checked first and returned immediately, spending no Graph call at all:
  // a profile with no region cannot search, so there is nothing to attempt.
  if (region === undefined) {
    return { files: [], complete: false, reason: "no-region" };
  }

  const extension = literalExtension(profile.naming.template);

  let ownDriveId: string;
  let drives: SiteDrive[];
  try {
    ({ driveId: ownDriveId } = await resolveDrive(client, profile.identity.siteUrl, profile.identity.library));
    ({ drives } = await listDrives(client, profile.identity.siteUrl));
  } catch {
    return { files: [], complete: false, reason: "search-failed" };
  }

  const otherLibraries = drives.filter((drive) => drive.id !== ownDriveId);

  const files: RepositoryFile[] = [];
  let failed = false;
  let capReached = false;

  for (const library of otherLibraries) {
    if (library.webUrl === undefined) {
      // Graph's own drive resource always carries a webUrl; a listing entry
      // without one cannot be addressed for a search at all. That is the
      // same "this library could not be searched" situation a thrown search
      // failure describes, so it folds into the same signal rather than
      // inventing a fourth reason for a condition nobody has ever observed.
      failed = true;
      continue;
    }

    try {
      const outcome = await searchDriveItems(client, {
        region,
        pathScope: library.webUrl,
        ...(extension === undefined ? {} : { extension }),
      });
      if (!outcome.complete) capReached = true;

      const searched = library as SiteDrive & { webUrl: string };
      for (const hit of outcome.hits) {
        const file = toRepositoryFile(hit, searched);
        if (file !== undefined) files.push(file);
      }
    } catch {
      failed = true;
    }
  }

  const complete = !failed && !capReached;
  // search-failed takes precedence in the report when both occurred, because
  // a Graph failure is the more actionable of the two remedies; nothing in
  // this task exercises both at once, so the tie is broken here rather than
  // left to whichever branch happened to run last.
  const reason: CrossCheckSkipReason | undefined = failed ? "search-failed" : capReached ? "page-cap-reached" : undefined;

  return { files, complete, ...(reason === undefined ? {} : { reason }) };
}
