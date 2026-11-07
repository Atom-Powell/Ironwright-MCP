import type { InventoryChange, InventoryRecord } from "./types.js";

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
 * One partition per assessment. The assessment id is rendered by the module
 * from a profile template, so its alphabet is the customer's choice and it
 * is checked rather than encoded, like the drive id: a forbidden character
 * here means the template needs changing, which is worth failing loudly on.
 */
export function journalPartitionKey(profileId: string, assessmentId: string): string {
  if (FORBIDDEN.test(profileId)) throw new UnsafeKeyError("profile id", profileId);
  if (FORBIDDEN.test(assessmentId)) throw new UnsafeKeyError("assessment id", assessmentId);
  return `${profileId}|journal|${assessmentId}`;
}

/** Sorts ascending by time, then by correlation id, as a row key and as a comparator. */
export function journalRowKey(entry: { at: string; correlationId: string }): string {
  return `${entry.at}|${entry.correlationId}`;
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

export type InventoryChangeStep =
  | { kind: "upsert"; records: InventoryRecord[] }
  | { kind: "delete"; itemId: string };

/**
 * Turns a change list into the write steps a store issues, preserving arrival
 * order. Delta orders its pages so a later entry supersedes an earlier one for
 * the same item, and a delete followed by a re-creation of the same item id is
 * what a restore from the recycle bin looks like, since the item keeps its id.
 * Applying every upsert before any delete, as this used to, would leave a
 * restored item absent. Consecutive upserts are still batched together, up to
 * `maxSize`, so an ordinary run of changes with no interleaved delete costs the
 * same number of write operations as before; a delete simply closes out
 * whatever batch is open, including one still short of `maxSize`.
 */
export function planInventoryChanges(changes: readonly InventoryChange[], maxSize: number): InventoryChangeStep[] {
  const steps: InventoryChangeStep[] = [];
  let buffer: InventoryRecord[] = [];

  function flush(): void {
    if (buffer.length === 0) return;
    steps.push({ kind: "upsert", records: buffer });
    buffer = [];
  }

  for (const change of changes) {
    if (change.kind === "upsert") {
      buffer.push(change.record);
      if (buffer.length >= maxSize) flush();
    } else {
      flush();
      steps.push({ kind: "delete", itemId: change.itemId });
    }
  }
  flush();

  return steps;
}
