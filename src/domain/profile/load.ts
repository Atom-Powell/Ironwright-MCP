import { ProfileSchema, type Profile } from "./schema.js";
import { normalizeProfileSites } from "./base.js";

/**
 * Validation messages are the product here. A mapping mistake that slips through
 * surfaces later as a wrong compliance finding, which is far more expensive to
 * diagnose than a rejected profile, so every issue names its path.
 */
export class ProfileValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`profile is not valid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ProfileValidationError";
    this.issues = issues;
  }
}

export function loadProfile(input: unknown): Profile {
  const result = ProfileSchema.safeParse(normalizeProfileSites(input));
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });

  throw new ProfileValidationError(issues);
}
