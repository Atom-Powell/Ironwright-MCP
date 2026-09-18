# Phase 4b: the three index-served read tools

Design spec. Written 2026-09-17, after phase 2c merged and `main` reached `78a10c8`.

## What this phase delivers

Three of the four remaining read tools, wired onto the execution layer phase 4a built, plus the
tool-contract change that phase 4a's own open items named as due before any further handler is
written.

- `inventory_tree`
- `query_repository`
- `validate_structure`

`describe_workbook` is deliberately not in this phase. See "Deferred to 4c" below.

There is no new Graph capability here, no new store capability, and no new compliance logic. Every
layer this phase composes is already live-verified against a real tenant: the Graph and scan layer
from 2a, the workbook bytes reader from 2b-2, the cross-check from 2c, and the reconciliation engine
from phase 3. What 4b adds is contracts, composition, output shaping and operator prose.

## Scope boundary

Out of scope, explicitly:

- Workbook mapping inference of any kind.
- Persisting reconciliation reports, or any new stored entity.
- Pagination or continuation cursors.
- New profile configuration fields.
- Any write capability.

**Amended 2026-09-17, while the implementation plan was being written.** This section originally
excluded any new `StateStore` method. Writing the plan proved that exclusion incompatible with
`query_repository`'s zero-request promise, which the same spec makes and which evaluation question 8
measures. `listInventory` takes a `driveId`, and the only way to obtain one was `resolveDrive`, which
calls Graph. One read method is therefore added, described under `query_repository` below. Nothing
new is stored: it reads a partition the store already writes.

## The tool contract change

`ToolDefinition.inputSchema` is currently `z.ZodRawShape` (`src/tools/types.ts:18`). A raw shape is
a bag of per-field schemas and structurally cannot express a constraint that spans two fields.
`generate_move_plan` already needs one, because nothing enforces that `scopeValue` is present when
`scope` is `client` or `deliverable`. `docs/OPEN-ITEMS.md` carries this under "Before phase 4 wires
real handlers", with the argument that it is cheap now and costs one migration site per wired tool
later.

**The change.** `inputSchema` becomes a full Zod schema rather than a raw shape. The MCP SDK already
supports this: `registerTool` is typed `InputArgs extends undefined | ZodRawShapeCompat | AnySchema`,
so `src/mcp/build-server.ts` passes the schema straight through with no adapter.

All ten definitions migrate in this phase. Three are being rewritten substantively anyway; the other
seven, which are `reconcile_workbook_vs_repository` plus the six tools still unwired, migrate by
mechanical rewrite from
`{ a: schema, b: schema }` to `z.object({ a: schema, b: schema })`. No refinement is added to any
tool in this phase, because none of the three tools being wired needs one. The capability is what is
being built, not a use of it.

**One rule rides with it.** An object-level refinement does not survive the conversion to JSON
Schema, so a caller and the model driving it never see it. A refinement that is invisible in the
schema and unstated in the prose is a rejection the caller could not have predicted. The contract
test therefore gains a rule: a tool whose input schema carries a refinement must state that
constraint in its description. The test detects a refinement by checking whether the schema is not a
plain `ZodObject`, which is what a `.refine` or `.superRefine` produces, and asserts the description
is non-empty on that path. The rule has no subject in this phase and exists so that phase 6 cannot
add one without stating it.

**Amended 2026-09-18, after the rule was measured rather than assumed.** The paragraph above is what
this spec asked for and it is NOT what the branch built. A test written during execution measured
what the MCP SDK actually does with a refined schema: registration succeeds, and `listTools` then
advertises the tool as an object with no properties at all, so every field disappears from what a
caller sees. Only the constraint was expected to be invisible; the whole field list is. A tool a
model cannot see the inputs of is worse than a tool with an unstated constraint, so the rule
inverted. A top-level refinement is BANNED by the contract test, and a characterization test pins
the SDK's behavior so a future version that fixes it fails that test and tells us.

`inputConstraints` survives the inversion with a different job. It no longer describes a refinement
in the schema; it describes a cross-field constraint the handler enforces during its own parse, which
the advertised schema cannot express. The requirement underneath both versions of the rule is
unchanged and is the part that matters: a constraint a caller cannot see must be stated in the
description, or the rejection is unpredictable. That requirement is enforced by a contract test
asserting that a tool setting `inputConstraints` contains that text in its description.

Phase 6 needs a cross-field constraint for `generate_move_plan` and has two routes, both recorded in
`docs/OPEN-ITEMS.md`: enforce it inside the handler's own parse, or advertise the plain object and
parse with the refined one.

**Also amended 2026-09-18.** Two smaller corrections this document owed. The export amendment above
names `findEmptyFolders` and `createFileParser`; `MONTH_NAMES` was exported from the same index for
the same lint reason and belongs in that list. And `validate_structure`'s output below nests its
per-client omission counts under a `detail` object, where the implementation puts them flat on the
client. The flat form is better and is what shipped.

## Shared behavior, decided once

These apply to all three tools and are not restated per tool.

**Truncation is honest or it does not happen.** Every tool that returns a list computes its totals
over the complete result set and reports them exactly, then truncates the listing to a fixed cap and
states how many items were omitted and what the caller can do to narrow the request. A count is never
the count of what was returned when it is presented as a count of what exists. This is the same rule
`src/tools/reconciliation/shape.ts` already implements and it is the reason a truncated answer here
can never be mistaken for a complete one.

**Caps.** `inventory_tree` returns at most 500 items. `query_repository` returns at most 200
findings. `validate_structure` returns at most 50 entries in each per-client detail list. These are
constants in the shaping module of each tool, named and exported so the tests assert against the
same value the code uses.

**Every response carries the age of its evidence.** `scannedAt` appears in all three outputs. A
caller cannot judge whether an answer is current unless the answer says when it was gathered.

**Graph cost is reported, not estimated.** Each output carries `graphRequests`, the observed count
for that call, taken from the same instrumentation the scan already exposes. `query_repository`
reports zero because it makes none; it reports the field rather than omitting it so the contrast is
visible in the response itself, which is what evaluation question 8 measures.

**Prose is audited against the structure it describes.** Each tool gets a `text` module producing
the human-readable summary, and its tests assert the summary sentence by sentence against a shaped
output that contradicts a naive reading. This is the message-audit practice the parent spec requires,
adopted after the same defect shipped nine times in phase 1: a message correct on its own and wrong
against what the program actually did.

**Module layout.** Each tool gets `src/tools/<tool>/run.ts`, `shape.ts` and `text.ts`, matching the
layout `src/tools/reconciliation/` already uses. The definition file attaches the handler; the
handler validates its own input with its own schema, per the contract in `src/tools/context.ts`.

**Failures map through `src/tools/errors.ts`.** No tool introduces its own error-to-message mapping.

**One correction inside that mapper, found 2026-09-17 while the plan was being written.**
`describeToolFailure` currently ends its `GraphRequestError` message with "while reconciling profile
X". It is shared by every tool, so the moment `inventory_tree` uses it, an operator reading a failure
from an inventory call is told the server was reconciling, which it was not. That is precisely the
defect class this project produced nine times in phase 1 and wrote a practice to stop: a message
correct on its own and wrong about what the program actually did. `FailureSubject` therefore gains a
required `tool: string`, set to the tool's own registered name, and the message names it. Every
existing call site and its tests update in the same task, and the reconcile message keeps meaning
what it means today because `reconcile_workbook_vs_repository` is what it will now name.

## `inventory_tree`

**Input.** `profileId` (required), `subPath` (optional, library-relative, no leading slash).

**Behavior.** Runs a delta scan through the existing `ScanCoordinator`, so a concurrent call joins
rather than issuing a second enumeration. Returns every item at or under `subPath`, or the whole
library when `subPath` is omitted. This is also the tool that populates the stored index
`query_repository` reads, which is why it scans rather than reading.

**Cost.** One delta scan. Measured live at 4 Graph requests cold and 3 warm against a tree of 144
files and 122 folders.

**Output.**

```
profileId: string
library: string
subPath: string | undefined
scannedAt: string
totals: { files: number, folders: number, bytes: number }
items: Array<{ path: string, name: string, kind: "file" | "folder", size: number | undefined, modified: string }>
listing: { returned: number, omitted: number, cap: number, truncated: boolean }
graphRequests: number
```

`totals` is computed over every matching item before truncation. `size` is absent for a folder
rather than zero, because zero is a real size for a file and a folder does not have one.

**Failure modes.** An unknown `profileId` fails with the registry's existing message. A `subPath`
matching nothing returns an empty listing with zeroed totals and is not an error, because "nothing is
there" is a correct answer to a well-formed question.

## `query_repository`

**Input.** `profileId` (required), `question` (required enum).

**The enum narrows from five values to three.** It becomes `empty_folders`, `naming_violations`,
`recent_reports`. `orphaned_files` and `non_compliant_clients` are removed.

Both removed questions require expected state, which means the workbook, which means a Graph
download. Answering them here would either break this tool's published promise that it costs no
requests, or give the repository a second tool that decides whether a client is compliant. The
Decision Record makes `reconcile` the single public entry for exactly that reason, so both questions
stay where the evidence for them is. The tool's description is rewritten to match, and this is a
deliberate narrowing of a published contract rather than an oversight.

**Finding the drive without a Graph call.** `StateStore` gains one read method:

```
getScannedDrives(profileId: string): Promise<Array<{ driveId: string, lastScanAt: string }>>
```

Both implementations already hold the answer. The Table implementation's `deltaLinks` table is
partitioned by `profileId` with the drive id as the row key and also stored on the entity, so this is
a single-partition query and nothing new is persisted. The in-memory implementation reads its own
map. A profile names one library, so the normal result has exactly one entry; when it has more, which
means a profile was repointed at a different library after a scan, the most recently scanned entry
wins and the response names the drive it used, because silently mixing two libraries' inventories
would be worse than either choice.

**Behavior.** Calls `getScannedDrives`, reads the stored inventory for the resolved drive through
`StateStore.listInventory`, converts those records with the existing `assembleSnapshot` from
`src/scan/snapshot.ts`, and answers from the resulting `RepositorySnapshot`. Makes no Graph call
under any input.

Each answer reuses the existing pure domain function rather than reimplementing its rule:

- `empty_folders` calls `src/domain/reconcile/empty-folders.ts`.
- `naming_violations` calls `src/domain/reconcile/parse.ts` and reports every file that does not
  parse against the profile's filename standard.
- `recent_reports` returns the 50 most recently modified files that do parse, newest first. The
  bound is fixed rather than an input, because the published input schema carries only `profileId`
  and `question` and this phase narrows that schema rather than widening it.

Reusing those two modules is not a breach of the rule that reconcile's four stages stay internal.
That rule exists so two tools cannot disagree about a compliance verdict; sharing one definition of
"empty folder" is how agreement is guaranteed, and reimplementing it is what would break the rule.
**Amended 2026-09-17 during execution.** This paragraph originally ended by requiring that neither
module be re-exported from `src/domain/reconcile/index.ts`. That is not implementable: an ESLint rule
in this repository forbids importing a stage module directly from outside `src/domain/**`, stating
that the engine has one entry point. The two requirements are contradictory and the lint rule is the
older and the enforced one. `findEmptyFolders` and `createFileParser` are therefore exported from
`index.ts`, following the precedent `isIsoEffectiveFrom` already set, with a comment recording that
neither export lets a caller reach `deriveExpected` or `matchArtifacts`. The Decision Record's intent
holds: what stays unreachable is the ability to compute a compliance verdict, not the primitives the
verdict is built from.

**No snapshot is a failure, not an empty answer.** If the profile has never been scanned,
`getScannedDrives` returns an empty array and the tool fails with a message naming
`inventory_tree` and `reconcile_workbook_vs_repository` as the two ways to populate the index. It
does not return zero findings, because zero findings and no evidence are different answers and
reporting the second as the first is the exact substitution this project treats as its most
expensive failure.

**Cost.** Zero Graph requests, always.

**Output.**

```
profileId: string
question: "empty_folders" | "naming_violations" | "recent_reports"
scannedAt: string
findings: Array<{ path: string, name: string, modified: string | undefined, detail: string }>
totals: { matched: number }
listing: { returned: number, omitted: number, cap: number, truncated: boolean }
graphRequests: number
```

One findings shape serves all three questions, with `detail` carrying the question-specific reason:
the taxonomy folder that is empty, the way a filename departs from the standard, or the deliverable
the filename parsed as. A discriminated union per question would give the model three
shapes to learn for one tool and buys nothing the `detail` string does not.

## `validate_structure`

**Input.** `profileId` (required), `clients` (optional array).

**Behavior.** Runs a delta scan through the coordinator. Reads no workbook. Validates the clients
named in `clients`, or every client folder present in the library when the argument is omitted. For
each client it checks the profile's folder taxonomy and its filename standard, and returns a verdict
with the specific folders and files responsible for it.

**It checks conformance, not completeness. Decided 2026-09-17 while the implementation plan was
being written, replacing an earlier definition that could not be implemented.** The earlier text said
a compliant client has "every taxonomy folder the profile requires." Which folders a client requires
is not knowable here: a taxonomy segment can carry a `{deliverable}` placeholder, and which
deliverables a client owes is a workbook field this tool deliberately does not read. Rendering every
deliverable in the profile for every client would report clients non-compliant for folders they never
owed, which is a confidently wrong verdict of exactly the kind this project treats as its most
expensive failure.

What is well defined without a workbook is whether everything present is shaped correctly. That is
also the question evaluation question 7 asks, since a safe template source is one whose shape is
right. Completeness stays with `reconcile`, which holds the workbook.

**Verdicts.**

- `compliant`: every folder under the client matches some renderable taxonomy path, and every file
  under the client parses against the filename standard.
- `non_compliant`: the client folder exists and at least one folder under it matches no renderable
  taxonomy path, or at least one file under it does not parse.
- `missing`: the caller named this client explicitly and no folder for it exists.

`missing` is reachable only through an explicit `clients` argument. With the argument omitted the
client list comes from the folders present, so a client with no folder cannot appear in the input and
therefore cannot be reported missing. Without a workbook there is no authority on who should exist,
and inventing one from the repository would be a tool asserting something it cannot observe. A client
listed in the workbook with no folder at all is already reported by `reconcile` as owing every
deliverable, so the capability exists; it lives in the tool that holds the evidence for it.

**Cost.** One delta scan.

**Output.**

```
profileId: string
scannedAt: string
clients: Array<{
  client: string
  verdict: "compliant" | "non_compliant" | "missing"
  nonConformingFolders: string[]
  nonConformingFiles: Array<{ path: string, reason: string }>
  detail: { nonConformingFoldersOmitted: number, nonConformingFilesOmitted: number }
}>
totals: { compliant: number, nonCompliant: number, missing: number }
listing: { returned: number, omitted: number, cap: number, truncated: boolean }
graphRequests: number
```

Each per-client detail list truncates at 50 with its own omitted count, so a client with a thousand
non-conforming files does not crowd out the other clients in the same response.

## Testing

Fakes and fixtures only. The fake Graph transport and the in-memory `StateStore` that phase 4a's
tests already use serve all three tools; no new test infrastructure is needed.

Per tool: the handler's input validation, the run composition against a fake transport, the shaping
module's truncation and omission arithmetic asserted at and either side of the cap, and the text
module asserted sentence by sentence against a shaped output chosen to contradict a naive reading.

Across the registry: the existing contract test covers all ten tools and gains the refinement rule.
The migration to full Zod schemas must leave every existing contract assertion passing unchanged,
which is the check that the rewrite of the other seven definitions was mechanical.

`query_repository`'s zero-cost claim gets its own test: the fake transport asserts no request was
issued for any of the three questions, and the no-snapshot path asserts a failure rather than an
empty result.

## Verification before merge

This phase is covered by fakes until it has run against a tenant, and the branch does not merge
until it has. The rule was adopted after phase 2b-1 was designed, built, reviewed across six tasks
and merged without one call ever reaching the endpoint it was written for, and both phases since
found defects in their live run that no fixture could have caught, because a fixture builds both
sides of a comparison itself and they agree by construction.

The sitting is small. Against the existing seeded library: call `inventory_tree` with and without a
`subPath` and confirm the totals match the seeder's own counts; call `query_repository` three times
and confirm zero Graph requests on each and a failure before any scan has run; call
`validate_structure` with and without `clients` and confirm the verdicts match what the seeded tree
actually contains, including a named client that does not exist.

`docs/OPEN-ITEMS.md` records the result honestly either way, as it does for every phase.

## Deferred to 4c: `describe_workbook`

`describe_workbook` is the onboarding tool. It proposes a candidate profile mapping from a workbook,
which is worksheet, table, header-row and column-type inference, none of which exists anywhere in
this codebase. It is new logic rather than composition, and it is the only read tool that runs before
a profile exists.

Its current stub also carries a defect this phase records rather than fixes. Its input schema takes a
`siteUrl`, but this server holds `Sites.Selected` on one named site and cannot read any other. The
schema was written in phase 1, before the identity decision hardened, and it promises reach the
permission model forbids. 4c owns the correction, which is most likely replacing `siteUrl` with a
`profileId` or dropping it and taking the granted site from configuration.

## What this phase does not prove

It does not prove the answers are correct, only that they are produced. A live run confirms the tools
return reports against a real library and that the counts match a seeder's expectation, which is the
same standard phase 4a met. Correctness against a repository nobody seeded, at a scale nobody has
tested, is phase 8's question and it is deliberately still open.
