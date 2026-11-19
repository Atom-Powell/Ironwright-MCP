import { JournalEntrySchema, type JournalEntry } from "../../store/types.js";
import { createListItem, odataString, queryListItems } from "../../graph/lists.js";
import { GraphRequestError } from "../../graph/errors.js";
import { isGatewayStatus } from "../../graph/retry.js";
import { compareJournalEntries } from "../../store/keys.js";
import type { ToolContext } from "../context.js";
import type { AssessmentContext } from "./context.js";

/** The entry fields in the order the journal list's columns map them. */
const ENTRY_FIELDS = ["assessmentId", "at", "correlationId", "stage", "operation", "target", "etagBefore", "etagAfter", "contentHash", "priorContentHash", "versionId"] as const;

/** Thrown when a journal list item cannot be read as an entry. Refused, not skipped: a journal missing an entry reads as a complete record. */
export class MalformedJournalItemError extends Error {
  constructor(listName: string, itemId: string, detail: string) {
    super(`Journal item ${itemId} in list "${listName}" cannot be read: ${detail}. Refused rather than skipped, because a journal missing an entry reads as a complete record.`);
    this.name = "MalformedJournalItemError";
  }
}

/**
 * The store refused a journal entry for a write Graph had already confirmed.
 * It carries what was written, because the store's own error does not: a
 * caller told only "the table service did not answer" would read it as a call
 * that did nothing, and the write is on the customer's site.
 */
export class JournalAppendError extends Error {
  readonly operation: JournalEntry["operation"];
  readonly target: string;
  readonly assessmentId: string;

  constructor(entry: Pick<JournalEntry, "operation" | "target">, assessmentId: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // A journal list item create that ended on a gateway status may have landed, and the client
    // retries a plain POST on one, so the entry may be missing or there twice. Said as not known.
    const unknown = cause instanceof GraphRequestError && isGatewayStatus(cause.status);
    super(
      `Graph confirmed ${entry.operation} at ${entry.target}, and the journal entry for it could not be stored (${detail}). ` +
        (unknown
          ? `The write stands. Whether the journal for ${assessmentId} shows it is not known: the create ended on a gateway status, so the entry may be missing or may be there twice.`
          : `The write stands, and the journal for ${assessmentId} does not show it.`),
    );
    this.name = "JournalAppendError";
    this.operation = entry.operation;
    this.target = entry.target;
    this.assessmentId = assessmentId;
  }
}

/**
 * Appended after the write it records has been confirmed, never before: the
 * store keeps duplicate rows (9b amendment), so journaling an intent that then
 * failed would leave a row describing a write that never happened.
 *
 * That order means a failure here follows a write that happened, so it is
 * rethrown as a JournalAppendError naming the write. No caller catches it and
 * carries on: a lifecycle tool that cannot journal stops, rather than making
 * further writes the journal would also lack.
 */
export async function appendJournal(
  context: ToolContext,
  ac: AssessmentContext,
  assessmentId: string,
  entry: Omit<JournalEntry, "at" | "correlationId">,
): Promise<void> {
  const full: JournalEntry = { at: context.now().toISOString(), correlationId: ac.correlationId, ...entry };
  try {
    const list = ac.profile.lists.journal;
    if (list === undefined) {
      await context.store.appendJournalEntry(ac.profile.profileId, assessmentId, full);
      return;
    }
    // One item per entry, in the workflow's own site. Its title is for a person reading the list in the browser.
    const values: Record<string, string> = { ...full, assessmentId } as unknown as Record<string, string>;
    const fields: Record<string, string> = { Title: `${assessmentId} ${full.stage} ${full.operation}` };
    for (const field of ENTRY_FIELDS) {
      if (values[field] !== undefined) fields[list.columns[field]] = values[field];
    }
    await createListItem(context.graph, { siteId: ac.siteId, listName: list.name, fields });
  } catch (error) {
    throw new JournalAppendError(entry, assessmentId, error);
  }
}

/**
 * One assessment's journal, ascending by time then correlation id, from the
 * profile's journal list when it names one and from the store otherwise.
 */
export async function readJournal(context: ToolContext, ac: AssessmentContext, assessmentId: string): Promise<JournalEntry[]> {
  const list = ac.profile.lists.journal;
  if (list === undefined) return context.store.listJournal(ac.profile.profileId, assessmentId);

  // Pages of 500, so the query's page cap sits at thousands of entries, far past any one case.
  const rows = await queryListItems(context.graph, { siteId: ac.siteId, listName: list.name, filter: `fields/${list.columns.assessmentId} eq ${odataString(assessmentId)}`, top: 500 });
  // SharePoint's eq on text ignores case; the store keys by the exact id, and so does this.
  const own = rows.filter((row) => row.fields[list.columns.assessmentId] === assessmentId);
  const entries = own.map((row) => {
    const candidate: Record<string, unknown> = {};
    for (const field of ENTRY_FIELDS) {
      if (field === "assessmentId") continue;
      const value = row.fields[list.columns[field]];
      if (value !== undefined && value !== null && value !== "") candidate[field] = value;
    }
    const parsed = JournalEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "entry"} ${issue.message}`).join("; ");
      throw new MalformedJournalItemError(list.name, row.id, detail);
    }
    return parsed.data;
  });
  return entries.sort(compareJournalEntries);
}
