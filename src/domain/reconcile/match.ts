import type { Profile } from "../profile/schema.js";
import { renderPath } from "./render.js";
import type {
  ArtifactFinding,
  ArtifactState,
  DuplicateFinding,
  MatchedFile,
  OrphanFinding,
  ParsedFile,
  ParsedFileRecognized,
  Slot,
} from "./types.js";

export interface MatchResult {
  artifacts: ArtifactFinding[];
  duplicates: DuplicateFinding[];
  orphans: OrphanFinding[];
}

/**
 * A candidate's state, which is always one of the four outcomes a matched
 * file can land in. "missing" is not a candidate state at all: it is what an
 * `ArtifactFinding` starts as before any candidate exists, so it is excluded
 * here at the type level rather than merely by convention.
 */
type CandidateState = Exclude<ArtifactState, "missing">;

/**
 * Best first. A slot's winning candidate, and the order every other
 * candidate for that slot is ranked against, comes from this list rather
 * than from the string ordering of the `ArtifactState` names -- alphabetical
 * order would put "compliant" first by luck, but "misnamed" before
 * "misnamed_and_misplaced" before "misplaced" by nothing but spelling, which
 * is not the ranking the spec describes.
 */
const STATE_RANK: readonly CandidateState[] = ["compliant", "misplaced", "misnamed", "misnamed_and_misplaced"];

function rankOf(state: CandidateState): number {
  const index = STATE_RANK.indexOf(state);
  if (index === -1) {
    // Unreachable given the CandidateState type: STATE_RANK lists all four
    // of its members. Kept as a thrown error rather than a silent fallback
    // so that if a fifth candidate state is ever added to the type without
    // also adding it here, the mistake surfaces immediately instead of
    // sorting that new state as if it ranked before everything else.
    throw new Error(`state "${state}" has no candidate ranking`);
  }
  return index;
}

/**
 * A stable key for grouping expected findings and candidates by the slot they
 * occupy. The separator is U+0000, written as an escape rather than as a raw
 * byte: a client name or deliverable id can contain any printable character a
 * workbook author chose, so a printable separator could be forged into a
 * collision, but a literal NUL in the source makes the whole file binary to
 * git and grep, which silently empties diffs and code review of it.
 */
function slotKey(slot: Slot): string {
  return `${slot.client}\u0000${slot.deliverable}\u0000${slot.period.year}\u0000${slot.period.month}`;
}

function deliverableToken(profile: Profile, deliverableId: string): string {
  const deliverable = profile.deliverables.find((candidate) => candidate.id === deliverableId);
  if (!deliverable) {
    // parseFile only ever produces a deliverable id drawn from this same
    // profile's own deliverables (see finishMatch in parse.ts), so reaching
    // here means the parsed files and the profile handed to matchArtifacts
    // came from different profiles -- a caller bug, not a repository problem
    // to report.
    throw new Error(`no deliverable is declared with id "${deliverableId}"`);
  }
  return deliverable.token;
}

/** The folder a library-relative path sits in, with no trailing separator. Empty when the path has no folder. */
function folderOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/**
 * Computes a matched file's state from two independent axes: naming (already
 * collapsed into `nameVerdict` by parsing) and location. Location compares
 * the folder the file actually sits in against the folder rendered for what
 * the file parsed to -- not against the slot's own expected path. Those two
 * paths coincide for a correctly filed match and diverge for a misplaced
 * one; comparing against the slot's expected path instead would make every
 * misplaced file look compliant, since the slot's expected path is by
 * definition where a compliant file for that slot would sit.
 *
 * A file carrying `parsed.file.library` came from the Microsoft Search
 * cross-check, not the profile's own library, and is in the wrong location
 * by definition, whatever its rendered folder looks like: a library-relative
 * path cannot express which library it is relative to, so an identical path
 * in another library is not the same location as that path in the profile's
 * own library. The folder comparison is skipped for it rather than trusted
 * to happen to disagree.
 */
function computeState(profile: Profile, parsed: ParsedFileRecognized): CandidateState {
  const nameCorrect = parsed.nameVerdict === "canonical" || parsed.nameVerdict === "compliant";

  const token = deliverableToken(profile, parsed.deliverable);
  const context = { period: parsed.period, client: parsed.client, deliverable: token };
  const parsedFolder = renderPath(profile.taxonomy.segments, context);
  const actualFolder = folderOf(parsed.file.path);
  const locationCorrect = parsed.file.library === undefined && actualFolder === parsedFolder;

  if (nameCorrect && locationCorrect) return "compliant";
  if (nameCorrect) return "misplaced";
  if (locationCorrect) return "misnamed";
  return "misnamed_and_misplaced";
}

interface Candidate {
  parsed: ParsedFileRecognized;
  state: CandidateState;
}

/**
 * Best first. Rank is the primary key; a tie there is broken by most
 * recently modified, then by path, alphabetically ascending. Both tiebreaks
 * exist for determinism: a golden-file test compares the whole report, and a
 * person diffs two reports by hand, so which of two otherwise-identical
 * candidates wins must not depend on input order or object identity.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  const rankDiff = rankOf(a.state) - rankOf(b.state);
  if (rankDiff !== 0) return rankDiff;

  // Repository timestamps are ISO 8601 strings in a single, consistent
  // format, so comparing them as plain strings orders them correctly without
  // parsing a Date -- which would also mean reading the clock's own notion of
  // "now" for no reason, in a module that must never touch it.
  if (a.parsed.file.modified !== b.parsed.file.modified) {
    return a.parsed.file.modified > b.parsed.file.modified ? -1 : 1;
  }

  return a.parsed.file.path < b.parsed.file.path ? -1 : a.parsed.file.path > b.parsed.file.path ? 1 : 0;
}

function toMatchedFile(candidate: ParsedFileRecognized): MatchedFile {
  const matched: MatchedFile = { path: candidate.file.path, name: candidate.file.name, etag: candidate.file.etag };
  if (candidate.recognizerId !== undefined) {
    matched.recognizerId = candidate.recognizerId;
  }
  return matched;
}

/**
 * Matches parsed repository files against the expected artifacts derived
 * from the workbook, resolving one winner per slot and reporting every other
 * candidate as a duplicate that names the slot it collided with. A parsed
 * file matching no slot is an orphan: `unexpected` when it parsed cleanly
 * but nobody owes what it names, `unrecognized` when it did not parse at
 * all.
 *
 * `expected` findings that receive no candidate are returned unchanged
 * (state stays "missing"), since deriveExpected already produced them in
 * that state and nothing here has grounds to promote them.
 */
export function matchArtifacts(profile: Profile, expected: ArtifactFinding[], parsed: ParsedFile[]): MatchResult {
  const findingBySlot = new Map<string, ArtifactFinding>();
  for (const finding of expected) {
    findingBySlot.set(slotKey(finding), finding);
  }

  const candidatesBySlot = new Map<string, Candidate[]>();
  const orphans: OrphanFinding[] = [];

  for (const file of parsed) {
    if (!file.recognized) {
      // A file qualified with a library came from the Microsoft Search
      // cross-check, not the profile's own library, and is never reported as
      // an orphan: it participates only as a candidate for an expected slot
      // it might match, and is discarded, not reported, when it matches
      // none. Without this exclusion, every unrelated file in every other
      // library of the site -- HR documents, meeting notes, scanned invoices
      // -- would arrive in a compliance report as an orphan, making the tool
      // unusable at exactly the customers who have more than one library,
      // which is most of them.
      if (file.file.library === undefined) {
        orphans.push({ path: file.file.path, name: file.file.name, kind: "unrecognized" });
      }
      continue;
    }

    const slot: Slot = { client: file.client, deliverable: file.deliverable, period: file.period };
    const key = slotKey(slot);

    if (!findingBySlot.has(key)) {
      // Parses cleanly, but the client, deliverable and period it names have
      // no slot. An artifact nobody owes and an artifact owed for a period
      // outside the window are the same absent key here, so the finding says
      // what was seen and not why; see the OrphanKind note in types.ts.
      //
      // Same library exclusion as above, and just as load bearing here: a
      // file from another library that happens to parse cleanly (its name
      // coincidentally matches the naming template) but names a slot nobody
      // owes is still not this repository's business to report.
      if (file.file.library === undefined) {
        orphans.push({ path: file.file.path, name: file.file.name, kind: "unexpected", parsed: slot });
      }
      continue;
    }

    const candidates = candidatesBySlot.get(key) ?? [];
    candidates.push({ parsed: file, state: computeState(profile, file) });
    candidatesBySlot.set(key, candidates);
  }

  const duplicates: DuplicateFinding[] = [];

  const artifacts = expected.map((expectedFinding) => {
    const key = slotKey(expectedFinding);
    const candidates = candidatesBySlot.get(key);
    if (candidates === undefined || candidates.length === 0) {
      return expectedFinding;
    }

    const ranked = [...candidates].sort(compareCandidates);
    const [winner, ...losers] = ranked;
    if (winner === undefined) {
      // Unreachable: candidates.length > 0 above guarantees a first element.
      return expectedFinding;
    }

    const slot: Slot = { client: expectedFinding.client, deliverable: expectedFinding.deliverable, period: expectedFinding.period };
    for (const loser of losers) {
      duplicates.push({ path: loser.parsed.file.path, name: loser.parsed.file.name, slot, state: loser.state });
    }

    return { ...expectedFinding, state: winner.state, matched: toMatchedFile(winner.parsed) };
  });

  return { artifacts, duplicates, orphans };
}
