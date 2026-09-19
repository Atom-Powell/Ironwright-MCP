import { randomUUID } from "node:crypto";

export type PlanIdPrefix = "rnm" | "rev";

/**
 * Eight hex characters rather than four.
 *
 * `savePlan` replaces whatever is stored under an id, which is what lets an
 * executor correct a reversal entry's etag. The same property makes a collision
 * silent and destructive: a second plan generated on the same day under the same
 * suffix would overwrite a plan a human had already reviewed, with nothing
 * raised anywhere. Four characters is 65536 values, which is inside birthday
 * range for a busy day; eight is not.
 */
export function newPlanId(prefix: PlanIdPrefix, now: Date, suffix: () => string = defaultSuffix): string {
  return `${prefix}-${now.toISOString().slice(0, 10)}-${suffix()}`;
}

function defaultSuffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}
