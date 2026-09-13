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
 * The shapes a tracker's effective-date cell is allowed to hold: a bare month,
 * a date, or a date followed by a time after a "T" or a space.
 *
 * Anchored at both ends and spelling out every part it allows, so the
 * rejection message that quotes it ("is not an ISO date") is true of what the
 * check performs. Discarding the day is deliberate; accepting arbitrary text
 * where a day should be is not the same thing, and the earlier unanchored
 * pattern read "2026-06zzz", "2026-0615", "2026-06-99" and "2026-06T99:99"
 * all as June 2026 without complaint. Only the year and the month are
 * captured. The day is range-checked but not checked against its own month's
 * length, since it is discarded either way, and the month is left to
 * `assertValidMonth` so an out-of-range month gets its own message rather
 * than being lumped in with a malformed string.
 */
const ISO_EFFECTIVE_FROM =
  /^(\d{4})-(\d{2})(?:-(?:0[1-9]|[12]\d|3[01]))?(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/;

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
 * failure modes here name the client and quote the offending value.
 *
 * One malformed cell still aborts the whole report rather than excluding the
 * one client it belongs to. That is what this code does, and whether it is
 * the right behavior is an open question recorded in docs/OPEN-ITEMS.md under
 * "Should one bad workbook row abort the whole reconciliation?". Naming the
 * client and the value spares an operator bisecting a fifty-row spreadsheet
 * to find the cell; it does not spare them re-running the report.
 */
function effectiveFromPeriod(client: string, iso: string): Period {
  const match = ISO_EFFECTIVE_FROM.exec(iso);
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
 * The workbook's one structural contract: each client occupies exactly one
 * row.
 *
 * Two rows naming the same client is a data error rather than a redundancy
 * the engine can absorb, because the rows can carry different effectiveFrom
 * dates and different owed-deliverable cells and the sheet says nothing about
 * which of them governs. Merging them or keeping the first would be a guess
 * presented as an authoritative answer, which is the one thing this report
 * must not be.
 *
 * The check lives here, where the rows are first walked, for two reasons. It
 * is the only place the client's own name is still in hand -- further down
 * the pipeline the repeat has collapsed into a slot key and the name is one
 * field inside it. And a repeat is refused whether or not the client owes
 * anything, since the ambiguity about which row governs does not depend on
 * the cells happening to be filled in.
 */
function assertOneRowPerClient(workbook: WorkbookSnapshot): void {
  const seen = new Set<string>();
  for (const row of workbook.rows) {
    if (seen.has(row.client)) {
      throw new Error(
        `client "${row.client}" appears on more than one workbook row. Two rows can name different effectiveFrom dates and different owed deliverables, and the sheet does not say which governs, so merge them into one row for this client.`,
      );
    }
    seen.add(row.client);
  }
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
  assertOneRowPerClient(workbook);

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
