import type { VerificationOutcome } from "./steps.js";

/**
 * Lives here rather than beside the orchestrator so that cli.ts, which formats
 * this error, does not have to import run.ts and transitively pull the adapter's
 * network code into a module graph that is meant to be pure.
 */
export class SetupFailedError extends Error {
  readonly outcome: Extract<VerificationOutcome, { ok: false }>;

  constructor(outcome: Extract<VerificationOutcome, { ok: false }>) {
    super(outcome.message);
    this.name = "SetupFailedError";
    this.outcome = outcome;
  }
}
