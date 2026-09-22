# Design: reading the workbook from its bytes

Date: 2026-09-16
Status: Implemented. Verified live on 2026-09-17, which supplied the engine its second input and
reached the MVP checkpoint. (Corrected 2026-09-22; this line read "Approved (design only)" until
then.)
Replaces: the Graph half of `2026-09-14-workbook-snapshot-design.md`, which is superseded and
carries a banner saying so. That document still governs everything downstream of the grid.
Extends: `2026-09-11-repository-reconciliation-mcp-design.md`, whose Excel paragraph is amended.

## Why this exists

The Graph Excel API cannot be reached by this server. A live tenant run on 2026-09-16 refused
every `/workbook/` call with 403 `AccessDenied`, "Could not obtain a WAC access token", for an
app-only token carrying each of `Sites.FullControl.All`, `Sites.Selected`, `Files.Read.All` and
`Files.ReadWrite.All`, while those same tokens read the driveItem and downloaded its content.
WAC issues its token for a user; a client-credentials token has no user, and no application
permission repairs that. The evidence, and each cause ruled out, is in `docs/OPEN-ITEMS.md`.

Phase 2b-1 was built, reviewed across six tasks and merged without one call ever reaching that
endpoint, because every fake in the suite answered as though the call had been accepted. This
phase replaces the unreachable half and leaves the rest alone.

## Scope

One thing: obtain the grid. `readWorkbookGrid(grid, profile)` in `src/workbook/read.ts` keeps its
behavior, and the `WorkbookSnapshot` it feeds keeps its shape. Everything in this document sits
upstream of that call, with one exception recorded below, the row offset.

Out of scope: the reconciliation engine, the profile schema, the tool layer, and the Microsoft
Search cross-check, which remains phase 2c and unstarted. (Phase 2c shipped on 2026-09-17 and was
verified live; noted 2026-09-22.)

## Architecture

```
src/scan/workbook.ts   resolveDrive -> downloadDriveItem -> parseWorkbookGrid -> readWorkbookGrid
                                            |                     |
src/graph/content.ts (impure) --------------+                     |
src/workbook/xlsx.ts (pure) --------------------------------------+
```

**`src/graph/content.ts`** exposes `downloadDriveItem(client, { driveId, path }): Promise<Uint8Array>`.

**`src/workbook/xlsx.ts`** exposes `parseWorkbookGrid(bytes, source): unknown[][]`, pure, no I/O.
The lint purity fence already covers `src/workbook/`, so it inherits that guarantee rather than
needing a new rule.

**`src/graph/excel.ts` is deleted**, with its tests. The session manager, `createSession`,
`closeSession` and the expiry retry all address an endpoint this server cannot reach. Left in
place they would read as a working capability, which is the kind of claim this project's
message-audit practice exists to prevent, one layer up.

### The client gains a binary verb

`GraphClient` exposes `get` and `post`, both JSON. `downloadDriveItem` needs bytes, and it goes
through the client rather than around it with a bare `fetch`, because the client owns the
`Retry-After` backoff and the request counter. A download that bypassed both would make the
scan's own reported Graph request count wrong, and that count is the number phase 2a exists to
produce.

`GET /drives/{driveId}/root:/{path}:/content` answers 302 to a pre-authenticated storage URL.
`getBytes` follows it with `redirect: "manual"` and re-issues the second request with no
`Authorization` header. Node's fetch strips that header on a cross-origin redirect on its own,
and relying on it silently is the inherited-default behavior the Decision Record rejected the
Graph SDK over. Here the consequence of being wrong is a bearer token delivered to a storage
host, so the stripping is performed deliberately and commented with that reason.

### What the parser reads

Four parts, and no more:

- `xl/workbook.xml` and `xl/_rels/workbook.xml.rels`, to resolve a worksheet name to its part.
- `xl/sharedStrings.xml`, for `t="s"` cells.
- the worksheet part itself.
- `xl/tables/*.xml` plus the worksheet rels, when `source.kind` is `table`, to resolve a named
  table to its range.

`styles.xml` is deliberately not read. Dates are decided by column role rather than by cell
format: `readWorkbookGrid` applies `excelSerialToIsoDate` to whatever sits in the `effectiveFrom`
column, and that function already handles the 1900 leap-year ambiguity and the expanded-year
bound. A number-format table would add a part, a lookup, and a class of disagreement with the
existing reader, and buy nothing.

The grid produced is what the Graph API's `values` returned: strings, numbers, booleans. Cell
shapes Graph used to resolve and the parser now must handle itself are shared-string indices
(`t="s"`), inline strings (`t="inlineStr"`), and booleans (`t="b"`, stored as 0 and 1). Shared
formulas need no special handling, because the rules below test only whether `<f>` and `<v>` are
present, never what a formula says.

## The rejection rule

This is the condition attached to the decision rather than an implementation detail. A mapped
cell whose value cannot be read confidently surfaces as a rejection and never as a substituted
value. A parser that returns an empty string or a zero for an unevaluable cell produces a wrong
compliance finding with nothing raised anywhere, which this project holds to be its most
expensive failure.

Three signals, all local to the bytes.

**A formula cell with no cached value is rejected.** `<c><f>...</f></c>` carrying no `<v>` means
Excel never wrote a result, so there is nothing to read.

**An error cell is rejected.** `t="e"` carries a cached value that is not a value: `#REF!`,
`#N/A`, `#VALUE!`. This is the signal that matters most in practice. An `#N/A` in a lookup column
is ordinary in a real spreadsheet, and substituting an empty string there would silently report a
client as owing nothing, which reads as compliance.

**A formula cell with a cached value, in a workbook that does not set `fullCalcOnLoad`, is
trusted.** Excel writes cached results on every save, so this is the normal case, and rejecting
it would reject nearly every formula-bearing workbook.

### `fullCalcOnLoad` fails the read rather than rejecting rows

`xl/workbook.xml` may carry `<calcPr fullCalcOnLoad="1"/>`, which instructs Excel to recompute
everything when the file opens. That is the producer stating that the cached values are not
authoritative, and it is the closest thing to a stale-cache signal the format offers. Non-Excel
writers set it when they cannot compute.

When it is set **and** at least one mapped cell in the range is a formula, the read fails with a
`WorkbookMappingError` naming the cause. It does not reject every formula-derived row.

The reasoning is already written in `src/workbook/read.ts`: a header the mapping names and the
sheet lacks "makes every row wrong, so reporting fifty rejected rows would bury the real cause."
`fullCalcOnLoad` has that same shape. It is a workbook-wide condition rather than a per-row
defect, and a report that silently lost every client would be far harder to diagnose than one
loud message.

When it is set and no mapped cell is a formula, the flag is irrelevant and is ignored. A workbook
can carry the attribute for reasons that have nothing to do with the mapped range.

## Rejected rows get absolute sheet row numbers

`src/workbook/read.ts` numbers a rejected row within the range that was read, so a table starting
at sheet row 12 reports its first data row as row 2. That was recorded as an open question
because Graph did not return the range's own offset. Parsing locally, the table's absolute
position is known for free.

`readWorkbookGrid` gains a row-offset argument so a rejection can name the row an operator will
find when they open the workbook. The offset is the only change to that function; its existing
behavior is otherwise untouched.

## Limits

Three constants, each commented with its reasoning, none of them profile configuration. There is
no real customer workbook to tune against, so a knob would be a guess at a shape nobody has seen.

- A download cap of 50 MB, checked against `Content-Length` before the body is read and again
  against the bytes actually received, because a missing or untruthful header must not be the
  only thing standing between a hostile response and memory.
- An inflated-size cap of 200 MB. `fflate` exposes uncompressed sizes from the zip central
  directory before inflating anything, so an oversized or maliciously compressed archive is
  refused by inspection rather than discovered by exhausting memory.
- A grid cap of 1,048,576 rows by 16,384 columns, which is Excel's own sheet maximum. A worksheet
  may declare any `<dimension>` it likes, and one larger than Excel can itself produce is
  malformed rather than large. Materializing the grid is driven by the cells the part actually
  contains rather than by the declared dimension, so the cap is a refusal rather than a budget.

### The one new dependency

`fflate`, for the zip. It is MIT, has no dependencies of its own, and is the only third-party
code this phase adds. The alternative considered and rejected was a general xlsx library
(`exceljs`, SheetJS): those are built to return a value for every cell, which is exactly what the
rejection rule forbids, so getting one to refuse instead means fighting its design and depending
on internals it does not promise. That is the same reasoning the Decision Record already used to
reject the Graph JS SDK. SheetJS additionally distributes current versions off the npm registry
and its registry package carries a history of prototype-pollution and ReDoS advisories, which is
a poor supply chain for a server holding SharePoint credentials.

XML is read without a parser dependency. The four parts are read for a small, fixed set of
elements and attributes, and no part of this design needs general XML. Entity expansion is
refused rather than resolved, so a document declaring entities is rejected as malformed.

## Testing

The parser is pure, so it tests from fixture bytes with no network and no tenant.

**Fixtures are hand-written XML in the test files, not generated by `scripts/seed/blank-workbook.ts`.**
That writer produces xlsx from scratch, and using it here would let our writer and our reader
confirm each other's assumptions about what Excel emits, with neither being evidence about Excel.
That is the same agree-by-construction failure the seeder's own predicted report had, and it is
worth refusing twice.

**One real workbook is checked in as a binary fixture**, produced by Excel and carrying a table, a
formula, an `#N/A` and a date. It is the only artifact in the suite that can catch a wrong
assumption about Excel's actual output, which is the failure this whole phase exists because of.

Cases: shared string, inline string, boolean, date serial, formula with a cached value, formula
without one, `t="e"` error, a table starting at a sheet-row offset, `fullCalcOnLoad` with and
without formulas in the mapped range, a missing table name, an empty range, and each limit above.

## What this phase does not prove

**Amended 2026-09-22. Both paragraphs below have since been overtaken, and neither was wrong when
written.** `reconcile_workbook_vs_repository` answered against a real library on 2026-09-17, so
phase 4a is no longer verified against fakes; and phase 2c shipped that same day, so a report no
longer carries `searchCrossCheckIncluded: false` unconditionally. What this phase still does not
prove is unchanged and worth keeping: a live run proves the plumbing, not the engine, because the
seeder's predicted report runs the same engine over the same plan and the two agree by construction
on anything the engine gets wrong. Original text follows.

It does not prove the composed tool returns a correct report against a tenant. That needs a live
run, and the sitting on 2026-09-16 could not reach step 7. Until `reconcile_workbook_vs_repository`
has answered against a real library, phase 4a stays verified against fakes.

Every report continues to carry `searchCrossCheckIncluded: false`, because phase 2c has not
started.
