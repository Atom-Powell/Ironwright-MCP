import type { JournalEntry } from "../../store/types.js";
import type { ToolContext } from "../context.js";
import type { AssessmentContext } from "./context.js";

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
    super(
      `Graph confirmed ${entry.operation} at ${entry.target}, and the journal entry for it could not be stored (${detail}). ` +
        `The write stands, and the journal for ${assessmentId} does not show it.`,
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
  try {
    await context.store.appendJournalEntry(ac.profile.profileId, assessmentId, {
      at: context.now().toISOString(),
      correlationId: ac.correlationId,
      ...entry,
    });
  } catch (error) {
    throw new JournalAppendError(entry, assessmentId, error);
  }
}
