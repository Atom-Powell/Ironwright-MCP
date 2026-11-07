export type ToolKind = "read" | "plan" | "write" | "lifecycle";

/**
 * Fixed sentences rather than free prose, so the contract test can assert the
 * description actually says what the annotations claim. `plan` is a third kind
 * on purpose: a plan generator writes a plan to the state store, so calling it
 * read-only would be exactly the decorative annotation this avoids.
 *
 * A lifecycle tool is gated by live preconditions and a journal rather than a
 * dry run, per the 2026-11-06 Decision Record amendment.
 */
export const SAFETY_SENTENCES = {
  read: "Read-only: this tool makes no changes and is safe to repeat.",
  plan:
    "Not read-only: this tool saves a plan for review. It makes no changes to the repository, and repeated calls create separate plans.",
  destructiveWrite:
    "Destructive: this tool changes the repository when confirmed. It defaults to a dry run, and repeated calls are not idempotent.",
  additiveWrite:
    "Not read-only: this tool creates missing items in the repository when confirmed. It defaults to a dry run and skips items that already exist.",
  lifecycle:
    "Not read-only: this tool advances an assessment by one stage when its preconditions hold. It creates records and files only at paths the server computes, overwrites only files it created and only under an ETag precondition, refuses when the prior stage is not verified, and records every write in the assessment journal. It needs no confirm flag and is safe to retry: a stage already completed is reported, not repeated.",
} as const;

export function requiredSentence(kind: ToolKind, destructive: boolean): string {
  if (kind === "read") return SAFETY_SENTENCES.read;
  if (kind === "plan") return SAFETY_SENTENCES.plan;
  if (kind === "lifecycle") return SAFETY_SENTENCES.lifecycle;
  return destructive ? SAFETY_SENTENCES.destructiveWrite : SAFETY_SENTENCES.additiveWrite;
}
