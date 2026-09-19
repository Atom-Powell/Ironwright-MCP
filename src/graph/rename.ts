import type { GraphClient } from "./client.js";
import { GraphRequestError } from "./errors.js";
import { driveItemPath } from "./paths.js";

/**
 * The three responses a rename can produce, kept apart rather than collapsed
 * into success-or-throw. A 412 and a 404 are expected outcomes of a plan
 * applied against a library other people also use, and an operator acts on
 * them differently: a 412 means re-plan, a 404 means the file moved or was
 * deleted. Turning either into an exception would make the executor catch its
 * own normal path.
 */
export type RenameOutcome =
  | { kind: "renamed"; etag: string | undefined }
  | { kind: "precondition_failed" }
  | { kind: "not_found" };

export type EtagLookup = { kind: "found"; etag: string | undefined } | { kind: "not_found" };

/**
 * An empty string is treated as absent. Graph does not return one, but an
 * empty etag is not a usable If-Match precondition either way, so collapsing
 * the two here means no caller downstream has to test for both.
 *
 * The null and undefined guard is not defensive padding. `createGraphClient`'s
 * `request()` returns `undefined as T` for a zero-length response body, and a
 * 204 passes its success check, so a PATCH Graph answers with no body at all
 * reaches this function as `undefined` rather than as an object missing its
 * `eTag`. Reading a property off that threw, and the executor's PATCH error
 * boundary caught the throw and reported an item as `failed` although the file
 * HAD been renamed, leaving its reversal entry on the stale pre-rename etag
 * with nothing counted anywhere. Both fakes modelled an absent etag as `{}`,
 * the one shape this function already handled, so the fakes and the code
 * agreed with each other and neither agreed with the real client.
 */
function etagOf(item: unknown): string | undefined {
  if (item === null || item === undefined) return undefined;
  const value = (item as { eTag?: unknown }).eTag;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Renames one driveItem in place, addressed by path.
 *
 * The etag is supplied by the caller rather than read here. A verb that
 * fetched its own precondition would have a race inside it: the fetch and the
 * write would be two calls, and a change landing between them would satisfy a
 * precondition that no longer described what the caller decided to act on.
 *
 * The returned etag is the item's new one, which the caller needs because the
 * rename invalidated the old one. Graph's documented response to a driveItem
 * PATCH is the updated item, so it should be present. It is reported as
 * undefined rather than guessed when it is not, because a fabricated
 * precondition is worse than an absent one: a caller can fetch a missing etag,
 * but it cannot detect an invented one.
 */
export async function renameDriveItem(
  client: Pick<GraphClient, "patch">,
  args: { driveId: string; path: string; newName: string; etag: string },
): Promise<RenameOutcome> {
  try {
    const updated = await client.patch<unknown>(
      driveItemPath(args.driveId, args.path),
      { name: args.newName },
      { "if-match": args.etag },
    );
    return { kind: "renamed", etag: etagOf(updated) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 412) return { kind: "precondition_failed" };
    if (error instanceof GraphRequestError && error.status === 404) return { kind: "not_found" };
    throw error;
  }
}

/**
 * Reads one driveItem's current etag, which is what a plan captures as its
 * precondition.
 *
 * Path addressing does double duty here. The path contains the filename, so an
 * item renamed or moved since the last scan answers 404 rather than returning
 * an etag for a file that is no longer the one the plan means. That is why
 * nothing downstream needs a separate check that the name is still what the
 * inventory recorded.
 */
export async function readDriveItemEtag(
  client: Pick<GraphClient, "get">,
  args: { driveId: string; path: string },
): Promise<EtagLookup> {
  try {
    const item = await client.get<unknown>(`${driveItemPath(args.driveId, args.path)}?$select=eTag`);
    return { kind: "found", etag: etagOf(item) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 404) return { kind: "not_found" };
    throw error;
  }
}
