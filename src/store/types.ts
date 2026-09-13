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
  /** Write operations issued to the backing store. The scan reports this number. */
  batches: number;
}

export interface StateStore {
  getDeltaLink(profileId: string, driveId: string): Promise<string | undefined>;
  setDeltaLink(profileId: string, driveId: string, deltaLink: string, lastScanAt: string): Promise<void>;
  clearInventory(profileId: string, driveId: string): Promise<void>;
  applyInventoryChanges(profileId: string, driveId: string, changes: InventoryChange[]): Promise<ApplyResult>;
  listInventory(profileId: string, driveId: string): Promise<InventoryRecord[]>;
}
