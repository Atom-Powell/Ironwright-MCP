import type { GraphClient } from "./client.js";

/**
 * What a caller of the cross-check needs from a matched item. `driveId` comes
 * from `resource.parentReference.driveId`, which is present on every hit a
 * live probe returned, unlike an etag, which is not a field Microsoft Search
 * carries on a driveItem hit at all. A later task checks this driveId against
 * the library it was searching, turning a trusted path scope into a verified
 * one; that check belongs there, not here, because this module knows nothing
 * about which library a caller meant to search.
 *
 * `size` and `lastModified` are optional rather than defaulted, because this
 * layer reports what the response contained rather than inventing a value
 * for what it did not. `lastModified` in particular feeds a plain-string
 * comparison downstream (`supersedes` in the reconciliation engine) that
 * decides which of two candidate files represents an artifact; a defaulted
 * empty string would sort below every real timestamp and silently lose that
 * comparison as though the file were the oldest possible one, rather than as
 * something unknown. A caller that needs both fields to describe a candidate,
 * such as building a `RepositoryFile`, is the one positioned to decide that a
 * hit missing either is worse than a hit it cannot report at all, and should
 * skip it there rather than have this layer guess on its behalf.
 */
export interface SearchHit {
  name: string;
  webUrl: string;
  size?: number;
  lastModified?: string;
  driveId: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  complete: boolean;
}

/**
 * 200 per page and 25 pages, so at most 5000 hits from one library. A
 * tracking repository's deliverables number in the hundreds, and a live
 * probe against a real site returned 220 hits for a broad single term, so
 * the cap sits about an order of magnitude above any plausible real answer
 * while still bounding a pathological one. Constants rather than profile
 * configuration because no real customer library has been measured, so a
 * knob would be a guess at a shape nobody has seen.
 */
export const SEARCH_PAGE_SIZE = 200;
export const SEARCH_PAGE_CAP = 25;

interface SearchHitResource {
  name?: unknown;
  webUrl?: unknown;
  size?: unknown;
  lastModifiedDateTime?: unknown;
  parentReference?: unknown;
}

interface SearchHitRaw {
  resource?: SearchHitResource;
}

interface HitsContainer {
  hits?: SearchHitRaw[];
  moreResultsAvailable?: boolean;
}

interface SearchResponse {
  value?: Array<{ hitsContainers?: HitsContainer[] }>;
}

/**
 * A hit missing a name, a webUrl or a driveId is not something this layer can
 * report: inventing any of the three would let a caller act on data the
 * search response never actually contained, and without one of them there is
 * nothing to identify the hit as being about at all. Skipping it here, rather
 * than emitting a placeholder, is what keeps that decision out of the
 * caller's hands.
 *
 * `size` and `lastModifiedDateTime` are a different situation: the hit is
 * still identified, only incompletely described, so the field is simply left
 * off rather than defaulted or treated as a reason to skip the hit. See the
 * comment on `SearchHit` for why a default here would be worse than an
 * absence.
 */
function toSearchHit(rawHit: SearchHitRaw): SearchHit | undefined {
  const resource = rawHit.resource;
  if (typeof resource !== "object" || resource === null) return undefined;

  const { name, webUrl, size, lastModifiedDateTime, parentReference } = resource;
  const driveId =
    typeof parentReference === "object" && parentReference !== null
      ? (parentReference as { driveId?: unknown }).driveId
      : undefined;

  if (typeof name !== "string" || typeof webUrl !== "string" || typeof driveId !== "string") return undefined;

  return {
    name,
    webUrl,
    driveId,
    ...(typeof size === "number" ? { size } : {}),
    ...(typeof lastModifiedDateTime === "string" ? { lastModified: lastModifiedDateTime } : {}),
  };
}

/**
 * Queries Microsoft Search for driveItems under a path scope, an app-only
 * caller has to name a region, confirmed by a live probe: the request fails
 * with 400 and "Region is required when request with application permission"
 * when it is omitted. This module carries no domain knowledge; it does not
 * know what a client, a deliverable or a profile is, only a path to search
 * under and an optional extension to narrow by.
 */
export async function searchDriveItems(
  client: Pick<GraphClient, "post">,
  args: { region: string; pathScope: string; extension?: string },
): Promise<SearchOutcome> {
  // pathScope is not escaped against an embedded double quote, which would
  // break the path:"..." clause. Unescaped because every caller in this
  // codebase sources pathScope from a driveItem webUrl or a site path Graph
  // itself returned, and a double quote is not a legal character in either.
  const queryString = `path:"${args.pathScope}"${args.extension === undefined ? "" : ` filetype:${args.extension}`}`;
  const hits: SearchHit[] = [];

  for (let page = 0; page < SEARCH_PAGE_CAP; page += 1) {
    const response = await client.post<SearchResponse>("/search/query", {
      requests: [
        {
          entityTypes: ["driveItem"],
          query: { queryString },
          from: page * SEARCH_PAGE_SIZE,
          size: SEARCH_PAGE_SIZE,
          region: args.region,
        },
      ],
    });

    const container = response.value?.[0]?.hitsContainers?.[0];
    // No container at all is an empty result, not a malformed one: the API
    // returns this shape for a query with nothing to match.
    if (container === undefined) return { hits, complete: true };

    const rawHits = container.hits ?? [];
    for (const rawHit of rawHits) {
      const hit = toSearchHit(rawHit);
      if (hit !== undefined) hits.push(hit);
    }

    if (rawHits.length < SEARCH_PAGE_SIZE || container.moreResultsAvailable !== true) {
      return { hits, complete: true };
    }
  }

  // The cap was reached with moreResultsAvailable still true on the last page,
  // so results remain outstanding. This is a refusal to claim completeness,
  // not a silent truncation, and it is the only way complete becomes false: a
  // failed request throws instead, so a caller cannot mistake one for the other.
  return { hits, complete: false };
}
