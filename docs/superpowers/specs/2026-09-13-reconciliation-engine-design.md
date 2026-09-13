# Design: the reconciliation engine

Date: 2026-09-13
Status: Approved (design only)
Extends: `2026-09-11-repository-reconciliation-mcp-design.md`, which settles the domain model,
the profile schema, and the five artifact states. This addendum settles what that spec left
open: the boundary between the engine and the Graph layer, the engine's public surface, the
report shape, and the matching rules.

## Why this is worth building before phase 2

The engine is pure. No I/O, no Graph, no tenant, no credentials. It is the reason the parent
spec insists on a pure domain layer, and it means the highest-value logic in the project can be
finished and trusted before anything can reach a customer's files. It is also what the
evaluation questions in `docs/EVALUATION-QUESTIONS.md` were written to test, so those questions
are the acceptance criteria rather than an afterthought.

## What the engine receives

Two snapshots of plain data, handed over by phase 2.

**The workbook** arrives as rows. Each carries the client name, the other mapped columns keyed
by their profile field names rather than their spreadsheet headers, and an effective date when
one is mapped. Keying by field name rather than header is what stops a renamed spreadsheet
column from reaching the engine at all; it fails in the mapping, which is where it can be
explained.

**The repository** arrives as a list of files, each with path, name, size, modified date and
ETag, plus a flat list of folder paths. The ETag travels with the file because a later rename or
move plan needs it as an `If-Match` precondition, and the moment the engine saw the file is the
honest moment to capture it.

Empty folders are computed, not supplied. A folder is empty exactly when no file and no deeper
folder sits beneath it, and deriving that from the two lists means the Graph layer cannot report
it wrongly.

The repository snapshot also describes itself: when it was scanned, and whether the Microsoft
Search cross-check was included.

That second flag is load-bearing. Without Search, a correctly named file sitting outside the
expected taxonomy is invisible, so every `misplaced` finding is unreliable and every `missing`
finding is suspect. When it is false the report says so, and the tools presenting the report
must not describe it as complete. This is the parent spec's rule applied to data rather than
messages: do not assert what has not been observed.

## Public surface

One function.

```
reconcile(profile, workbook, repository) -> ReconciliationReport
```

`query_repository` filters the report and `validate_structure` groups it by client. Neither
recomputes anything. Two tools then cannot contradict each other about whether a client is
compliant, which matters because being the authoritative answer is the product.

Internally there are four stages, each pure and separately testable: derive the expected
artifacts, parse the actual files, match the two sets, and compute empty folders. They stay
internal. Exporting them would create exactly the drift the single-entry decision exists to
prevent, and the escape hatch is how that drift arrives.

## The report

One finding per expected artifact, carrying client, deliverable, period, expected path, expected
name, resolved state, and the file that satisfied it when one did, including its ETag.

Alongside those: duplicates, each naming the slot it collides with; orphans; empty folders; and
a per-client rollup derived from the artifact findings rather than computed separately, so it
cannot disagree with them.

Plus provenance: when the repository was scanned, whether Search was included, and which
workbook source the rows came from. A compliance report that cannot say what it was computed
from is not evidence of anything.

Orphans split in two, and the distinction earns its place. A file whose name will not parse is
**unrecognized**. A file that parses cleanly but names a client, period or deliverable nobody
owes is **unexpected**, and that usually means the workbook is stale rather than the repository
being wrong. The evaluation questions note that the workbook's own freshness is the system's
blind spot; unexpected orphans are the closest the engine can honestly get to pointing at it,
and they should not be presented as more than a hint.

## Matching

**Parsing.** For each file, try the canonical filename template first, then each recognizer in
profile order, first match wins. A recognizer carries a verdict, so an accepted alias parses as
correctly named and a legacy pattern parses as misnamed. Anything else is unparsed. Recognizers
capturing a month name rather than a number are normalized during parsing, not later.

**Location** is a separate axis. Render the expected path for whatever the file parsed to, and
compare it against where the file actually sits. The two axes give the five states: correct name
and correct folder is compliant, correct name and wrong folder is misplaced, wrong name and
correct folder is misnamed, both wrong is misnamed and misplaced, and a slot with no candidate
is missing.

**Non-monthly cadences.** A quarter resolves to one month through `periodAnchor`, so with the
default anchor of `last` the second quarter is owed under month six. Both sides of the
comparison are anchored: the expected period when it is derived, and a file's parsed period at
the moment it is parsed. Every month of a quarter therefore resolves to that quarter's anchor,
and a quarterly audit naming April, May or June all satisfy the same Q2 slot.

That is deliberate. The alternative, comparing a file's raw parsed month against the anchored
month, would turn a Q2 audit named for April into a missing slot plus an unexpected orphan: it
would report a report that exists as one that does not, and send someone to produce it again.
That is the failure the fourth evaluation question exists to catch. Whether such a filename is
acceptable at all is a recognizer verdict, which is where a naming judgment belongs, and the
`misnamed` state is how the file still gets reported for renaming.

**Duplicates.** Candidates rank by state in the order above, best wins the slot, and every other
candidate becomes a duplicate finding naming that slot. Ties break by most recently modified,
then by path alphabetically.

**Determinism.** Everything in the report is sorted: artifacts by client, then deliverable, then
period; orphans, duplicates and empty folders by path. Golden-file tests depend on it, and a
compliance report whose row order shifts between runs is hard to diff by hand, which people will
do.

## Testing

One synthetic workbook and one synthetic repository as JSON fixtures, with a golden report.
Between them they must cover every state and every rule that could silently invert: a compliant
file, one compliant only through an alias recognizer, a misnamed one, a misplaced one, one that
is both, a slot with nothing anywhere, a duplicate pair, an unrecognized orphan, an unexpected
orphan, an empty folder, a quarterly deliverable exercising the anchor, a client whose effective
date excludes earlier periods, and a client who owes nothing at all.

One further fixture matters as much: a snapshot with the Search cross-check absent, asserting
the report degrades honestly instead of presenting misplaced and missing findings it has no
basis for.

Every one of these runs with no Graph, no tenant and no network.

## What this deliberately does not do

No Graph calls, no state store, no caching, and no tool wiring. Phase 2 supplies the snapshots
and phase 4 wires the tools. The engine does not know where its inputs came from, which is what
makes it testable and what keeps the thin-wrapper shape out of the product.

It also makes no judgment the profile can make instead. Whether a near-miss filename counts is a
recognizer verdict, not engine logic. If a rule starts to feel like it belongs in code, that is
a signal it belongs in the profile schema.
