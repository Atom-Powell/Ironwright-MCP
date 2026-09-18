# Phase 4c: describe_workbook

Design spec. Written 2026-09-18, after phase 4b was verified live and opened as PR #14.

## What this phase delivers

One tool, `describe_workbook`, and the server configuration change it needs.

It reads a tracking workbook's structure and reports it, so a human can write a `workbookMapping`
with evidence rather than by opening the file and counting columns. It proposes nothing it cannot
observe, it changes nothing, and it is the only read tool that runs before a profile exists.

This is the last of the five read tools. `inventory_tree`, `query_repository`, `validate_structure`
and `reconcile_workbook_vs_repository` are wired; this one completes phase 4.

## Why it was deferred out of 4b

The other three tools are compositions over layers that already existed. This one is new logic:
worksheet and table enumeration, header row detection, and column type inference, none of which
exists anywhere in the codebase. It also had a defect in its phase 1 stub that 4b recorded rather
than fixed, described next.

## The addressing defect, and the config change that closes it

The stub's input schema takes a `siteUrl`. This server holds `Sites.Selected` on one named site and
cannot read any other, so that input promises reach the permission model forbids. Worse, nothing in
the server can tell a caller which site is reachable: `IW_SITE_URL` is read only by the setup
command, and at runtime the only place a site URL exists is inside a profile's `identity`. A tool
that runs before a profile exists therefore has no way to know its own site.

**`IW_SITE_URL` becomes required server configuration**, the same value `npm run setup` already
grants. `describe_workbook` then takes `library` and `workbookPath` and no site at all. It is
structurally incapable of being pointed at a site the grant forbids, and its description can name the
one reachable site rather than leaving a model to guess and read a 403 as the answer.

**Two consequences ride with that, and both are wanted.**

The profile registry gains a startup check: a profile whose `identity.siteUrl` disagrees with the
configured site is refused by name at startup. Today that mismatch surfaces as a 403 on the first
Graph call, which is the same misleading failure the setup command was corrected for, and it is the
kind of failure `docs/OPEN-ITEMS.md` already records the cost of.

Phase 5 must set the variable when it stands up hosting. That is a one line addition to a deployment
this phase does not own, and it is recorded here so that phase does not discover it.

The alternative considered and rejected was to make the value optional and gate the tool on its
presence, the way write tools are gated. That keeps existing deployments working unchanged, but it
leaves the server unable to validate profiles, and a server that does not know its own site cannot
honestly answer the question this tool exists to answer.

## Two modes on one tool

**Inventory mode, no `source` argument.** Every worksheet with its used range, row count and column
count, and every table with its sheet, bounds, row count, and whether it declares a header row. This
reads `xl/workbook.xml`, the workbook relationships, each table part and each sheet's `<dimension>`
element. It does not build a grid for any sheet, so it stays cheap on a workbook with many large
sheets.

**Deep mode, with a `source`.** The full description of that one range.

The `source` argument's shape is deliberately `{ kind: "table" | "worksheet", name: string }`,
identical to `workbookMapping.source`. What a caller passes to this tool is literally what they paste
into the profile, so there is no translation step in which a name can be transcribed wrong.

## What deep mode returns

Per column, within the resolved range:

- its one-based position within the range
- its sheet-absolute column label, so an operator looking at the file in Excel can find it
- the header text, verbatim
- an inferred type: `string`, `number`, `boolean`, `mixed`, or `empty`
- counts of non-empty cells and of unevaluable cells
- a distinct value count
- up to `MAX_COLUMN_SAMPLES` sample values

Headers come back in full, because a mapping is written against them. Values come back bounded, and
the response states the cap it applied. This is the first tool in the server that puts customer
spreadsheet contents into a model's context, and Copilot Studio's data loss prevention applies per
server rather than per tool, so this tool's exposure is the whole server's exposure. Bounded samples
are enough to recognize a client column at a glance and are not a data export of the customer's
operational record.

## Header row detection

**For a table it is determinate.** The table part declares its header row count. If it declares one,
the header row is the table's first row and the profile's `headerRow` is 1. If it declares none, the
tool says so plainly and reports no header text, rather than treating the first data row as headers.

**For a worksheet it is a heuristic, and it is allowed to decline.** The tool scans the first
`HEADER_SCAN_ROWS` rows of the used range and scores each as a header candidate on two observable
properties: how many of its cells are non-empty distinct strings, and whether the row beneath it
differs in type from it.

It proposes a row only when one candidate is unambiguously better than the rest. When two are
equally plausible it proposes none, lists the candidates, and states what made each one a candidate.
A confidently wrong header row shifts every column by one and produces a mapping that validates and
reads garbage, which is exactly the class of failure this project treats as its most expensive.

## What the tool refuses to infer, and says so

It does not guess the `columns` map, and its own output states that it did not. Those keys are the
profile author's vocabulary, referenced by `deliverables[].appliesTo.workbookField` and by the
effective-date column, and this tool has not seen the deliverables. A mapping it invented would be a
plausible artifact that is harder to audit than no artifact.

What it does instead is make the answer obvious in one read: header text, type, distinct count and
samples per column are exactly the evidence a human needs to identify the client column and the
fields beside it.

## Two rules inherited from the workbook bytes reader

**An unevaluable cell is reported as unevaluable, never as blank.** In a header or in a sample. The
bytes reader established that a cell whose value cannot be read confidently surfaces as a rejection
rather than a substituted value, and a tool whose entire purpose is to be trusted about a file's
contents cannot be the place that rule is relaxed.

**When the workbook carries `fullCalcOnLoad` and the range holds a formula, every sample for that
source is withheld.** That flag is the file stating its own cached results are stale. Structure is
still described, because structure is not stale, but a sampled value read from a stale cached result
would be shown as though it were current. The response says samples were withheld and why.

**Amended 2026-09-18, while the plan was being written.** This originally said samples from formula
cells are withheld, per cell. `sheetToGrid` reports whether a range contained a formula, not which
cells did, so per-cell withholding would require teaching the grid reader to track formula cells. That
module is on the compliance path and is the one phase 2b-2 was built to make trustworthy; destabilizing
it to improve a sample display is the wrong trade. Withholding every sample for the source is the
conservative direction and needs nothing new from the reader.

**Also amended 2026-09-18: there is no `date` inferred type.** A date in xlsx is a number carrying a
number format, and the cell decoder deliberately does not read styles, so a date serial and an
ordinary number are indistinguishable at this layer. Claiming to infer `date` would assert something
this code cannot observe. A column of date serials reports as `number`, and its samples show the
serials, which is what the file actually holds.

## Caps

Named constants, exported from the module that applies each, with the response stating the cap and
the omitted count wherever one applies:

- `MAX_SHEETS_LISTED` and `MAX_TABLES_LISTED` in inventory mode
- `MAX_COLUMNS_DESCRIBED` in deep mode
- `MAX_COLUMN_SAMPLES` per column
- `HEADER_SCAN_ROWS` for worksheet header detection

Totals are computed over the complete set before truncation and reported exactly, as everywhere else
in this server.

## Failures

A `source` naming a table or worksheet the workbook does not contain fails by listing what the
workbook actually does contain, the way `LibraryNotFoundError` already names the libraries it found.
That turns the most common operator error into a self-correcting one.

Everything else maps through `describeToolFailure` with `tool: "describe_workbook"`. A workbook that
is not an xlsx, or an archive that is damaged, already has distinguishable error kinds from the bytes
reader and they are reused rather than reclassified here.

## Not in scope

Named ranges. The phase 1 stub's description promises to report them, and that claim is removed in
this phase: a profile's `WorkbookSource` is a table or a worksheet, so describing a named range would
advertise a source no mapping can consume.

Writing or amending a profile. Reading more than one workbook. Any mutation of anything.

## Testing

Fakes and hand-built xlsx fixtures, as phase 2b-2 established. Fixtures must cover at minimum: a
table with a declared header row; a table declaring none; a worksheet with one unambiguous header
row; a worksheet with two equally plausible candidates, where the tool must decline; a column of
mixed types; a column that is entirely empty; an unevaluable header cell; an unevaluable sample; and
a workbook carrying `fullCalcOnLoad` over a range containing a formula.

A wire test drives the tool through a real MCP client over an in-memory transport and asserts the
SDK's own output validation passes against a populated `structuredContent`, including at least one
described column, because the output type is hand declared and nothing else guards it against drift
from its schema.

## Verification before merge

The usual rule applies: covered by fakes until it has run against a tenant, and the branch does not
merge until it has.

The live check available here is better than anything a fixture can offer. Run both modes against the
real tracking workbook and confirm that the source and header row the deep mode proposes are the ones
`profiles/synthetic.json` already uses, and that the columns it describes include the header texts
that profile's mapping names. The tool should rediscover a mapping this repository independently
knows is correct.

If it proposes something different, either the tool is wrong or the profile is. Both are worth
knowing before merge, and neither is discoverable from a fixture the tool's own author wrote.

## Sequencing

This phase's implementation depends on phase 4b: the widened tool contract, the `tool` field on
`FailureSubject`, and the shaping and prose conventions the three wired tools established. PR #14
must merge before implementation begins, or the branch must be cut from it.
