import type { Profile } from "../profile/schema.js";
import { assertValidMonth } from "./months.js";
import { periodsInWindow } from "./period.js";
import { renderPath, renderTemplate } from "./render.js";
import type { ArtifactFinding, ClientRecord, Period, WorkbookSnapshot } from "./types.js";

type Deliverable = Profile["deliverables"][number];

/**
 * Hand-maintained trackers record ownership as text rather than a boolean, so
 * ordinary JS truthiness is not enough: the string "No" is truthy and would
 * mark every client as owing every deliverable it has a column for. "no" and
 * "false" are therefore treated as falsey regardless of case, on top of the
 * values that are already falsey (empty string, 0, null, undefined).
 */
function isOwed(value: string | number | boolean | null | undefined): boolean {
  if (!value) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "no" || normalized === "false") return false;
    // Deliberately unresolved: the brief pins exactly "no" and "false" as the
    // hand-typed falsey words, so a cell containing "0" reads as owed here.
    // A person typing "0" into a mostly-boolean column plausibly means not
    // owed, but that is a guess beyond what was specified, not an oversight.
  }
  return true;
}

function owesDeliverable(row: ClientRecord, deliverable: Deliverable): boolean {
  const field = deliverable.appliesTo.workbookField;
  // The profile validator already guarantees `field` is a key in
  // workbookMapping.columns, so its absence here means this particular row
  // left the cell blank rather than the profile being wrong. Blank means not
  // owed, not a thrown error.
  if (!(field in row.fields)) return false;
  return isOwed(row.fields[field]);
}

/**
 * Reads the leading year and month out of an ISO date string by pattern
 * rather than through `Date`, so a workbook's effective date is never read
 * against the server's local timezone or the moment the parse happens to
 * run. The day is deliberately discarded: cadences resolve to a month, never
 * a day, so a client onboarded on the 15th is treated identically to one
 * onboarded on the 1st of the same month.
 *
 * Nothing upstream validates a workbook cell's contents the way the profile
 * validator validates the profile itself: `ClientRecord.effectiveFrom` is
 * whatever string the spreadsheet held. A hand-maintained tracker is exactly
 * where a date typed "15/08/2026" or otherwise malformed shows up, so both
 * failure modes here name the client and quote the offending value, rather
 * than aborting a fifty-row report with a message that leaves an operator to
 * bisect the spreadsheet to find the bad cell.
 */
function effectiveFromPeriod(client: string, iso: string): Period {
  const match = /^(\d{4})-(\d{2})/.exec(iso);
  if (!match) {
    throw new Error(`client "${client}" has an effectiveFrom that is not an ISO date: "${iso}"`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  try {
    assertValidMonth(month);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`client "${client}" has an invalid effectiveFrom "${iso}": ${reason}`);
  }
  return { year, month };
}

/**
 * Derives every artifact a client should have on file: the cross product of
 * client, the deliverables that client owes, and the periods that
 * deliverable's cadence produces inside the profile's window. Every finding
 * starts as "missing" with no matched file; matching (a later stage) is what
 * can promote a finding to one of the other four states.
 *
 * The `deliverable` field on each finding carries the deliverable's `id`, the
 * stable key recognizers and `appliesTo` reference, rather than its `token`.
 * The token is a rendering detail: it fills the `{deliverable}` placeholder
 * in the taxonomy and filename templates, so it can differ from the id
 * without the finding's own identity shifting under it.
 */
export function deriveExpected(profile: Profile, workbook: WorkbookSnapshot, asOf: Period): ArtifactFinding[] {
  const findings: ArtifactFinding[] = [];

  for (const row of workbook.rows) {
    for (const deliverable of profile.deliverables) {
      if (!owesDeliverable(row, deliverable)) continue;

      const effectiveFrom =
        profile.window.respectEffectiveFrom && row.effectiveFrom !== undefined
          ? effectiveFromPeriod(row.client, row.effectiveFrom)
          : undefined;

      const periods = periodsInWindow({
        asOf,
        months: profile.window.months,
        cadence: deliverable.cadence,
        anchor: deliverable.periodAnchor,
        effectiveFrom,
      });

      for (const period of periods) {
        const context = { period, client: row.client, deliverable: deliverable.token };
        findings.push({
          client: row.client,
          deliverable: deliverable.id,
          period,
          expectedPath: renderPath(profile.taxonomy.segments, context),
          expectedName: renderTemplate(profile.naming.template, context),
          state: "missing",
        });
      }
    }
  }

  return findings;
}
