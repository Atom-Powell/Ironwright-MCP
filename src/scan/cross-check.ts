import type { GraphClient } from "../graph/client.js";
import type { SiteDrive } from "../graph/drive.js";
import { searchDriveItems, type SearchHit } from "../graph/search.js";
import { UnexpectedTokenRolesError } from "../graph/token.js";
import type { RepositoryFile } from "../domain/reconcile/index.js";
import { isLibraryProfile, type AnyProfile } from "../domain/profile/library.js";

/**
 * The operator's remedy differs for each, which is the whole reason this is a
 * closed set rather than a message string: "no-region" means configure
 * searchRegion on the profile, "search-failed" means investigate a Graph
 * search request that actually failed, "library-not-addressable" means a
 * listed library came back with no webUrl to search it by, which is a
 * listing-shape problem rather than a failed request, "page-cap-reached"
 * means the site has more matching files in one library than this cross-check
 * is willing to page through, and "library-profile" means the profile is
 * library-only and has no naming template for this cross-check to search for.
 */
export type CrossCheckSkipReason =
  | "no-region"
  | "search-failed"
  | "library-not-addressable"
  | "page-cap-reached"
  | "library-profile";

export interface CrossCheckResult {
  files: RepositoryFile[];
  complete: boolean;
  reason?: CrossCheckSkipReason;
}

/**
 * The cause-and-remedy sentence for one skip reason, written once here because
 * two callers report it: the reconciliation tool's text formatter and the scan
 * CLI. This project has already had to correct the same stale claim about this
 * cross-check in two places; a description that exists in one place cannot
 * drift into two different, individually plausible, wrong stories about the
 * same run.
 *
 * `reason` is `undefined` for the one caller, the reconciliation tool, whose
 * own provenance can in principle report the cross-check incomplete without
 * having recorded why (see its own comment on `searchCrossCheckSkipReason`).
 * That caller must not upgrade "I do not know why" into any of the five known
 * causes, so this function gives it a sixth, honest sentence to say instead of
 * inventing one at the call site. `crossCheckOtherLibraries` itself always
 * names one of the five reasons whenever it does not complete, so this branch
 * is unreached from the scan CLI, which reads `reason` straight off that
 * function's own result. The reconciliation tool itself can never observe
 * "library-profile" either: it refuses a library-only profile through
 * `ProfileRegistry.get` before a scan ever runs. Nor can the scan CLI, which
 * loads its profile through `loadProfile` and so accepts compliance profiles
 * only. That reason therefore reaches this function from no caller today; its
 * case below exists so a future caller that scans a library-only profile and
 * reports the skip gets a true sentence rather than the unrecorded default.
 */
export function describeCrossCheckSkipReason(reason: CrossCheckSkipReason | undefined): string {
  switch (reason) {
    case "no-region":
      return (
        "The Microsoft Search cross-check did not run because the profile has no searchRegion " +
        "configured. Configure searchRegion on the profile to enable it."
      );
    case "search-failed":
      return (
        "The Microsoft Search cross-check failed. Investigate Microsoft Graph access, credentials, " +
        "or the network."
      );
    case "library-not-addressable":
      return (
        "The Microsoft Search cross-check could not search every document library, because one was " +
        "listed without a URL to search it by. That is not a failure and not a misconfiguration."
      );
    case "page-cap-reached":
      return (
        "The Microsoft Search cross-check did not search a library exhaustively, because it returned " +
        "more matching files than the page cap allows. The scope is too large for one pass."
      );
    case "library-profile":
      return (
        "The Microsoft Search cross-check did not run because the profile is library-only and has no " +
        "naming template, so there is nothing for the cross-check to search for."
      );
    default:
      return "The Microsoft Search cross-check did not complete, for a reason this scan did not record.";
  }
}

/**
 * True only for the two reasons that mean no Graph request was ever sent:
 * `crossCheckOtherLibraries` checks for a library-only profile first and a
 * missing `searchRegion` second, and returns before attempting any library
 * either way, so "library-profile" and "no-region" are the sole cases where
 * nothing was learned about any library. Every other reason, an unrecorded
 * one included, means an attempt reached at least one library, which is why
 * an operator's next step differs by exactly this split rather than by which
 * of the six sentences above fired.
 */
export function crossCheckNeverAttempted(reason: CrossCheckSkipReason | undefined): boolean {
  return reason === "no-region" || reason === "library-profile";
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
 * Decodes every segment of a path, or reports that it could not: a segment
 * carrying a malformed percent-encoded sequence throws out of
 * `decodeURIComponent`, and a path this code cannot decode with confidence is
 * worse than one it refuses to compare at all.
 */
function decodeSegments(segments: readonly string[]): string[] | undefined {
  const decoded: string[] = [];
  for (const segment of segments) {
    try {
      decoded.push(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }
  return decoded;
}

/**
 * A hit's webUrl relative to the library's own webUrl, so a qualified file's
 * path means the same thing a local file's path means: library-relative, no
 * leading slash.
 *
 * The library-prefix segments are decoded on both sides before comparison,
 * rather than compared as raw pathname strings. A live run against
 * helloironwright.sharepoint.com on 2026-09-17 found the library's own
 * webUrl, from listDrives, percent encoded ("Shared%20Documents"), while a
 * Microsoft Search hit's webUrl for a file genuinely in that same library was
 * not ("Shared Documents", a literal space). A raw prefix comparison never
 * matches those two spellings of the same library, which skipped every hit
 * in any library whose name needed encoding and made the cross-check report
 * `complete: true` having silently found nothing. Decoding both sides first
 * compares what the library is named rather than which bytes Graph happened
 * to send, so it does not matter which side, if either, arrived encoded.
 * This also covers characters outside `Shared Documents`' one space: an
 * apostrophe or ampersand in a library name is not in the URL path
 * percent-encode set, so `new URL(...).pathname` alone leaves it exactly as
 * received and would not have converged the way it accidentally does for a
 * plain space; decoding is what makes the comparison genuinely
 * encoding-independent rather than lucky for this one case.
 *
 * Only the library-prefix and intervening folder segments are decoded.
 * `hit.name` is already the literal file name Graph reported on the hit
 * itself, unencoded, so decoding it a second time out of the URL would turn a
 * real file called "a%20b.xlsx" into "a b.xlsx" and misreport it, the same
 * trap `libraryRelativePath` in graph/paths.ts exists to avoid. The output
 * this function produces is therefore the same library-relative convention
 * `libraryRelativePath` produces for the ordinary delta scan: segments joined
 * literally with "/", decoded except for the trailing file name, which is
 * never touched. The reconciliation engine can compare the two without
 * knowing which scan found a file, which is the property this cross-check's
 * whole output depends on.
 *
 * A decoded library name that happens to equal a different literal library
 * name is the one way this could misidentify a library rather than fail
 * safe: a library literally named "A%20B" (containing a literal percent
 * sign, not a byte pair meant to be decoded) is indistinguishable from a
 * library named "A B" once both are decoded, if SharePoint's own webUrl
 * generation ever emitted the former without escaping its literal "%" as
 * "%25" first. This is accepted rather than guarded against: escaping a
 * literal "%" in a generated URL is ordinary, correct URL construction, and
 * a library name built to collide with its own percent-encoded form is a
 * pathological case this project has not seen and Graph's own webUrl
 * generation is not expected to produce.
 *
 * Returns undefined when the hit's webUrl does not sit under the library's
 * own webUrl at all, or when either URL cannot be parsed: a path this code
 * cannot compute with confidence is worse than a path it does not report.
 *
 * The decoded prefix comparison is still case sensitive, so a hit whose
 * webUrl differs from the library's own webUrl only in path casing is
 * skipped rather than matched. That fails safe: the hit disappears from this
 * cross-check rather than being mapped to a wrong or malformed path, and the
 * ordinary inventory scan can still see the file directly if it is in fact in
 * the searched library. Whether SharePoint normalizes path casing
 * consistently between a Microsoft Search hit's webUrl and a drive's own
 * webUrl has not been verified against a live tenant, so this has not been
 * relaxed.
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

  const libraryRawSegments = libraryUrl.pathname.split("/").filter((segment) => segment.length > 0);
  const hitRawSegments = hitUrl.pathname.split("/").filter((segment) => segment.length > 0);
  // At least one hit segment, the file name, must remain past the library's
  // own segments; a hit at or above the library root has nothing to qualify.
  if (hitRawSegments.length <= libraryRawSegments.length) return undefined;

  const libraryPrefix = decodeSegments(libraryRawSegments);
  const hitPrefix = decodeSegments(hitRawSegments.slice(0, libraryRawSegments.length));
  if (libraryPrefix === undefined || hitPrefix === undefined) return undefined;
  if (!libraryPrefix.every((segment, index) => segment === hitPrefix[index])) return undefined;

  const folderSegments = decodeSegments(hitRawSegments.slice(libraryRawSegments.length, -1));
  if (folderSegments === undefined) return undefined;

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
 *   cost a Graph call per candidate. `reconcile`'s own file collapse keys on
 *   library and path together, so a local file and a file this cross-check
 *   qualifies with a library are never the same key and are never compared
 *   against each other at all; a real etag would only ever settle a tie
 *   between two hits this cross-check found in the same other library at the
 *   same path.
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
 * The site's drive listing and the profile's own resolved drive id are given
 * by the caller rather than fetched here. `runScan` already calls
 * `resolveDrive` to resolve the profile's own library before a scan can do
 * anything else, and that call already lists every drive on the site and
 * already applies `matchDrive`'s exact-then-case-insensitive rule to find the
 * profile's own one among them; a second `listDrives` call in this function
 * would spend a Graph request the caller's own call already paid for, and a
 * second `matchDrive` call would duplicate a rule that exists in exactly one
 * place so it cannot go missing from a second copy.
 *
 * The profile's own library is excluded by drive id, never by comparing
 * library names against the drive listing. This is not a detail: the
 * reconciliation engine treats the mere presence of `RepositoryFile.library`
 * as meaning "not the profile's own library", without re-checking the name
 * against anything. If this function ever stamped the profile's own library
 * name onto a file that was already in the profile's own library, that file
 * would be silently reclassified as misplaced and become permanently exempt
 * from ever being reported as an orphan, with nothing downstream able to
 * notice. Trusting the caller's own already-resolved `ownDriveId`, the same
 * id `resolveDrive` handed back and the same id the scan used to enumerate
 * this library's own delta, is what keeps that guarantee to one resolution
 * rather than a second one that could disagree with it.
 *
 * A failure anywhere in here is caught and reported through `reason`, never
 * thrown: a reconciliation report without a cross-check is still worth
 * having, and a thrown exception here would take down the whole report over
 * one degraded check. The one exception is an `UnexpectedTokenRolesError`,
 * which is not a degraded check but a server refusing its own credential, and
 * propagates.
 */
export async function crossCheckOtherLibraries(
  client: Pick<GraphClient, "post">,
  profile: AnyProfile,
  drives: readonly SiteDrive[],
  ownDriveId: string,
): Promise<CrossCheckResult> {
  // A library profile has no naming template, and the search query is built
  // from the template's literal extension, so there is nothing to search for.
  // Checked before the region so the reason names the real cause.
  if (isLibraryProfile(profile)) return { files: [], complete: false, reason: "library-profile" };

  const region = profile.identity.searchRegion;
  // Checked first and returned immediately, spending no Graph call at all:
  // a profile with no region cannot search, so there is nothing to attempt.
  if (region === undefined) {
    return { files: [], complete: false, reason: "no-region" };
  }

  const extension = literalExtension(profile.naming.template);
  const otherLibraries = drives.filter((drive) => drive.id !== ownDriveId);

  const files: RepositoryFile[] = [];
  let failed = false;
  let notAddressable = false;
  let capReached = false;

  for (const library of otherLibraries) {
    if (library.webUrl === undefined) {
      // Graph's own drive resource always carries a webUrl in practice, but
      // this code must not assert a search attempt or a search failure it
      // never made: no request was ever sent for this library, so it gets
      // its own reason rather than being folded into "search-failed", which
      // would tell an operator to investigate a Graph or network failure
      // that did not happen and hide the actual, different problem: the
      // drive listing did not describe this library well enough to search it.
      notAddressable = true;
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
    } catch (error) {
      // A refused token is not a degraded search: it refuses every other Graph
      // call this tool makes too, and "search-failed" would send the operator
      // to investigate a network or Graph failure that did not happen.
      if (error instanceof UnexpectedTokenRolesError) throw error;
      failed = true;
    }
  }

  const complete = !failed && !notAddressable && !capReached;
  // Ordered by how directly each cause points at a fix: a Graph failure
  // (search-failed) is investigated first because it can mask the other two
  // conditions on a retry; an unaddressable library (a listing-shape problem)
  // next; the page cap last, since it is the only one of the three that means
  // the cross-check otherwise worked. This is a real precedence rule, not a
  // choice that happens never to be tested: different libraries in the same
  // run can fail in different ways, for instance one lacking a webUrl while a
  // different one's search request throws, and `search-failed` is what this
  // function reports for that run rather than `library-not-addressable`.
  const reason: CrossCheckSkipReason | undefined = failed
    ? "search-failed"
    : notAddressable
      ? "library-not-addressable"
      : capReached
        ? "page-cap-reached"
        : undefined;

  return { files, complete, ...(reason === undefined ? {} : { reason }) };
}
