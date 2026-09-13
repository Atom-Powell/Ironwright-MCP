/** A single calendar month. Every cadence resolves to one of these before rendering. */
export interface Period {
  year: number;
  /** 1 through 12. */
  month: number;
}

export interface ClientRecord {
  client: string;
  /**
   * Other mapped columns, keyed by profile field name rather than spreadsheet
   * header, so a renamed column fails in the mapping where it can be explained
   * rather than reaching the engine.
   */
  fields: Record<string, string | number | boolean | null>;
  /** ISO date, present only when the profile maps an effectiveFrom column. */
  effectiveFrom?: string;
}

export interface WorkbookSnapshot {
  rows: ClientRecord[];
  /** Where the rows came from, for the report's provenance. */
  source: string;
}

export interface RepositoryFile {
  /** Library-relative, no leading slash. */
  path: string;
  name: string;
  size: number;
  modified: string;
  /** Captured now because a later rename or move plan needs it as an If-Match precondition. */
  etag: string;
}

export interface RepositorySnapshot {
  files: RepositoryFile[];
  folderPaths: string[];
  scannedAt: string;
  /**
   * False when the Microsoft Search cross-check did not run. Without it a
   * correctly named file outside the expected taxonomy is invisible, so every
   * misplaced finding is unreliable and every missing finding is suspect. The
   * report carries this so callers cannot present a partial scan as complete.
   */
  searchCrossCheckIncluded: boolean;
}

export type ArtifactState =
  | "compliant"
  | "misnamed"
  | "misplaced"
  | "misnamed_and_misplaced"
  | "missing";

export interface MatchedFile {
  path: string;
  name: string;
  etag: string;
  /** Present when the name matched a recognizer rather than the canonical template. */
  recognizerId?: string;
}

export interface Slot {
  client: string;
  deliverable: string;
  period: Period;
}

export interface ArtifactFinding extends Slot {
  expectedPath: string;
  expectedName: string;
  state: ArtifactState;
  matched?: MatchedFile;
}

export interface DuplicateFinding {
  path: string;
  name: string;
  /** The slot this file also satisfies, already claimed by a better candidate. */
  slot: Slot;
  state: Exclude<ArtifactState, "missing">;
}

/**
 * `unrecognized` means the filename did not parse at all. `unexpected` means it
 * parsed cleanly but names a client, period or deliverable nobody owes, which
 * usually means the workbook is stale rather than the repository being wrong.
 */
export type OrphanKind = "unrecognized" | "unexpected";

export interface OrphanFinding {
  path: string;
  name: string;
  kind: OrphanKind;
  parsed?: Slot;
}

export interface ClientSummary {
  client: string;
  counts: Record<ArtifactState, number>;
  compliant: boolean;
}

export interface Provenance {
  scannedAt: string;
  searchCrossCheckIncluded: boolean;
  workbookSource: string;
}

export interface ReconciliationReport {
  profileId: string;
  window: { from: Period; to: Period };
  provenance: Provenance;
  artifacts: ArtifactFinding[];
  duplicates: DuplicateFinding[];
  orphans: OrphanFinding[];
  emptyFolders: string[];
  clients: ClientSummary[];
}
