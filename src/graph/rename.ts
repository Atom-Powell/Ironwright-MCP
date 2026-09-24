import type { GraphClient } from "./client.js";
import { GraphRequestError } from "./errors.js";
import { driveItemPath } from "./paths.js";
import { etagOf, relocateDriveItem } from "./relocate.js";

/**
 * The three responses a rename can produce, kept apart rather than collapsed
 * into success-or-throw. A 412 is the expected outcome of a plan applied
 * against a library other people also use, and it does not by itself say
 * whether the item changed or is simply gone: measured against the live
 * tenant (.superpowers/live-sitting/probe-precondition.ts, 2026-09-19), Graph
 * evaluates If-Match before existence, so a stale precondition against an
 * absent path also answers 412, never 404. A 404 therefore only reaches this
 * function when no If-Match precondition was sent, which does not happen
 * through this project's executor today. The mapping is kept anyway rather
 * than removed, since a branch on a write path is not removed on the strength
 * of a negative nobody can prove. Turning either into an exception would make
 * the executor catch its own normal path.
 */
export type RenameOutcome =
  | { kind: "renamed"; etag: string | undefined }
  | { kind: "precondition_failed" }
  | { kind: "not_found" };

export type EtagLookup = { kind: "found"; etag: string | undefined } | { kind: "not_found" };

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
 *
 * It is now a thin form of `relocateDriveItem` that never changes the folder,
 * kept so the body phase 6a verified live stays pinned by 6a's own tests.
 */
export async function renameDriveItem(
  client: Pick<GraphClient, "patch">,
  args: { driveId: string; path: string; newName: string; etag: string },
): Promise<RenameOutcome> {
  const outcome = await relocateDriveItem(client, {
    driveId: args.driveId,
    path: args.path,
    etag: args.etag,
    newName: args.newName,
  });
  return outcome.kind === "relocated" ? { kind: "renamed", etag: outcome.etag } : outcome;
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
