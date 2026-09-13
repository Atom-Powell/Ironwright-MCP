export interface InventoryRecord {
  itemId: string;
  /** Library-relative, no leading slash. */
  path: string;
  name: string;
  isFolder: boolean;
  size: number;
  modified: string;
  /** Captured now because a later rename or move plan needs it as an If-Match precondition. */
  etag: string;
}

export type InventoryChange =
  | { kind: "upsert"; record: InventoryRecord }
  | { kind: "delete"; itemId: string };

export interface ApplyResult {
  changesApplied: number;
  /**
   * Write operations issued to the backing store: one per run of consecutive
   * upserts (chunked at the transaction size limit), and one per delete. Changes
   * are applied in arrival order, so a delete interrupts and closes out
   * whatever run of upserts is open, even short of the chunk limit; that is why
   * "chunk of upserts" means a run between deletes, not a chunking pass over
   * every upsert in the change list. Deletes are not batched with upserts
   * because the Table implementation cannot batch them: a transaction
   * containing a delete of a row that is not there fails as a whole, and this
   * store must tolerate that case, since the first incremental scan after a
   * resync sees deletes for items it never recorded. The in-memory
   * implementation counts the same way so the number the scan prints means one
   * thing regardless of which store produced it.
   */
  batches: number;
}

export interface StateStore {
  getDeltaLink(profileId: string, driveId: string): Promise<string | undefined>;
  setDeltaLink(profileId: string, driveId: string, deltaLink: string, lastScanAt: string): Promise<void>;
  /**
   * When this drive was last scanned to completion, or undefined if it never
   * has been. Separate from getDeltaLink because a caller resuming a scan needs
   * the link and an operator reading a report needs the timestamp, and widening
   * the link getter's return would change every call site for the sake of the
   * rarer one.
   */
  getLastScanAt(profileId: string, driveId: string): Promise<string | undefined>;
  clearInventory(profileId: string, driveId: string): Promise<void>;
  applyInventoryChanges(profileId: string, driveId: string, changes: InventoryChange[]): Promise<ApplyResult>;
  listInventory(profileId: string, driveId: string): Promise<InventoryRecord[]>;
}
