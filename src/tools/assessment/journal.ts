import type { JournalEntry } from "../../store/types.js";
import type { ToolContext } from "../context.js";
import type { AssessmentContext } from "./context.js";

/**
 * Appended after the write it records has been confirmed, never before: the
 * store keeps duplicate rows (9b amendment), so journaling an intent that then
 * failed would leave a row describing a write that never happened.
 */
export async function appendJournal(
  context: ToolContext,
  ac: AssessmentContext,
  assessmentId: string,
  entry: Omit<JournalEntry, "at" | "correlationId">,
): Promise<void> {
  await context.store.appendJournalEntry(ac.profile.profileId, assessmentId, {
    at: context.now().toISOString(),
    correlationId: ac.correlationId,
    ...entry,
  });
}
