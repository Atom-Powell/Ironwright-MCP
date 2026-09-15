# Synthetic tracking workbook seeding

Date: 2026-09-15
Status: designed, not implemented

## Why this exists

The live tenant sitting gates three unverified claims at once: that delta bounds the Graph request
count the way phase 2a argues, that the Excel session layer can open a real workbook at all, and
that `reconcile_workbook_vs_repository` returns a report. `npm run seed-library` already builds the
repository side of that sitting. The workbook side has no tooling: the runbook in
`docs/OPEN-ITEMS.md` tells the operator to place a tracking workbook by hand with a table matching
the example profile's mapping.

That hand step is the only part of the sitting with nothing behind it, and it is the input to the
layer that has never run. A workbook typed by hand is also a workbook whose contents nobody
recorded, so a surprising report cannot be separated from a typo.

This design gives the seeder a second half. It creates the workbook the profile points at, and it
prints the report it expects the live tool to return.

## Success criterion, and the one thing this cannot prove

After a seed, the operator runs the tool and compares its report against the one the seeder
printed. Anything that differs is a real finding.

The expected report is not hand-computed. The seeder assembles the `WorkbookSnapshot` and
`RepositorySnapshot` describing what it just wrote, in memory, and runs the pure engine over them
through its single public entry, `reconcile`. Hand-computing an expectation over a rolling window,
an effective-date exclusion and a quarterly anchor would be its own defect surface, and a wrong
expectation is worse than none, because the operator would chase the tool instead of the note.

**This comparison cannot catch an engine defect.** It asks the engine to predict itself, so the two
sides agree by construction on anything the engine gets wrong. What it catches is the live path
returning something different from what was seeded, which is Graph, Excel, Azure Table Storage and
the composition in `src/tools/reconciliation/`. That is exactly the set of layers the sitting exists
to exercise, and the set that fakes cannot reach. The engine is covered by the golden report over
synthetic fixtures from phase 3, offline, and nothing in this design adds to that coverage. A green
comparison is plumbing evidence and must never be written up as engine evidence.

## The seed plan is one object

Both halves derive from a single `SeedPlan` built before anything is written. The tree writer and
the workbook writer read the same plan, so the two sides of the reconciliation cannot drift from
each other, and the expected-report computation reads it too.

The plan is deterministic. The same arguments produce the same plan, so a re-seed does not
invalidate a printed expectation from an earlier run.

### What is planted

Three discrepancies, chosen to put one of each interesting kind into the live report:

| Planted | Where | What the report should say |
|---|---|---|
| `Client13` | A workbook row with no folder anywhere in the tree | Every period that client owes is missing |
| `Client04`, `2026-01` | The monthly file is not written | That one artifact is missing |
| `Client09`, `2026-01` | The monthly file is written as `2026-01_Client09_VendorTraining.xlsx` | That artifact is present and misnamed |

The misnamed form is the example profile's `vendor-token` recognizer, not `legacy-spaced`.
`legacy-spaced` anchors its client capture on `[A-Z0-9]+`, which cannot match `Client09`, so a file
in that shape would land as an `unrecognized` orphan and exercise the recognizer path not at all.
`vendor-token` captures the client as `[^_]+` and carries `verdict: "misnamed"`, which is the
finding this row is meant to produce.

Both plants sit in January, corrected 2026-09-15 from July and March. The month cap below stops the
tree at the current month, so a plant in a later month is simply absent for part of the year, and
the guard that refuses a plant it cannot place would refuse the whole seed with it. January is
reachable for every possible cap and is on or after the effective date every client gets.

Nothing else is planted. There is no `--with-drift` flag and no drift-free mode: two runbooks means
two expected reports to keep true, and the sitting needs one.

## A correctness fix this change forces into the open

`buildSeedTree` writes all twelve months of the seeded year. Against the example profile's rolling
twelve-month window and an `asOf` taken from the server clock, seeding the current year means the
months after the current one are files for periods that have not happened yet. The engine parses
them cleanly, finds no expected slot, and reports each as an `unexpected` orphan. Seeded in
September with the default twelve clients, that is thirty-six orphans plus the December quarterly,
swamping the three findings the sitting is looking for.

The noise exists today. Nothing surfaced it because nothing had ever computed a report over a
seeded tree.

So the tree stops at the current month when the seeded year is the current year, and still writes
all twelve months for a past year. A deliverable for a month that has not occurred is not a
realistic synthetic library in the first place.

This is a fix to the code the change is already working in, not an unrelated refactor.

## The workbook's contents

The example profile maps a table named `ClientRoster` with `headerRow: 1` and four columns:
`Client`, `Monthly Training`, `Quarterly Phishing`, `Onboarded`. The workbook carries a header row
and one row per client, including `Client13`.

`Monthly Training` and `Quarterly Phishing` are written as the string `Yes`. The engine's `isOwed`
treats `no` and `false` as falsey regardless of case and everything else as owed, so a string is
both the realistic shape for a hand-maintained tracker and the path that rule was written for. A
boolean cell would exercise less.

`Onboarded` is January 1 of the seeded year for every client, and it is written as an Excel date
serial with a date number format rather than as text. This is deliberate. A real tracker's date
column holds dates, so a range read returns serials, and `excelSerialToIsoDate` in
`src/workbook/read.ts` exists to convert them. That function has never seen a value that actually
came out of Excel. Writing text would route around the one piece of the reader whose correctness
depends on a Graph behavior no fake can establish.

The January 1 date is also what makes the expected set clean: with `respectEffectiveFrom` on, it
excludes the months of the previous calendar year that the rolling window would otherwise reach back
into, and those months have no folders.

## Module layout

`scripts/seed-library.ts` is already 747 lines. The new work lands in siblings rather than growing
it:

- `scripts/seed/blank-workbook.ts`, pure: the bytes of an empty single-sheet workbook.
- `scripts/seed/workbook.ts`: the Graph sequence that puts a populated, tabled workbook in the
  library.
- `scripts/seed/expected.ts`: assembles the two snapshots from the plan and runs `reconcile`.

`scripts/seed-library.ts` keeps argument parsing, the plan, the tree, and the report it prints.

## The blank workbook bytes

An `.xlsx` is a ZIP of XML parts, and the Excel API cannot open a zero-byte file. The blank workbook
is generated rather than committed as a binary, so the artifact is reviewable in a diff and
testable, and so the repository stays text.

Six parts: `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`,
`xl/worksheets/sheet1.xml`, and `xl/styles.xml`. Five of them make a workbook that opens. The sixth
is there because the `Onboarded` column needs a date number format, and a workbook carrying no style
table at all is the case most likely to make that call fail for a reason unrelated to anything this
project owns. Including a minimal style table costs a few hundred bytes and removes the question.
They are written
into a ZIP with stored entries, no compression, which keeps the container to local file headers, a
central directory and an end-of-central-directory record, with CRCs from `zlib.crc32`. Node 22 is
the floor in `engines` and `zlib.crc32` exists from 22 onward, so this needs no dependency.

Stored rather than deflated because the parts total a few kilobytes and compression would buy
nothing but a second failure mode.

## The Graph sequence

The folder containing the workbook is not part of the taxonomy, so the tree writer never creates it.
The example profile's `workbookPath` is `/Trackers/Operational Tracking Workbook.xlsx`, and the
workbook writer creates that parent folder itself, with the same conflict behavior the tree uses for
folders.

The blank generator names its single worksheet `Sheet1`, and the range and table calls address it by
that name. Both modules take the name from one exported constant rather than repeating the literal,
because a disagreement between them would fail only against a live tenant.

Against the seeder's own Graph client, four calls after that folder exists:

1. `PUT` the blank bytes to the workbook path from `profile.identity.workbookPath`.
2. `PATCH` the worksheet range with the header row and the client rows.
3. `POST` to `workbook/tables/add` over that range with `hasHeaders: true`.
4. `PATCH` the created table to name it `ClientRoster`.

Step 3 is where a malformed workbook fails, and it is placed here on purpose. It is the first call
that requires Graph to open the file as a workbook, so invalid bytes surface at seed time, attached
to the seeder, rather than at read time attached to `readWorkbookSnapshot`, which is one of the
things under test. A failure there reports the workbook as the suspect in those words.

The number format on the `Onboarded` column is set alongside step 2.

### Not through the server's Excel layer

None of this goes through `src/graph/excel.ts`. That module opens a non-persistent session and
therefore structurally cannot write, which is a locked decision in the Decision Record: the server
only ever reads a document that is the customer's live operational authority, and the guarantee is
meant to be structural rather than a matter of nobody calling the wrong method. The seeder writes,
so it uses its own client, as it already does for the tree. The existing comment in
`scripts/seed-library.ts` warning against handing that client to `readWorkbookRange` covers the
adjacent mistake and stays.

The seeder authenticating as the grant issuer, which already holds `Sites.FullControl.All`, is
unchanged by this design and is why it can write here at all.

## Error handling

Every failure names what was being attempted and what came back, and none of them infers a cause it
did not observe, per the project's message-audit practice. Three cases get specific messages because
an operator can act on each differently: the upload failing, `tables/add` failing (the workbook
bytes are the suspect), and a table named `ClientRoster` already existing at that path from a
previous seed.

The last is the re-seed case. The upload replaces the file, matching `FILE_CONFLICT_BEHAVIOR` for
the tree, so the table is created fresh on the new bytes each time. There is no update-in-place path
for an existing workbook.

## Testing

All of it against fixtures and the existing fake Graph transport. Nothing here touches a tenant,
which is the same standing as every other phase in this repository.

- The blank bytes: the ZIP parses, the five entries are present at the expected paths, the CRCs
  match their contents.
- The plan: the three planted discrepancies are where the plan says they are, and the plan is
  identical across two builds with the same arguments.
- The month cap: the current year stops at the current month, a past year writes twelve, both
  against an injected clock.
- The Graph sequence: the four calls are issued in order with the expected bodies, and a failing
  `tables/add` produces the message naming the workbook as the suspect.
- The expected report: asserted against a fixture, so a change to the planted set cannot silently
  change what the sitting is told to expect.

## Two things checked rather than assumed

**The lint fence already allows this.** `eslint.config.js` applies its rules to
`src/**`, `tests/**` and `scripts/**` together, and the only restriction outside the domain layer is
`RECONCILE_ENTRY_POINT_PATTERN`, which refuses reaching past `domain/reconcile/index.js` into a
stage module. Importing `reconcile` from that entry point, and `ProfileSchema` from
`src/domain/profile/schema.js`, is exactly what the fence permits. No config change is needed. The
config's own comment already names `scripts/` as "a fixture generator held to the same
import-boundary standard as the rest of the repo".

**The seeder's header comment becomes false and must change with it.** `scripts/seed-library.ts`
opens by stating that it deliberately imports nothing from `src/domain/`, on the reasoning that a
fixture generator is not a legitimate consumer of the engine. That reasoning was about the token
substitution below it, which reimplements just enough of the naming template rather than reusing the
domain's renderer, and it stays true of that. It is not true of `reconcile`: predicting the report is
what the front door is for, and the alternative is a second implementation of the window, the
anchor and the effective-date rule, which is the duplication the single-entry rule exists to
prevent. The comment is rewritten to say which import is legitimate and why, because a comment that
is no longer true is the same defect class as a message that is no longer true.

## Sequencing against phase 4a

This work branches from `main` and depends on nothing in phase 4a. The seeder, the engine and the
workbook reader it targets are all on `main` already.

The sitting it serves does depend on phase 4a, because the tool whose report gets compared is the one
PR #10 wires. So this can be built and merged in either order, and the sitting needs both.

## Out of scope

No update path for an existing workbook. No drift-free mode and no drift flag. No change to
`src/graph/excel.ts` or to any part of the server. No second profile: this targets the example
profile's mapping, and a profile with a different table name or column set is the operator's to
write and the seeder's to read, not something this design generalizes over ahead of a caller.
