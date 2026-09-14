# Design: the workbook snapshot

Date: 2026-09-14
Status: Approved (design only)
Extends: `2026-09-11-repository-reconciliation-mcp-design.md`, which settles the profile schema, the
Excel decisions and the phase sequence. This addendum settles what phase 2b left open or got wrong:
how 2b is sliced, what an Excel session is allowed to do, how a hand-maintained workbook's bad rows
are handled, and where the rejections live.

Companion to `2026-09-13-graph-repository-snapshot-design.md`, which delivered the other half of the
reconciliation engine's input. That engine has been finished and waiting since phase 3. This is the
piece that lets it run.

## Scope: phase 2b-1

The parent spec's phase 2b is four units. They share no dependencies, and one of them has no caller.

**This slice delivers one thing: a `WorkbookSnapshot` read from a real Excel workbook**, so
`reconcile` has both its inputs and phase 4 can wire `reconcile_workbook_vs_repository`, which is
the centerpiece tool and the MVP checkpoint.

In scope: the Excel session manager, the mapped read, the conversion into `ClientRecord[]`, the
handling of rows that cannot be read, and the report shape change that carries them.

**Deferred to its own spec: the Microsoft Search cross-check.** It shares nothing with this work:
different API, different output, different field. It removes `searchCrossCheckIncluded: false` from
reports, which cannot exist until this slice ships, so it is strictly second in value as well as
independent in code.

**Moved to phase 6: the `$batch` builder.** It was deferred out of phase 2a because a delta-driven
inventory has no use for it, and nothing here needs it either: reading a table is one call and
reading a worksheet's used range is one call. Its real caller is the write tools, where renaming two
hundred files is two hundred requests and batching makes it ten. Building it now would pin its split
boundaries, its `dependsOn` support and its partial-failure semantics against guesses about a
consumer that does not exist, which is the same reasoning that deferred it the first time.

## Decision: a non-persistent session

The parent spec specifies `persistChanges: true`, and `CLAUDE.md`'s Decision Record locks
"persistent workbook sessions". This amends both to `persistChanges: false`.

`persistChanges: true` is what makes a session write-capable: edits made through it commit to the
file. This phase only reads, and what it reads is described in the parent spec as the customer's
live operational authority, the workbook they actually run on. A write-capable handle on that
document, held by a server whose stated posture is that nothing writes until read-only output is
validated, is the wrong default even if nothing intends to use it.

A non-persistent session gives the same speed and the same consistent view of the workbook across
calls. It cannot commit a change, which makes the read-only guarantee structural rather than a
matter of nobody calling the wrong method.

No tool in the ten-tool set writes to the workbook. If one is ever added, this decision is revisited
with that tool, which is the right moment to weigh it.

## Decision: the single-flight queue does not apply

The parent spec locks "a single-flight queue per workbook". That assumes a long-lived process
holding sessions across calls.

This server builds a fresh `McpServer` per request, statelessly, which is a locked decision for a
different reason: Copilot Studio requires it and it prevents cross-request state leakage. Two
concurrent requests therefore cannot share an Excel session at all. There is nothing to serialize
without a shared store, and within a single read there is nothing to serialize either.

The queue is deferred with that reason recorded. It is not a YAGNI deferral of something that would
work; it is the observation that the mechanism does not fit the architecture the project chose.

If a later phase introduces a shared session cache, the queue comes back with it, and that phase
owns the decision.

## Architecture

Three modules, following the shape phase 2a established. The domain layer must import none of them.

That is not yet true of the lint rule, and saying otherwise would repeat a defect this project already
caught once: phase 2a's spec claimed the existing purity rule covered its new modules when it did
not. The rule currently denies `**/server/**`, `**/mcp/**`, `**/tools/**`, `**/setup/**`,
`**/graph/**`, `**/store/**`, `**/scan/**` and `**/config.js` to the domain layer. `src/workbook/` is
new, so the rule is extended to cover it as part of this work, and a guardrail test asserts the
refusal the way the existing ones do.

**`src/graph/excel.ts`** carries no domain knowledge. Create a session against a workbook addressed
by path, read a table's range or a worksheet's used range, close the session. The session id travels
in the `workbook-session-id` header on every call, which is what makes the successive reads see one
consistent workbook state.

**`src/workbook/read.ts`** is the mapping layer and is pure. It takes a grid of cell values and a
profile's `workbookMapping`, and produces records and rejections. No I/O, so every mapping rule is
testable against fixtures with no Graph and no tenant, the same property that let the reconciliation
engine be built before any tenant existed.

**`src/scan/workbook.ts`** is the composition root for this read, beside the repository scan's.

## The read

Address the workbook by the profile's `identity.workbookPath` using the existing path helper, which
already encodes each segment correctly.

Create a session. Read according to the mapping's `source.kind`: a table reads its own range, a
worksheet reads its used range. Close the session.

A 404 on a call carrying a session id means the session expired. That is caught once, a fresh
session created, and the read retried. A second failure is a real failure and propagates.

## Turning a grid into records

The mapping names column headers and the row those headers sit on. Records are built by locating
that header row, mapping each named header to its column index, and reading every row below it.

**One line divides the two failure kinds, and it is the load-bearing rule of this layer.**

A header the mapping names and the sheet does not contain **fails the whole read**. Every row will be
wrong, and reporting fifty rejected rows would bury the actual cause, which is that the mapping is
stale against a renamed column. The failure names the header and the mapping.

A cell that cannot be read **rejects that row only**. One typo in fifty rows should not cost the
other forty-nine.

A blank client cell is **skipped silently**, not rejected. Trailing empty rows are normal in a
spreadsheet and are not errors.

**`effectiveFrom` needs real conversion.** Excel returns dates as serial numbers, so a date column
arrives as `45231` rather than an ISO string, and `ClientRecord.effectiveFrom` is an ISO date the
engine parses. The reader converts from the Excel epoch, accepts a value that is already an ISO
string, and rejects the row for anything else. This is the single most likely source of rejected
rows against a real workbook, which is why it is named here rather than left to the implementation.

## Where the rejections live

`WorkbookSnapshot` gains a field carrying the rejections: for each, the row it came from, the client
it named if that was readable, and why it was refused.

`ReconciliationReport` surfaces them. A client silently missing from a compliance report is the quiet
incompleteness the rest of this design refuses, and a rejection that reaches only a log is exactly
that. The operator has to see it where they read results.

Both are types the reconciliation engine froze in phase 3, so this changes the engine's report shape
and the golden fixture that pins it. That is deliberate work with its own review, not a side effect,
and it is cheaper now than after phase 4 wires consumers onto the current shape.

## Two refusals that will look inconsistent

A workbook naming one client on two rows still refuses the whole report. That is the engine's
existing input contract from phase 3, and its reasoning holds: which row's effective date and cadence
flags should win is genuinely ambiguous, and choosing one silently would be a guess. Before that
check existed, the second row doubled every finding and every count for that client, silently.

A malformed cell rejects one row and the report continues.

These differ because the situations differ. A duplicate is ambiguity between two readable rows. A
malformed cell is one row that cannot be read at all. Someone will eventually notice the asymmetry
and try to harmonise it; this section exists so that lands as a deliberate decision rather than a
tidy-up.

## What this deliberately does not do

No writes to the workbook, which the session mode now makes structural rather than conventional.

No `$batch` and no Search cross-check, for the reasons in Scope.

No state store. Unlike the repository, the workbook is read fresh on every run: delta does not apply
to Excel, a tracking workbook is small, and a cached workbook would be the one input most likely to
be stale at the moment a compliance question is asked.

No paging of a worksheet's used range. A tracking workbook that exceeds one response is a signal the
mapping is pointed at the wrong sheet, and guessing at pagination for a shape nobody has seen would
be inventing a requirement.

## Testing

The mapping layer is pure, so its rules are tested against fixture grids with no Graph and no
tenant. The session layer gets a fake transport.

Error paths are CI gates in the `.errors.test.ts` files the suite already isolates:

- An expired session, asserting a fresh one was created and the read retried, and that a second
  failure propagates.
- A mapped header absent from the sheet, asserting the whole read fails and the message names the
  header and the mapping.
- A malformed `effectiveFrom`, asserting one row is rejected, the rest survive, and the rejection
  names the client and quotes the value.
- A serial-number date converted correctly, including across the Excel epoch's 1900 leap-year quirk.
- A sheet with trailing blank rows, asserting no rejections.
- A duplicate client, asserting the engine still refuses the whole report.

## Live verification

The tenant sitting that phase 2a is waiting on now needs one more fixture: a synthetic tracking
workbook in the site, with a table matching the example profile's mapping. The seeder builds folders
and files; the workbook is placed by hand.

Until that happens, this slice is in the same position as phase 2a: verified against fakes, and
unproven against a tenant. That must be recorded in `docs/OPEN-ITEMS.md` when it ships, in the same
terms.

## Amendments this requires

- `CLAUDE.md` and the parent spec: Excel sessions are non-persistent, with the reason.
- The parent spec: the single-flight queue is deferred, with the reason.
- The parent spec's phase list: 2b splits into the workbook snapshot and the Search cross-check, and
  `$batch` moves to phase 6.
- `docs/OPEN-ITEMS.md`: the question of whether one bad workbook row should abort the whole
  reconciliation is answered. It does not; the row is rejected and the rejection travels to the
  report.
- `eslint.config.js`: the domain purity rule is extended to deny `**/workbook/**`, with a guardrail
  test, since `src/workbook/` is a new impure layer and nothing currently stops the domain importing
  it.
