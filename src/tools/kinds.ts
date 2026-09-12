export type ToolKind = "read" | "plan" | "write";

/**
 * Fixed sentences rather than free prose, so the contract test can assert the
 * description actually says what the annotations claim. `plan` is a third kind
 * on purpose: a plan generator writes a plan to the state store, so calling it
 * read-only would be exactly the decorative annotation this project avoids.
 */
export const SAFETY_SENTENCES = {
  read: "Read-only: this tool makes no changes and is safe to repeat.",
  plan:
    "Not read-only: this tool saves a plan for review. It makes no changes to the repository, and repeated calls create separate plans.",
  destructiveWrite:
    "Destructive: this tool changes the repository when confirmed. It defaults to a dry run, and repeated calls are not idempotent.",
  additiveWrite:
    "Not read-only: this tool creates missing items in the repository when confirmed. It defaults to a dry run and skips items that already exist.",
} as const;

export function requiredSentence(kind: ToolKind, destructive: boolean): string {
  if (kind === "read") return SAFETY_SENTENCES.read;
  if (kind === "plan") return SAFETY_SENTENCES.plan;
  return destructive ? SAFETY_SENTENCES.destructiveWrite : SAFETY_SENTENCES.additiveWrite;
}
