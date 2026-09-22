# Design: wiring the reconciliation tool

Date: 2026-09-14
Status: Implemented. Verified live on 2026-09-17, when `reconcile_workbook_vs_repository` returned
a correct report against a real SharePoint library for the first time. (Corrected 2026-09-22; this
line read "Approved (design only)" until then.)
Extends: `2026-09-11-repository-reconciliation-mcp-design.md`, which settles the tool set, the
transport, the safety model and the phase sequence. This addendum settles what phase 4 left open:
how a tool call reaches real code at all, how a `profileId` becomes a `Profile`, where the
reconciliation engine's two inputs are fetched from on each call, and how a report that can run to
thousands of findings is returned to a consumer with a context budget.

Builds directly on `2026-09-13-graph-repository-snapshot-design.md` and
`2026-09-14-workbook-snapshot-design.md`, which delivered the engine's two inputs, and on the
reconciliation engine from phase 3, which has been finished and waiting since before either input
existed.

## Scope: one tool, and the layer it forces

The parent spec's phase 4 is five read tools. This slice delivers one of them.

**In scope: `reconcile_workbook_vs_repository`, wired end to end**, plus the machinery a tool call
needs to reach real code, which does not exist today in any form: a handler contract, a per-process
dependency context, a profile registry, scan coordination, an error-to-message mapping, and a real
output schema in place of the shared stub.

The layer is the risky part and the tool is one inhabitant of it. Proving it against one consumer
before four is the same reasoning that split phase 2b.

**Out of scope, staying as stubs: `inventory_tree`, `describe_workbook`, `query_repository`,
`validate_structure`.** Each inherits the execution layer with no retrofit, because a definition
without a handler keeps exactly the behavior it has now. Two of them also carry unresolved design
questions of their own: `describe_workbook` has to propose a mapping rather than consume one, and
`validate_structure` has to decide what it adds over the per-client rollup this tool already
returns.

**Still out of scope, and visible in every report this slice produces: the Microsoft Search
cross-check.** Phase 2c has not been written. `searchCrossCheckIncluded` stays `false` and the tool
says so in words, not only in a boolean.

**Amended 2026-09-22. All four stubs are now wired, and both of the design questions were answered
in the opposite direction to the guess above.** Phase 4b wired `inventory_tree`,
`query_repository` and `validate_structure` on 2026-09-18; phase 4c wired `describe_workbook` the
same day, which closed phase 4.

`describe_workbook` does NOT propose a mapping. 4c settled that it proposes no `columns` map at
all and says in its own output that it did not, because those keys are the profile author's
vocabulary and the tool has not seen the deliverables. It reports header text, inferred type,
distinct count and bounded samples instead, which is the evidence a human needs, and a mapping it
invented would be a plausible artifact harder to audit than no artifact.

`validate_structure` answered its question by narrowing: it checks conformance, not completeness.
Which folders a client requires is a workbook fact it deliberately does not read, so completeness
stays with `reconcile`, which holds the evidence.

The Search cross-check shipped as phase 2c on 2026-09-17. `searchCrossCheckIncluded` is now set
from whether the cross-check completed, so a report is no longer degraded by default, and when it
is the snapshot carries one of four distinguishable reasons rather than a bare `false`.

## Decision: the handler contract, and why the context is required

`ToolDefinition` gains an optional `handler`. A definition without one keeps the stub behavior
`buildServer` already provides, so the nine unwired tools are untouched by this slice.

```
ToolContext = { profiles, graph, store, scans, now }
ToolHandler = (input: unknown, ctx: ToolContext) => Promise<CallToolResult>
```

`buildServer({ allowWrites, context })` takes the context as a **required** field rather than an
optional one. The alternative is cheaper by two test call sites and worse in the way this project
cares about: a server constructed without dependencies would silently serve a stub for a tool that
does have a handler, and a stub answer to a compliance question is a confident wrong answer with no
signal attached. Required means a deployment that cannot reconcile fails to start instead.

The context is **process-lifetime, built once in `main.ts`**, and this does not contradict the
locked decision that a fresh `McpServer` is built per request. That decision is about MCP protocol
state, which stateless mode has no session to scope. A Graph client and a table client are not
protocol state. Rebuilding them per request would discard the token provider's cache and mint a new
client-credentials token on every tool call, which is both slower and a Graph cost the token
provider was built to avoid.

## Decision: profiles are a directory, loaded and validated at startup

`IW_PROFILE_DIR` names a directory. Every `*.json` in it is read and validated once at process
start, and indexed by the `profileId` **field inside the file**, not by the filename. Two files
claiming one `profileId`, or one file that fails `ProfileSchema`, fails the deployment.

Startup rather than per call, because a profile mistake does not surface as an error. It surfaces as
a wrong compliance finding weeks later, which `load.ts` already says in its own comment is far more
expensive to diagnose than a rejected profile. A profile that cannot load should take the deployment
with it, not wait to be discovered by whichever tool call happens to name it.

Indexed by the field rather than the filename because the filename is not the identity: the report
carries `profileId` from the profile itself, so a registry keyed on the filename could answer a call
for one profile with a report labeled another.

The registry splits in two so the validation is testable without a filesystem: a pure
`createProfileRegistry(entries)` over already-read contents, and a thin `loadProfileDirectory(dir)`
that does the I/O. This follows the same instinct `scan/cli.ts` already shows around `readProfile`,
which was pulled out of `main.ts` precisely so its own failure mode had a test seam: keep the I/O
thin and testable, and keep everything that can fail on the contents of a profile out of it.

An unknown `profileId` at call time comes back naming the ids that are configured. Profile ids are
deployment names rather than secrets, and an agent that is told which ids exist corrects itself in
one turn instead of guessing.

## Decision: a live delta scan on every call

The tool calls `runScan` itself. It does not read whatever `npm run scan` last persisted.

The first call against a drive is a full enumeration; every call after it is incremental, which is
the property phase 2a exists to demonstrate and the only reason this is affordable. What it buys is
that the agent cannot be handed a silently stale answer. The alternative bounds the cost of a call
at the price of making `provenance.scannedAt` the only warning that a confident report describes a
library as it stood a week ago, and a timestamp buried in provenance is not a warning an LLM
reliably surfaces to the person reading its summary.

The tool writes to the state store while doing this, and `readOnlyHint` stays `true`. The
annotation describes the open world the tool touches, which is SharePoint, and the tool changes
nothing there. The state store is this server's own cache of what it has already enumerated.
`idempotentHint` stays `true` on the same reading: repeated calls have no additional effect on the
environment, and two calls over an unchanged library return the same report.

**Order within the call: the workbook first, then the scan.** The two are independent and could run
concurrently, but a broken workbook mapping is both the likeliest failure in this pair and the
cheapest to detect. Reading it first means an operator whose mapping points at a renamed column
learns that immediately rather than after paying for a full library enumeration. Concurrency would
halve the latency of the calls that succeed and muddy the error attribution of the ones that do
not, which is the wrong trade for a first wiring.

## Decision: in-process single-flight scan coordination

Two concurrent calls on one drive mostly collide harmlessly. They read the same `deltaLink`,
enumerate the same changes, apply them idempotently, and the loser's stale link landing last costs
a re-read of pages already applied.

The exception is not harmless. On a `DeltaResyncRequiredError`, `runScan` calls
`store.clearInventory` and re-enumerates from nothing. A second call reading `listInventory` inside
that window sees an empty or half-built inventory and reports **every file in the library as
missing**. That is a catastrophically wrong compliance answer delivered with full confidence to a
consumer that acts on it, which is the failure mode this project exists to prevent.

`ScanCoordinator` is a process-lifetime map from a key to an in-flight scan promise. A second call
arriving while a scan is running awaits that scan's result instead of starting its own. The entry
is deleted in a `finally`, so a failed scan does not poison the key for every call after it.

**Keyed on `profileId`**, not on the drive id. A profile names exactly one site and one library, so
the profile id determines the drive, and it is known before the call starts. The drive id is not: it
comes back from `resolveDrive` inside `runScan`, by which point the race this exists to prevent has
already started.

One consequence is easy to get wrong and would be a fresh instance of the defect this project
produced nine times. A joiner receives the **same `ScanResult` object**, including its
`graphRequests` count. Two reports each claiming the same fourteen Graph requests, for a pair of
calls that made fourteen between them, is a function asserting a cost it did not pay. So the
coordinator returns `{ result, joined }`, and the joiner's provenance reports its own Graph cost as
zero and states that it shared a scan with a concurrent call.

**This coordinates within a replica and not across them.** Recorded as a known gap rather than
solved here: a lease in Azure Table is correct at any replica count and is genuine
distributed-systems work, meaning renewal, expiry, crash recovery, and a matching implementation in
the in-memory store, inside a slice whose job is wiring one tool. Until phase 5 decides, hosting
stays at one replica, and `docs/OPEN-ITEMS.md` carries both the gap and that constraint.

### Amendment to the Decision Record

`CLAUDE.md` records the sequential single-flight queue as **deferred, not adopted**, and gives the
reason: it assumed a long-lived process holding Excel sessions across calls, and a stateless
per-request `McpServer` cannot share a session, so there was nothing to serialize. That reasoning
was correct and it does not cover this case. Scans do not share a session; they share a
process-level store client and a persisted `deltaLink`, both of which outlive the request. The
mechanism fits here where it did not fit there.

This is an amendment with its own reason, not a silent override of a locked decision. The Excel
deferral stands unchanged.

## Decision: exceptions first, with the counts always complete

A real tenant's report is hundreds of clients across a twelve-month window, which is thousands of
artifact findings. Returned whole, the realistic outcome is that the transport or the model
truncates it somewhere neither this server nor the caller can see or report.

`structuredContent` carries, always complete and never filtered by size: the window, provenance,
every client's summary and full counts, duplicates, orphans, empty folders, and rejected workbook
rows.

**Omitted by default: the compliant artifact rows, and only those.** They are the bulk of the
payload and they carry nothing the per-client counts do not already carry authoritatively. An agent
answers "is CLIENTA compliant" from `clients[].compliant` without reading one artifact row, and the
rollup is computed by tallying the findings themselves, so it cannot disagree with the rows beneath
it. A caller who wants the compliant detail narrows with `clients`.

If the non-compliant findings still exceed a cap, the list is truncated and the **exact omitted
count appears in both `structuredContent` and the text block**. Never silently, and never as "some
findings were omitted": a number the operator can compare against the per-client counts is what
makes the truncation auditable rather than merely disclosed.

The cap is **200 non-compliant artifact findings**, one constant with no input to override it.
Findings serialize to roughly 200 bytes each, so 200 of them is on the order of 40 KB, which leaves
room for the per-client rollup and the orphan lists alongside it. A report that trips this cap is
already describing a repository in such wholesale disrepair that the per-client counts, which are
never truncated, are the useful answer and an enumeration of the first several hundred failures is
not. No input overrides it, because a caller who raises the cap to avoid truncation has removed the
only bound on a payload nobody measured.

## Decision: the `clients` filter applies after the engine, never before

Filtering the workbook before `reconcile` runs would be cheaper and is wrong. The engine classifies
a parsed file whose slot it cannot find as an `unexpected` orphan, and every other client's files
have no slot in a filtered derivation. A report narrowed to one client would invent orphans for the
whole rest of the library and attribute them to nothing.

So the engine always runs over the complete workbook and the complete repository, and the filter
narrows the shaped output afterward. It applies to what is attributable to a client: `artifacts` and
`clients`. It does not apply to unrecognized orphans or empty folders, which are attributable to no
client by definition, and those are returned unfiltered with the output stating they are
repository-wide rather than scoped to the filter. Duplicates and `unexpected` orphans carry a parsed
client and are filtered with the rest.

A `clients` value naming a client the workbook does not contain is reported as such rather than
returning an empty report, because an empty report and "that client is not tracked" are the same
absence and only one of them means the caller asked the wrong question.

## Decision: `asOf` comes from the server clock, in UTC, with no input for it

`reconcile` takes `asOf: Period` and stays pure; the tool supplies it from `now()`, read as UTC.

No `asOf` input. Nothing in `docs/EVALUATION-QUESTIONS.md` asks a historical question, the report
carries its own resolved `window`, so any answer is auditable against the month it was computed for
after the fact, and an input the model can populate wrongly is an input that produces a confidently
wrong report. UTC rather than local time because the host's timezone is not part of the answer and a
report should not depend on which region the container runs in. The consequence is that for a few
hours around a month boundary the window advances before a negative-offset operator's local calendar
does; the resolved window in the report makes that visible.

## Errors, and what the operator reads

Failures return `isError: true` with an operator-readable text block rather than a JSON-RPC error,
so the model can react to the failure instead of seeing a transport fault.

**The plan must verify against the SDK whether an `isError` result is exempt from `outputSchema`
validation.** A tool that declares an `outputSchema` and returns an error with no
`structuredContent` is the ordinary case, but this has not been checked against the version in use,
and assuming it is exactly the kind of assumption that ships as a runtime failure on the first real
error. If it is not exempt, the fallback is a discriminated output schema whose error branch is
valid.

**Settled by observation, and recorded in `docs/OPEN-ITEMS.md` under its own heading.** It is
exempt. The fallback was not needed and no discriminated output schema exists.

Each failure names what an operator can act on, and nothing else:

- An unknown `profileId` names the configured ids.
- A profile that names a site or library Graph cannot resolve names the site URL and the library
  from the profile, since the profile is the thing that is wrong.
- A workbook mapping that does not match the sheet reports what the existing reader already reports,
  unchanged, because that message was written for exactly this reader and has its own tests.
- A Graph failure carries the status and the Graph error code, and does not guess at a cause.

Rejected workbook rows are not a failure. They travel to the report, as phase 2b-1 settled.

## Provenance, and the two things the report must not let a reader assume

The shaped output carries `scannedAt`, `workbookSource`, `searchCrossCheckIncluded`, the scan mode
(`full` or `incremental`), whether a resync occurred, this call's own Graph request count, and
whether the scan was shared with a concurrent call.

Two of these are stated in the text block in words rather than left as fields, because a boolean in
`structuredContent` is not a sentence the model will pass on:

- **The Search cross-check did not run.** Without it a correctly named file outside the expected
  taxonomy is invisible, so every misplaced finding is unreliable and every missing finding is
  suspect. `RepositorySnapshot` already documents this; the tool is the first place a human reads
  it. **Amended 2026-09-22:** phase 2c replaced this unconditional sentence. The text block now
  says nothing at all when the cross-check completed, and names which of four reasons applied when
  it did not, because the remedy differs for each. The sentence's own claim about what is invisible
  was also narrowed: the gap is a file in a different document library of the same site, not a file
  outside the taxonomy, which a delta scan already resolves to `misplaced`.
- **Findings were truncated**, with the exact count, when they were.

## Module layout

| Path | Purpose | Pure |
|---|---|---|
| `src/tools/context.ts` | `ToolContext` and `ToolHandler` types | types only |
| `src/tools/reconciliation/run.ts` | The tool's composition root: profile, workbook, scan, engine | no |
| `src/tools/reconciliation/shape.ts` | Report to tool output: filter, omit, truncate | yes |
| `src/tools/reconciliation/output.ts` | The Zod `outputSchema` and its types | yes |
| `src/tools/reconciliation/text.ts` | The text block, derived from the shaped output | yes |
| `src/tools/errors.ts` | Failure to operator-readable message | yes |
| `src/profiles/registry.ts` | `createProfileRegistry`, `loadProfileDirectory` | split |
| `src/scan/coordinator.ts` | Single-flight scan coordination | no |

`shape.ts`, `output.ts` and `text.ts` are pure and unit-tested against fixtures with no Graph and no
clock, which is what lets the omission rule, the truncation rule and the filter be tested
exhaustively. They live under `src/tools/` rather than `src/domain/` because they are presentation
rather than domain: the lint purity fence covers the domain layer, and widening it to cover
presentation would invite the domain to import them.

`text.ts` is derived from the shaped output and from nothing else. That is the message-audit
practice applied structurally: a formatter that cannot see the report cannot describe a report it
did not produce.

## Testing

Beyond the existing contract and wire-contract suites, which pick up the new output schema with no
edit:

- `shape.ts` over the golden fixture: compliant rows omitted while counts stay whole, the filter
  applied to attributable findings only, unrecognized orphans and empty folders surviving a filter,
  truncation reporting an exact count, and a filter naming an untracked client.
- `text.ts` asserting each sentence against a shaped output that contradicts it, so a formatter that
  ignores its input fails.
- The coordinator: a second concurrent call joining rather than scanning, the joiner's Graph cost
  reported as zero, a failed scan not poisoning the key, and a sequential second call scanning again
  rather than reusing a completed result.
- The registry: duplicate `profileId` across two files, an invalid profile, and an unknown id naming
  the configured ids.
- `run.ts` against fakes: the workbook read happening before the scan, and each failure producing
  its own message.
- A wire test calling the tool through the real transport and asserting `structuredContent`
  validates against the declared `outputSchema`.

## Live verification

**Amended 2026-09-22. It has since been verified, and the MVP checkpoint it gates was reached on
2026-09-17.** `reconcile_workbook_vs_repository` returned a correct report against a real
SharePoint library that day, `isError` false, 2003 ms, 3 Graph requests, with every count matching
what the seeder predicted. One divergence was arranged deliberately and behaved: a `starter.xlsx`
left in the library root, unknown to both the seeder and the engine, came back as a second
unrecognized orphan. What the match does NOT establish is that the engine is correct, since the
prediction runs the same engine over the same plan in memory and the two sides agree by
construction on anything the engine gets wrong; it is plumbing evidence, which is what this
sitting was for. The original framing follows.

Nothing in this slice is verified against a tenant, and this slice does not change that. It composes
three layers that are each verified against fakes only, so a report it produces is exactly as
unproven as its inputs. The tenant sitting that phase 2a and phase 2b-1 are both waiting on now
gates a third thing: whether the composed tool returns a report at all.

`docs/OPEN-ITEMS.md` records this in the same terms it already uses for the other two, and adds the
cross-replica coordination gap and the one-replica constraint that follows from it.

## Amendments this requires

- `CLAUDE.md`: the single-flight queue is adopted for scans, with the reason it fits here and not
  where it was deferred. The Excel deferral is unchanged.
- `CLAUDE.md` and the parent spec: phase 4 is sliced, and this slice is the first tool.
- `docs/OPEN-ITEMS.md`: the cross-replica scan coordination gap, the one-replica constraint until
  phase 5, and this slice's live-verification status.
- `docs/SETUP.md`: `IW_PROFILE_DIR`, and that the server now requires the Graph credentials and the
  store connection string that only the scan command read before.
