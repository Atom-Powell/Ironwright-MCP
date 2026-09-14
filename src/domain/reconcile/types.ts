import type { z } from "zod";
import type { VerdictSchema } from "../profile/schema.js";

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

/** A workbook row the reader could not turn into a `ClientRecord`. */
export interface RejectedWorkbookRow {
  /** 1-based row number in the sheet, so it matches what the operator sees. */
  row: number;
  /** The client the row named, when that cell was readable. */
  client?: string;
  /** Why it was refused, in terms an operator can act on. */
  reason: string;
}

export interface WorkbookSnapshot {
  /**
   * One row per client. The engine enforces this rather than trusting it: two
   * rows naming one client can disagree about effectiveFrom and about which
   * deliverables are owed, so a mapping layer that produced both is refused
   * by name instead of having one of them silently win.
   */
  rows: ClientRecord[];
  /** Where the rows came from, for the report's provenance. */
  source: string;
  /** Rows the workbook reader refused rather than turning into a `ClientRecord`. */
  rejectedRows: RejectedWorkbookRow[];
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
 * `unrecognized` means the filename did not parse at all.
 *
 * `unexpected` means it parsed cleanly but the client, deliverable and period
 * it names have no slot in this report. Two different situations produce that,
 * and the engine cannot tell them apart because both are the same absent slot
 * key: nobody owes the artifact at all, and the artifact is owed but its
 * period lies outside the reporting window or before the client's effective
 * date. Naming a cause here -- a stale workbook, say -- would assert something
 * the engine did not observe, so the kind states only what it saw.
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
  /**
   * Rows the workbook reader could not turn into records. They live on the
   * report because a client silently missing from a compliance report is the
   * quiet incompleteness this engine exists to prevent, and a rejection that
   * reaches only a log is exactly that.
   */
  rejectedWorkbookRows: RejectedWorkbookRow[];
}

export interface ParsedFileUnrecognized {
  recognized: false;
  file: RepositoryFile;
}

export interface ParsedFileRecognized extends Slot {
  recognized: true;
  file: RepositoryFile;
  /**
   * "canonical" comes from matching `naming.template` itself; the other two
   * are a recognizer's own declared verdict, carried through unchanged so an
   * accepted alias reads as correctly named and a legacy pattern reads as
   * misnamed.
   */
  nameVerdict: "canonical" | z.infer<typeof VerdictSchema>;
  /** Present only when a recognizer matched, never for a canonical match. */
  recognizerId?: string;
}

/**
 * The outcome of trying to read a client, deliverable and period out of a
 * repository file's name. `false` means the name did not parse at all; a
 * file that parses but names a client, period or deliverable nobody owes is
 * still `recognized: true` here, since that judgment belongs to the matching
 * stage, not to parsing.
 */
export type ParsedFile = ParsedFileRecognized | ParsedFileUnrecognized;
