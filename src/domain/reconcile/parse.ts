import { TOKEN_PATTERN } from "../profile/placeholders.js";
import type { Profile } from "../profile/schema.js";
import { MONTH_NAMES } from "./months.js";
import { anchorPeriod } from "./period.js";
import { renderTemplate } from "./render.js";
import type { ParsedFile, Period, RepositoryFile } from "./types.js";

type Deliverable = Profile["deliverables"][number];
type Recognizer = Profile["naming"]["recognizers"][number];

// The runtime shape of a successful regex match's named captures. TypeScript
// types this with an index signature, so under noUncheckedIndexedAccess every
// property read comes back possibly undefined, which matches reality: a named
// group that exists in the pattern but did not participate in this particular
// match (or was never declared at all) reads as undefined, not as a missing
// key throwing.
type Captures = NonNullable<RegExpExecArray["groups"]>;

interface RawMatch {
  client: string;
  deliverable: string;
  period: Period;
}

/**
 * A raw match plus the deliverable object it resolved to, so a caller that
 * needs the deliverable's token (canonical round-trip rendering) or its
 * cadence rules is not forced to look it up a second time.
 */
interface Resolved {
  match: RawMatch;
  deliverable: Deliverable;
}

/**
 * Splits a template into its literal text and its placeholders, in the order
 * they appear, using the exact token pattern the renderer and the profile
 * validator already use to find `{...}` placeholders. Building this list with
 * a second, hand-rolled notion of where a placeholder starts and ends is
 * exactly the drift the design calls out: a template change would then update
 * rendering while silently leaving the matcher behind, or vice versa.
 */
function tokenizeTemplate(template: string): Array<{ literal: string } | { placeholder: string }> {
  // A fresh clone, not the shared singleton: exec() on a global regex mutates
  // its own lastIndex, and reusing the module's own TOKEN_PATTERN object here
  // would leave that shared state wherever this loop last stopped.
  const pattern = new RegExp(TOKEN_PATTERN.source, TOKEN_PATTERN.flags);
  const parts: Array<{ literal: string } | { placeholder: string }> = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template))) {
    if (match.index > cursor) {
      parts.push({ literal: template.slice(cursor, match.index) });
    }
    parts.push({ placeholder: match[1] ?? "" });
    cursor = match.index + match[0].length;
  }
  if (cursor < template.length) {
    parts.push({ literal: template.slice(cursor) });
  }
  return parts;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A capture group's name, keyed by what it feeds rather than by the literal
 * placeholder spelling: "month" and "month:02" both describe the same
 * captured value, so they share one group. Defining the same named group
 * twice is a regex syntax error, so a placeholder repeated within one
 * template falls back to a backreference instead of a second definition. No
 * real profile repeats a placeholder in one template; this only stops a
 * pathological one from throwing at matcher-build time.
 */
function namedGroup(name: string, body: string, seen: Set<string>): string {
  if (seen.has(name)) return `\\k<${name}>`;
  seen.add(name);
  return `(?<${name}>${body})`;
}

/**
 * The deliverable capture as an alternation of every declared token, longest
 * first. A plain wildcard would let a token that is a prefix of a longer one
 * (for example "Training" inside "TrainingAdvanced") match first and steal
 * characters that belong to the real, longer token: regex alternation tries
 * branches left to right and stops at the first that fits, it does not
 * search for the longest overall match.
 */
function deliverableAlternation(deliverables: readonly Deliverable[]): string {
  return deliverables
    .map((deliverable) => deliverable.token)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
}

/**
 * Builds the one and only definition of what a canonical filename looks
 * like, by converting `naming.template`'s placeholders into named capture
 * groups. Nothing here restates the template; reading it is the entire
 * source of truth, exactly as `renderTemplate` reads it to produce the name
 * in the first place.
 *
 * The client capture is greedy (`.+`), not lazy, because the deliverable
 * capture right after it is anchored to a closed, known set of tokens (see
 * `deliverableAlternation`) rather than another open-ended wildcard. Regex
 * backtracking then finds the true boundary between the two groups even when
 * the client name itself contains the template's own separator character:
 * a greedy client match is retried from its longest possible length downward,
 * so the first split that lets the rest of the pattern succeed is also the
 * longest valid client name, which is the correct one. A lazy client capture
 * would instead stop at the first separator it meets, which is wrong whenever
 * the client name contains one itself.
 */
function buildCanonicalPattern(profile: Profile): RegExp {
  const alternation = deliverableAlternation(profile.deliverables);
  const seen = new Set<string>();
  let source = "^";
  for (const part of tokenizeTemplate(profile.naming.template)) {
    if ("literal" in part) {
      source += escapeRegExp(part.literal);
      continue;
    }
    switch (part.placeholder) {
      case "year":
        source += namedGroup("year", "\\d{4}", seen);
        break;
      case "month":
        source += namedGroup("month", "\\d{1,2}", seen);
        break;
      case "month:02":
        // Deliberately a stricter two-digit body than plain {month}, not the
        // same \d{1,2}: renderTemplate always zero-pads a {month:02} token,
        // so a canonical name built from this template can never contain a
        // single unpadded digit here. Accepting one or two digits anyway
        // would make the matcher's canonical set a strict superset of what
        // the renderer can ever produce, and Task 4 turns a "canonical"
        // verdict straight into "compliant" without re-checking it.
        source += namedGroup("month", "\\d{2}", seen);
        break;
      case "monthName":
        source += namedGroup("monthName", "[A-Za-z]+", seen);
        break;
      case "client":
        source += namedGroup("client", ".+", seen);
        break;
      case "deliverable":
        source += namedGroup("deliverable", alternation, seen);
        break;
      default:
        // The profile schema already rejects any placeholder outside the
        // closed PLACEHOLDERS set, so a template that reached here already
        // validated. Reaching this branch means a bug upstream, not a bad
        // profile, so the unknown token is dropped rather than silently
        // treated as literal text that could never match anything anyway.
        break;
    }
  }
  source += "$";
  return new RegExp(source);
}

/**
 * Reads a captured month name against the same fixed English table the
 * renderer uses, case-insensitively, and also accepts the three-letter
 * abbreviation, because both spellings appear in real repositories. Anything
 * else, including a misspelling, returns undefined rather than guessing.
 */
function normalizeMonthName(name: string): number | undefined {
  const lower = name.toLowerCase();
  const fullIndex = MONTH_NAMES.findIndex((month) => month.toLowerCase() === lower);
  if (fullIndex !== -1) return fullIndex + 1;
  if (lower.length === 3) {
    const abbreviationIndex = MONTH_NAMES.findIndex((month) => month.toLowerCase().startsWith(lower));
    if (abbreviationIndex !== -1) return abbreviationIndex + 1;
  }
  return undefined;
}

/**
 * Validates a captured numeric month, rejecting anything outside 1-12 (a
 * two-digit group can still capture "13") rather than letting it through.
 * See `resolveRawPeriod` for why an invalid month must fail the parse
 * entirely rather than producing a period nobody can own.
 */
function normalizeMonthNumber(value: string): number | undefined {
  const month = Number(value);
  if (!Number.isInteger(month) || month < 1 || month > 12) return undefined;
  return month;
}

/**
 * Turns a match's raw captures into a calendar period, or undefined when the
 * month is impossible (out of range, or a month name that does not resolve).
 * Undefined here is deliberate, not an oversight: a file parsed into a period
 * nobody can own would be reported as an orphan against a slot that cannot
 * exist, which reads as a repository problem when it is actually the
 * filename, or a misconfigured recognizer, that is wrong. Returning undefined
 * lets the caller treat the whole match as a non-match instead.
 */
function resolveRawPeriod(groups: Captures): Period | undefined {
  if (groups.year === undefined) return undefined;
  const year = Number(groups.year);

  const month =
    groups.month !== undefined
      ? normalizeMonthNumber(groups.month)
      : groups.monthName !== undefined
        ? normalizeMonthName(groups.monthName)
        : undefined;
  if (month === undefined) return undefined;

  return { year, month };
}

function tokenToDeliverableId(profile: Profile, token: string): string | undefined {
  return profile.deliverables.find((deliverable) => deliverable.token === token)?.id;
}

/**
 * Assembles a raw match's client, deliverable id and period, shared by both
 * the canonical matcher and the recognizer matcher.
 *
 * This is the one place the id/token asymmetry is resolved. A match whose
 * pattern captured its own `{deliverable}` group holds a token, because that
 * is what appears in a filename, so it must be reverse-mapped to the
 * deliverable's id before a Slot can be built; the profile schema's token
 * uniqueness check is what makes that reverse lookup unambiguous. A
 * recognizer whose pattern captures no deliverable at all needs no lookup:
 * its own declared `deliverable` field is already an id, validated against
 * the profile's deliverables when the profile was loaded.
 *
 * The resolved period is anchored here, against the deliverable's own
 * cadence and periodAnchor, rather than left for the matching stage. A
 * quarterly deliverable reports under one month per quarter, and anchoring
 * now means the matching stage can compare two periods for plain equality
 * later instead of re-deriving the deliverable's cadence rules a second
 * time.
 */
function finishMatch(profile: Profile, groups: Captures, fallbackDeliverableId?: string): Resolved | undefined {
  const client = groups.client;
  if (client === undefined) return undefined;

  const deliverableId = groups.deliverable !== undefined ? tokenToDeliverableId(profile, groups.deliverable) : fallbackDeliverableId;
  if (deliverableId === undefined) return undefined;

  const deliverable = profile.deliverables.find((candidate) => candidate.id === deliverableId);
  if (!deliverable) return undefined;

  const rawPeriod = resolveRawPeriod(groups);
  if (!rawPeriod) return undefined;

  const period = anchorPeriod(rawPeriod, deliverable.cadence, deliverable.periodAnchor);
  return { match: { client, deliverable: deliverableId, period }, deliverable };
}

/**
 * A canonical match is not "the regex matched the shape"; it is "the regex
 * matched the shape, and rendering the values it captured reproduces this
 * exact filename." That second check is what makes the matcher's canonical
 * set exactly the renderer's output set, for every placeholder, rather than
 * a per-token argument about whether a given capture body happens to be
 * loose enough to admit something the renderer could never write. Tightening
 * each capture body (as `{month:02}` does, above) is still worth doing as a
 * fast, cheap rejection, but the round-trip is what actually guarantees the
 * property, including for any placeholder added later that nobody remembers
 * to tighten by hand: `MAY`, `may` and `Jan` all satisfy `[A-Za-z]+` for a
 * `{monthName}` capture, and `05` satisfies `\d{1,2}` for a plain `{month}`
 * capture, but `renderTemplate` can only ever produce `May` or `5` from
 * those same values, so none of the three round-trips.
 *
 * A shape match that fails to round-trip is not the same as no match at all:
 * it is a real client, deliverable and period, spelled in a way the profile
 * did not render. Returning undefined here lets `parseFile` fall through to
 * the recognizers, which is exactly the mechanism a profile has for saying
 * which near-misses it accepts (and under which verdict) versus which ones
 * it wants surfaced as unrecognized. Canonical matching should not silently
 * grant its own leniency that bypasses that declaration.
 */
function matchCanonical(profile: Profile, name: string): RawMatch | undefined {
  const pattern = buildCanonicalPattern(profile);
  const match = pattern.exec(name);
  if (!match?.groups) return undefined;

  const resolved = finishMatch(profile, match.groups);
  if (!resolved) return undefined;

  const context = { period: resolved.match.period, client: resolved.match.client, deliverable: resolved.deliverable.token };
  if (renderTemplate(profile.naming.template, context) !== name) return undefined;

  return resolved.match;
}

/**
 * Recognizers already carry regular expressions with named captures, applied
 * to the filename as authored in the profile: unlike the canonical matcher,
 * there is nothing to build here beyond compiling the pattern the profile
 * declared, and no round-trip to check. A recognizer's pattern is not
 * expected to equal anything `renderTemplate` would produce; it exists
 * precisely to accept a shape the renderer does not.
 */
function matchRecognizer(profile: Profile, recognizer: Recognizer, name: string): RawMatch | undefined {
  const pattern = new RegExp(recognizer.pattern);
  const match = pattern.exec(name);
  if (!match?.groups) return undefined;
  return finishMatch(profile, match.groups, recognizer.deliverable)?.match;
}

/**
 * Turns one repository file into a client, a period and a deliverable, or
 * marks it unparseable. The canonical template is tried first; only when it
 * does not match does each recognizer get a turn, in profile order, with the
 * first match winning. This mirrors exactly how `renderTemplate` produces a
 * canonical name and how a profile author orders recognizers deliberately
 * (a broad legacy pattern before a narrower one, for example), so declaring
 * order is meaningful rather than incidental.
 */
export function parseFile(profile: Profile, file: RepositoryFile): ParsedFile {
  const canonical = matchCanonical(profile, file.name);
  if (canonical) {
    return { recognized: true, file, ...canonical, nameVerdict: "canonical" };
  }

  for (const recognizer of profile.naming.recognizers) {
    const match = matchRecognizer(profile, recognizer, file.name);
    if (match) {
      return { recognized: true, file, ...match, nameVerdict: recognizer.verdict, recognizerId: recognizer.id };
    }
  }

  return { recognized: false, file };
}
