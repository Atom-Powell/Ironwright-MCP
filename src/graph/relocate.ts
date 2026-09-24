import type { GraphClient } from "./client.js";
import { GraphRequestError } from "./errors.js";
import { driveItemPath } from "./paths.js";

/**
 * The three responses a relocation can produce, kept apart rather than
 * collapsed into success-or-throw, for the reasons `renameDriveItem` records:
 * a 412 is the expected outcome of a plan applied against a library other
 * people use, and Graph evaluates If-Match before existence, so a 404 is
 * unreachable while every call carries a precondition. It is mapped anyway,
 * since a branch on a write path is not removed on the strength of a negative
 * nobody can prove.
 *
 * An absent target folder answers 400 `invalidRequest` with the generic message
 * "Invalid request" (measured 2026-09-24), which cannot be told apart from any
 * other malformed request, so it is rethrown rather than given an outcome of
 * its own. Plan generation excludes that case before it can reach here.
 *
 * An occupied target name answers 409 `nameAlreadyExists` under
 * `conflictBehavior: fail` (measured 2026-09-24): nothing is replaced, and the
 * incoming file stays where it was. Only that code is mapped; any other 409 is
 * rethrown, since no other was measured.
 */
export type RelocateOutcome =
  | { kind: "relocated"; etag: string | undefined }
  | { kind: "precondition_failed" }
  | { kind: "not_found" }
  | { kind: "name_conflict" };

export class EmptyRelocationError extends Error {
  constructor(path: string) {
    super(
      `A relocation of "${path}" named neither a new name nor a new folder. Refused before any request, because ` +
        "a PATCH with an empty body would succeed while changing nothing, and the executor would count it as applied.",
    );
    this.name = "EmptyRelocationError";
  }
}

/**
 * An empty string is treated as absent. Graph does not return one, but an
 * empty etag is not a usable If-Match precondition either way.
 *
 * The null and undefined guard is not defensive padding. `createGraphClient`'s
 * `request()` returns `undefined as T` for a zero-length body, and a 204 passes
 * its success check, so a PATCH answered with no body reaches this function as
 * `undefined`. Reading a property off that once made the executor report a
 * rename that HAD happened as failed.
 */
export function etagOf(item: unknown): string | undefined {
  if (item === null || item === undefined) return undefined;
  const value = (item as { eTag?: unknown }).eTag;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The target folder of a move, in the form the 2026-09-24 probes measured
 * Graph accepting: `/drives/{driveId}/root:/{folder}` with the folder written
 * RAW. Unlike `driveItemPath`, this value travels in the JSON body rather than
 * the URL, and Graph answered an `encodeURIComponent`-encoded folder with the
 * same generic 400 an absent folder gets, while raw names containing a space,
 * `#`, `%`, `&`, `'`, `+`, `;`, `,` and non-ASCII letters all landed. Encoding
 * it because Graph returns `parentReference.path` encoded is the natural
 * mistake, and it would read as a missing folder rather than an encoding
 * error. The library root is `root:` with nothing after it, also measured.
 */
export function parentReferencePath(driveId: string, folder: string): string {
  const trimmed = folder.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return `/drives/${driveId}/root:`;
  return `/drives/${driveId}/root:/${trimmed}`;
}

/**
 * Renames a driveItem, moves it to another folder of the same drive, or both,
 * in one PATCH addressed by path. The 2026-09-24 probe measured one PATCH
 * carrying `name` and `parentReference` applying both.
 *
 * A move always sends `conflictBehavior: fail`. Graph's default already refused
 * an occupied target name with 409 when measured, but that default is
 * undocumented, and a replace would silently destroy the file already there. A
 * rename that keeps its folder sends exactly `{ name }`, the body phase 6a
 * verified live, so nothing about a rename changes.
 *
 * The etag is supplied by the caller rather than read here, for the reason
 * `renameDriveItem` gives: a verb that fetched its own precondition would race
 * itself.
 */
export async function relocateDriveItem(
  client: Pick<GraphClient, "patch">,
  args: { driveId: string; path: string; etag: string; newName?: string; newParentPath?: string },
): Promise<RelocateOutcome> {
  if (args.newName === undefined && args.newParentPath === undefined) {
    throw new EmptyRelocationError(args.path);
  }

  const body: Record<string, unknown> = {};
  if (args.newName !== undefined) body.name = args.newName;
  if (args.newParentPath !== undefined) {
    body.parentReference = { path: parentReferencePath(args.driveId, args.newParentPath) };
    body["@microsoft.graph.conflictBehavior"] = "fail";
  }

  try {
    const updated = await client.patch<unknown>(driveItemPath(args.driveId, args.path), body, {
      "if-match": args.etag,
    });
    return { kind: "relocated", etag: etagOf(updated) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 412) return { kind: "precondition_failed" };
    if (error instanceof GraphRequestError && error.status === 404) return { kind: "not_found" };
    if (error instanceof GraphRequestError && error.status === 409 && error.code === "nameAlreadyExists") {
      return { kind: "name_conflict" };
    }
    throw error;
  }
}
