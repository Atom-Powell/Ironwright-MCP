/** Azure Table caps a transaction at 100 entities sharing one partition. */
export const MAX_TRANSACTION_SIZE = 100;

// Azure Table rejects these in a PartitionKey or RowKey. Control characters are
// rejected too and are covered by the same test.
const FORBIDDEN = /[/\\#?\u0000-\u001F\u007F-\u009F]/;

export class UnsafeKeyError extends Error {
  constructor(part: string, value: string) {
    super(
      `The ${part} "${value}" contains a character Azure Table forbids in a key (/, \\, #, ? or a ` +
        "control character). Refused rather than sanitized, because a sanitized key silently " +
        "collides with a different item's row.",
    );
    this.name = "UnsafeKeyError";
  }
}

/**
 * The profile id is already restricted to lowercase letters, digits and hyphens
 * by the profile schema, so a pipe cannot occur in it and the join is
 * unambiguous. The drive id is checked rather than encoded, because a readable
 * partition key is worth keeping when someone is looking at the table in a
 * portal, and a drive id containing a forbidden character would be a Graph
 * change worth failing loudly on.
 */
export function inventoryPartitionKey(profileId: string, driveId: string): string {
  if (FORBIDDEN.test(profileId)) throw new UnsafeKeyError("profile id", profileId);
  if (FORBIDDEN.test(driveId)) throw new UnsafeKeyError("drive id", driveId);
  return `${profileId}|${driveId}`;
}

/**
 * A driveItem id is an opaque string whose alphabet we do not control, so it is
 * encoded rather than checked. base64url keeps the result inside the characters
 * a key accepts and stays reversible, which a hash would not.
 */
export function encodeRowKey(itemId: string): string {
  return Buffer.from(itemId, "utf8").toString("base64url");
}

export function decodeRowKey(rowKey: string): string {
  return Buffer.from(rowKey, "base64url").toString("utf8");
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}
