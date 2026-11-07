import type { GraphClient } from "./client.js";
import { GraphRequestError } from "./errors.js";
import { driveItemPath } from "./paths.js";
import { etagOf } from "./relocate.js";

/** The small upload path's ceiling. Above it Graph wants an upload session, which has no caller yet. */
export const MAX_SMALL_UPLOAD_BYTES = 4 * 1024 * 1024;

export interface DriveItemFacts {
  id: string;
  name: string;
  eTag: string | undefined;
  size: number | undefined;
  lastModifiedDateTime: string | undefined;
  webUrl: string | undefined;
  isFolder: boolean;
}

export type DriveItemLookup = { kind: "found"; item: DriveItemFacts } | { kind: "not_found" };
export type CreateFolderOutcome = { kind: "created"; item: DriveItemFacts } | { kind: "already_exists" };
export type CreateFileOutcome = { kind: "created"; item: DriveItemFacts } | { kind: "name_conflict" };
export type OverwriteFileOutcome = { kind: "overwritten"; item: DriveItemFacts } | { kind: "precondition_failed" };

export class UploadTooLargeError extends Error {
  constructor(received: number) {
    super(
      `The content is ${received} bytes, and the small upload path this server uses is capped at ${MAX_SMALL_UPLOAD_BYTES} bytes. ` +
        "Nothing was sent. Larger content needs the upload session API, which this server does not implement.",
    );
    this.name = "UploadTooLargeError";
  }
}

/**
 * Reads the facts the module needs from the item Graph returns. Every field
 * other than id and name is optional because Graph's projection is what it is
 * and a missing eTag is reported as undefined rather than invented; the
 * reasoning is in rename.ts beside readDriveItemEtag.
 */
export function driveItemFacts(item: unknown): DriveItemFacts {
  const record = (item ?? {}) as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof record[key] === "string" ? (record[key] as string) : undefined);
  const id = str("id");
  const name = str("name");
  if (id === undefined || name === undefined) {
    throw new Error("Graph returned a driveItem without an id or a name, which this server cannot act on.");
  }
  return {
    id,
    name,
    eTag: etagOf(item),
    size: typeof record.size === "number" ? record.size : undefined,
    lastModifiedDateTime: str("lastModifiedDateTime"),
    webUrl: str("webUrl"),
    isFolder: typeof record.folder === "object" && record.folder !== null,
  };
}

const ITEM_SELECT = "$select=id,name,eTag,size,lastModifiedDateTime,webUrl,folder,file";

export async function readDriveItem(client: Pick<GraphClient, "get">, args: { driveId: string; path: string }): Promise<DriveItemLookup> {
  try {
    const item = await client.get<unknown>(`${driveItemPath(args.driveId, args.path)}?${ITEM_SELECT}`);
    return { kind: "found", item: driveItemFacts(item) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 404) return { kind: "not_found" };
    throw error;
  }
}

/**
 * conflictBehavior fail, measured 2026-11-07 (F0, F1a, F1b): a present folder
 * answers 409 nameAlreadyExists, which the caller treats as satisfied because
 * the workspace tree is additive and a retry must not fail on its own earlier
 * success. Only that code is mapped; any other 409 is rethrown.
 */
export async function createFolder(
  client: Pick<GraphClient, "post">,
  args: { driveId: string; parentPath: string; name: string },
): Promise<CreateFolderOutcome> {
  try {
    const item = await client.post<unknown>(`${driveItemPath(args.driveId, args.parentPath)}/children`, {
      name: args.name,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
    return { kind: "created", item: driveItemFacts(item) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 409 && error.code === "nameAlreadyExists") return { kind: "already_exists" };
    throw error;
  }
}

function checkSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_SMALL_UPLOAD_BYTES) throw new UploadTooLargeError(bytes.byteLength);
}

/**
 * Create only: an occupied name answers 409 nameAlreadyExists and nothing is
 * replaced (F2a, F2b). The ETag comes back in the body; the content PUT
 * carries no ETag header (F2a).
 */
export async function createFile(
  client: Pick<GraphClient, "putBytes">,
  args: { driveId: string; path: string; bytes: Uint8Array; contentType: string },
): Promise<CreateFileOutcome> {
  checkSize(args.bytes);
  try {
    const item = await client.putBytes<unknown>(
      `${driveItemPath(args.driveId, args.path)}/content?@microsoft.graph.conflictBehavior=fail`,
      args.bytes,
      args.contentType,
    );
    return { kind: "created", item: driveItemFacts(item) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 409 && error.code === "nameAlreadyExists") return { kind: "name_conflict" };
    throw error;
  }
}

/**
 * Update only in intent, but not in Graph's eyes: measured 2026-11-07 (F3c), a
 * PUT under If-Match against a path holding nothing CREATES the file and
 * answers 201. The precondition proves only that an existing file is
 * unchanged. The caller therefore reads the item first and never reaches this
 * function for an absent path; this function does not re-check, because a
 * second read here would reintroduce the race the single read avoids. A
 * stale ETag answers 412 with code notAllowed (F3b), so the match is on status.
 */
export async function overwriteFile(
  client: Pick<GraphClient, "putBytes">,
  args: { driveId: string; path: string; bytes: Uint8Array; contentType: string; etag: string },
): Promise<OverwriteFileOutcome> {
  checkSize(args.bytes);
  try {
    const item = await client.putBytes<unknown>(`${driveItemPath(args.driveId, args.path)}/content`, args.bytes, args.contentType, {
      "if-match": args.etag,
    });
    return { kind: "overwritten", item: driveItemFacts(item) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 412) return { kind: "precondition_failed" };
    throw error;
  }
}
