# CLAUDE.md: Ironwright MCP

Persistent session anchor. This is a stable reference, not a changelog. Live status lives in
the PAI vault note for this repo; open items and decisions awaiting a human live in
`docs/OPEN-ITEMS.md`. Keep both of those current and keep this file about what does
not change.

## Mission

A purpose-built, path-native Microsoft Graph and SharePoint reconciliation MCP server. It
answers what files should exist in a document library and whether they do, by reading an
operational tracking workbook as the expected state and diffing it against the repository's
actual contents.

The reason it exists is that every surveyed SharePoint MCP server, first-party and community
alike, is a thin per-call Graph wrapper: one tool, one Graph call. That shape reproduces the
recursive enumeration cost, the ID-navigation overhead, and the stale-ID failures that caused
the problem in the first place. This project is composite, server-orchestrated tools with a
real reconciliation engine and deterministic plan-then-execute writes. If an implementation
choice pulls back toward wrapping a Graph endpoint, that is a signal to stop and reconsider,
not a shortcut to take.

This is an Ironwright product built off-hours on personal infrastructure. A Copilot Studio
steward agent at the author's employer is the originating consumer and first user, not the
owner. No employer-specific constants belong in the codebase and no employer infrastructure is
used for development.

## Where things are written down

- `docs/superpowers/specs/2026-09-11-repository-reconciliation-mcp-design.md` is the design
  spec: decisions and their reasoning, architecture, the profile schema, the safety model, the
  phase sequence, and the message-audit practice this project learned the hard way. It is the
  binding document when anything disagrees.
- `docs/OPEN-ITEMS.md` holds open items, decisions needing a human, and an honest
  record of what is verified against a live tenant versus only against fakes.
- `docs/SETUP.md` is the per-tenant operational procedure.
- `docs/superpowers/plans/` holds executed implementation plans, kept as history.
- `Pain-Points.txt` is the de-identified original problem statement, and the two research
  documents carry the architecture and competitive analysis behind the locked decisions.

## Decision Record

Settled. If you think one is wrong, that is a STOP-AND-ASK, not a silent override.

**Stack and transport.** TypeScript and Node with the official MCP SDK, and plain `fetch` for
Microsoft Graph rather than the Graph JS SDK. The SDK's value is middleware -- retry, redirect
handling, and a batch helper -- and those are exactly the behaviors this project builds
deliberately and tests as units, so a dependency that hides them under inherited defaults is a
poor trade for typed models. Amended 2026-09-13; phase 1 had already gone this way without
recording it. `StreamableHTTPServerTransport` in stateless mode with a new `McpServer` per
request, which Copilot Studio requires and which prevents cross-request state leakage.

**Graph access, in priority order.** Path-based `driveItem` addressing over ID addressing.
`$batch` for combining requests, respecting the 20-request and 4 MB caps. Delta query with a
persisted `deltaLink`. Microsoft Search as the cross-check for a correctly named file filed into a
different document library of the same site. ETags with `If-Match` on every write. Each is built
with the caller that exercises it rather than ahead of any consumer, which is why phase 2b was
split on 2026-09-14: `$batch` moves to phase 6, where the write tools are its first real caller,
and the Microsoft Search cross-check becomes phase 2c. Amended 2026-09-17: the cross-check's
original target, a file outside the taxonomy, was already covered by phase 2a's delta scan and the
matcher's `misplaced` finding; the real gap is a second document library of the same site.
Cross-site is out of reach on the same grant, since `Sites.Selected` trims Search results to the
one granted site.

**Reading the workbook. Rewritten 2026-09-16 by a live tenant run; the previous entry is void.**
The Graph Excel API is unreachable from this server. `/workbook/` calls are refused with 403
`AccessDenied`, "Could not obtain a WAC access token", for an app-only token carrying any of
`Sites.FullControl.All`, `Sites.Selected`, `Files.Read.All` or `Files.ReadWrite.All`, while those
same tokens read the driveItem and download its content. WAC issues its token for a user and a
client-credentials token has no user, which no application permission can repair, and Microsoft's
Excel reference names only the delegated scopes. The workbook is therefore read by downloading the
`.xlsx` through `/content` and parsing the bytes in process.

One condition rides with that and is part of the decision rather than an implementation detail: a
mapped cell whose value cannot be read confidently from the bytes, above all a formula whose cached
result is absent or stale, surfaces as a rejected row and never as a substituted value. The engine
already carries a rejection onto the report, so this reuses the path phase 2b-1 built rather than
adding a mechanism. A parser that returns an empty string for an unevaluable cell produces a wrong
compliance finding with nothing raised anywhere, which this project holds to be the most expensive
failure it can have.

What the void entry got right and what it got wrong are both worth keeping. Its reasoning, that the
server must be structurally incapable of writing to the customer's live operational authority rather
than merely not calling the wrong method, still governs: a downloaded copy cannot write back at all,
so the guarantee is stronger than a non-persistent session gave. What it got wrong was assuming the
mechanism existed. It had never been run. The evidence is in `docs/OPEN-ITEMS.md`; the replacement
reader has no design yet, and writing one is its own session.

**Single-flight scan coordination.** Adopted 2026-09-14 for scans in `src/scan/coordinator.ts`, where
concurrent scans share a process-level store client and a persisted `deltaLink` that outlive the
request. It exists for one failure: `runScan` answers a delta resync by clearing the inventory and
re-enumerating, and a concurrent call reading it inside that window would report every file in the
library as missing.

**State store.** Azure Table Storage for per-drive `deltaLink`s, inventory snapshots, plans, and
reversal logs.

**Hosting.** Azure Container Apps, Node-native and stateless, minimum one replica. Cloudflare
Workers was considered and rejected for this workload. Do not relitigate without a real cost or
latency reason.

**Identity.** Entra confidential client scoped via `Sites.Selected`, never tenant-wide
`Sites.ReadWrite.All`. This is the real least-privilege boundary, because Copilot Studio's DLP
governance is per-server rather than per-tool and cannot substitute for it.

**Name.** The product is officially Ironwright MCP. Settled 2026-09-15, closing the last item
that was carried as open. Use that spelling in prose, with the repo staying `Ironwright-MCP`. The
identifiers follow it: the npm package is `@ironwright/mcp` and the advertised MCP server name is
`ironwright-mcp`. Both were renamed the same day, before any deployment or connector exists to key
on the old strings. The executed plan documents still quote the old server name and are left alone,
because they are history rather than current instruction.

**Product shape.** An Ironwright product under Elastic License 2.0, not an internal tool. One
server instance per customer tenant. Recurring-deliverable compliance is the fixed domain shape,
with taxonomy, filename standard, workbook mapping, and per-client cadence as declarative
profile data rather than code. Profiles are deployment configuration and are never committed.

**Setup.** Two phases, because a live run proved Graph refuses a delegated token on the per-site
grant endpoint even for a Global Administrator. A separate grant-issuer application holds
`Sites.FullControl.All` and issues that grant with an app-only token, so the server's own
application never holds more than `Sites.Selected` at any moment, including transiently.

**Write-tool design.** Every mutating tool is plan-then-execute. A `generate_*` tool returns a
reviewable persisted plan; a separate `execute_*` tool applies it. Dry run is the hard default
and live execution needs an explicit confirm flag. Every execute path writes a reversal log
before applying, and that log is itself a valid plan, so rollback runs through the same code
path rather than a separate one.

## Tool Set

| Tool | Kind | Notes |
|---|---|---|
| `inventory_tree` | read | Full tree via delta and batch, not recursive per-folder walks |
| `describe_workbook` | read | No source: lists sheets and tables. One source: its header row and columns, no mapping proposed |
| `reconcile_workbook_vs_repository` | read | The centerpiece. Expected versus actual, structured gap report |
| `query_repository` | read | Operational questions served from the state index |
| `validate_structure` | read | Per-client compliance against the profile taxonomy |
| `generate_rename_plan` | plan | Reviewable persisted plan |
| `execute_rename_plan` | write | Dry run by default, ETag preconditions |
| `generate_move_plan` | plan | Reviewable persisted plan |
| `execute_move_plan` | write | Async cross-library moves polled to a terminal state |
| `replicate_template` | write | Validates the source client internally before replicating |

There are three kinds, not two. A plan generator writes a plan, so `readOnlyHint` is false for
it. Calling one read-only would be exactly the decorative annotation this project exists to
avoid.

Every tool carries a Zod input schema with real constraints and worked examples, an
`outputSchema` with `structuredContent`, all four annotations set explicitly, and a description
whose prose states its safety status. A contract test enforces all of that over the whole
registry, so a tool added later inherits every check.

## Non-Negotiable Engineering Principles

- **Deterministic and auditable over agentic.** The LLM calls tools; it does not improvise Graph
  operations. Every plan is inspectable data.
- **Security-first at launch.** Scoping, dry-run defaults, and reversal logs ship in the same
  change as the capability they protect.
- **No production writes until read-only is validated** against known ground truth.
- **The domain layer is pure.** No I/O, enforced by lint. This is what lets the reconciliation
  engine be tested against fixtures before any tenant access exists, and it is the structural
  opposite of the thin-wrapper pattern.
- **A function that cannot observe an outcome must not assert it.** This project produced the
  same defect nine times: a message correct on its own and wrong against what the program had
  actually done. The spec's message-audit section explains what stopped it. Read it before
  changing anything an operator reads.
- **Comments explain why, not what**, especially around Graph quirks where the reason for a
  workaround will not be obvious six months from now.
- **Modular over monolithic.** The Graph-access layer is a standalone library the tool layer
  consumes.
- **No emojis or icons anywhere**, including logs and docs. **US English throughout.**
- **This repo's prose avoids em dashes and en dashes**, including inside string literals, in
  code, docs, and commit messages alike. As of this branch a test enforces it across the repo's
  tracked TypeScript, JavaScript, JSON, Markdown and YAML files, with two imported research
  documents named as exempt in the test itself because they predate the rule.

## Working Agreement

- **Design before implementation.** Significant features get a short design dialogue with
  decisions confirmed before code is written.
- **STOP-AND-ASK is load-bearing.** Architectural forks, anything touching the Decision Record,
  and licensing or naming questions surface for a decision rather than being auto-resolved.
- **Gate-based approval.** No destructive or cross-module operation without a clean tree, a green
  suite, and sign-off.
- **Conventional commits.** Direct to main for routine work; feature branches with PRs and no
  auto-merge for anything risky or architectural.
- **A live sitting is not recorded until this file is corrected too.** Writing the sitting up in
  `docs/OPEN-ITEMS.md` is half the step; the other half is editing the Build Sequence entry for
  that phase in the same commit, since it is the entry that says what the phase still owes. This
  is a written step because the omission has happened twice, after phase 4b and again after 4c:
  each time the sitting ran, passed, was recorded in `docs/OPEN-ITEMS.md`, and left this file
  asserting the sitting was still owed. Nobody was careless. The two edits simply belonged to no
  single task, so neither time was there anything to leave undone.
- **Project knowledge wins** over background knowledge, but flag drift, since this surface moves
  fast and the locked decisions were current as of September 2026 rather than evergreen.
- **Direct prose over bullet-point walls** in explanations. This file uses structure because it
  is a reference document, not because that is the house style for a session.

## Build Sequence

The spec carries the full phase descriptions. Status as of 2026-09-18:

1. **Foundation.** Complete and merged. Stateless transport, all ten tools registered as honest
   stubs behind the contract test, the pure profile schema, the two-layer write gate, and a
   scripted per-tenant setup verified end to end against a live tenant.
2. **Graph performance layer. Complete.** Split into 2a, 2b and 2c because it was more work than
   one implementation plan should carry; 2b split again into 2b-1 and 2b-2 when the live run
   invalidated the first attempt.
   - **2a: the Graph layer and the repository snapshot. Complete and verified live on 2026-09-16.**
     The token provider, `Retry-After`-aware retry, path addressing, the delta client, both
     `StateStore` implementations, the snapshot assembler, and the `scan` command, over plain
     `fetch`. A cold scan enumerated 144 files and 122 folders in 4 Graph requests and an immediate
     re-scan in 3, reusing the persisted `deltaLink` with no resync, against a tree a recursive walk
     would have cost at least 122 requests. The `as unknown as TableClientLike` cast, recorded as
     the one line no fake could check, held against the real `@azure/data-tables` client on Azurite.
     This phase's central claim is now a measurement rather than a design argument.
   - **2b-1: the Excel session and the workbook snapshot. INVALIDATED 2026-09-16 by the live run.**
     The Graph Excel API refuses this server's app-only tokens at every application permission
     tested, so the session manager and the mapped range read have no reachable endpoint and
     `readWorkbookSnapshot` cannot run. What survives the invalidation is the pure half: the reader
     that turns a grid into records and rejections never touched Graph, and the rejection path it
     built is what the replacement depends on.
   - **2b-2: the workbook bytes reader. Complete and verified live on 2026-09-17.** Downloads the
     `.xlsx` through `/content` under the same `Sites.Selected` grant and parses the bytes in
     process, supplying the engine's second input without an Excel session.
   - **2c: the Microsoft Search cross-check. Complete and verified live on 2026-09-17.** Finds a
     correctly named deliverable filed into a different document library of the same site. A
     deliverable moved into a second library moved from `missing` to `misplaced` naming that
     library, a copy left at the same relative path in both libraries did not erase the local
     file, and the other library contributed no orphans. Cross-site is structurally impossible
     rather than merely out of scope: Microsoft Search is trimmed to the `Sites.Selected` grant,
     confirmed by a live probe. A report no longer necessarily declares itself degraded; it carries
     one of four distinguishable reasons when the cross-check did not complete, and says nothing
     when it did.
   - The `$batch` builder left this phase on 2026-09-14 for phase 6. A delta-driven inventory
     has no use for it and a range read is one call either way, so its first real caller is the
     write tools.
3. **Reconciliation engine.** Complete, pending review. Pure and fixture-tested with no Graph
   dependency, which is what let it be built ahead of phase 2. `reconcile` is the single public
   entry; the four stages behind it stay internal so two tools cannot disagree about whether a
   client is compliant. Pinned by a golden report over synthetic fixtures covering every artifact
   state, both orphan kinds, duplicate resolution, the quarterly anchor, effective-date exclusion
   and a client who owes nothing. The engine enforces two input contracts phase 2 must satisfy:
   one workbook row per client, and repository files collapsed by path. This is the MVP
   checkpoint.
4. **Read tools**, sliced. **4a: the tool execution layer and the first wired tool.** Complete.
   The handler contract and the per-process `ToolContext`, the profile registry loaded and
   validated at startup from `IW_PROFILE_DIR`, the in-process single-flight scan coordinator, and
   `reconcile_workbook_vs_repository` wired end to end with a real output schema. Graph, Azure
   Table Storage and the workbook bytes reader have all been exercised live, and
   `reconcile_workbook_vs_repository` returned a report against a real library on 2026-09-17 once
   phase 2b-2 supplied the workbook snapshot.
   **4b: the three index-served read tools. Complete and verified live on 2026-09-18.**
   `inventory_tree`, `query_repository` and `validate_structure` are wired onto the 4a execution
   layer. The tool contract widened so `inputSchema` can be a full Zod schema rather than a raw
   shape, which is what lets a future refinement be expressed; `StateStore` gained one read
   method, `getScannedDrives`; and a pure taxonomy conformance matcher was added at
   `src/domain/structure/conform.ts`. All three tools ran against the live site through the MCP
   transport: `inventory_tree` reproduced phase 2a's 4-request cold scan through the tool layer,
   `query_repository` returned all three questions at zero Graph requests and refused before any
   scan had run, and `validate_structure` matched the seeded tree. The sitting found a cap defect
   no fixture could reach; `docs/OPEN-ITEMS.md` carries the dated record and what the sitting does
   not establish.
   **4c: `describe_workbook`. Complete, covered by fakes only.** All five read tools are now
   wired, which closes phase 4. `IW_SITE_URL` becomes required server configuration, replacing
   the stub's `siteUrl` input, which promised a reach the `Sites.Selected` permission model could
   never honor; the profile registry now refuses at startup a profile whose `identity.siteUrl`
   disagrees with the granted site, instead of that mismatch surfacing later as a 403. Two pure
   modules carry the new logic: `src/workbook/introspect.ts` enumerates a workbook's worksheets
   and tables without building a grid, surfacing one it cannot resolve rather than dropping or
   zeroing it, and `src/workbook/describe.ts` detects a header row, declining when two candidates
   are equally plausible, and describes a range's columns with inferred types and bounded
   samples. It proposes no `columns` mapping and infers no `date` type, both deliberate, and
   withholds every sample for a source when the workbook is `fullCalcOnLoad` over a range holding
   a formula. **Verified live on 2026-09-18.** Both modes ran against the live site through the
   MCP transport and a per-request `McpServer`, and the tool rediscovered a workbook mapping this
   repository independently knows is correct without being told any of it. The sitting also found
   a request-count defect no fixture could reach, since a download costs two counted Graph
   requests and the shared fake charged one. `docs/OPEN-ITEMS.md` carries the dated record and
   what the sitting does not establish. Phase 4 is complete.
5. **Hosting.** Split into 5a and 5b at the Azure line, because everything past producing a
   deployable artifact needs an Azure subscription, real spending, and an operator at a keyboard
   for at least the first sign-in.
   - **5a: the deployable server. Complete and verified on 2026-09-18.** The compiled production
     output answered all five read tools against the live tenant, every figure matching the phase 4b
     and 4c sittings; this was the first time this project executed its compiled artifact at all,
     every earlier sitting having run `tsx` against source. The shutdown deadline is NOT covered by
     that run, because Windows does not deliver a POSIX SIGTERM; it is covered by tests and by a
     probe against the compiled shutdown module. See `docs/OPEN-ITEMS.md`.
     Separates the production compile from the development one: `tsconfig.build.json` excludes
     `src/setup`, which issues per-site permission grants using a separate application holding
     `Sites.FullControl.All` and has no business inside a server image, and `npm run build:prod`
     runs it. Bounds the SIGTERM handler to a deadline, `IW_SHUTDOWN_DEADLINE_MS`, default 25
     seconds, so one request that never completes can no longer hold the process open until the
     platform sends SIGKILL with nothing said about why. The deadline logs one sentence
     synchronously before exiting, saying the drain did not finish, and deliberately no count:
     `getConnections` is the only API that reports open sockets, it defers its callback through
     `process.nextTick`, and `process.exit` does not drain that queue, so a number is not
     obtainable and the line that asked for one printed nothing at all.
     Settles that `GET /health` answers only whether this process can serve, and must never call
     Microsoft Graph, since a health check depending on a third party turns that party's outage
     into an instance restart loop. The container image was moved out of this phase by amendment,
     after discovering mid-plan that the development machine has no container runtime; it is held
     for its own slice rather than dropped, and the merge gate became the compiled production
     output answering live in its place. That gate, `node dist/server/main.js` built from `npm
     run build:prod` against all five read tools on the live tenant, is the controller's to run
     before merge and has not run yet; every live sitting this project has performed so far used
     `tsx` against source, never the compiled artifact. `docs/SETUP.md` carries the full
     deployment configuration contract this phase settled.
   - **5b: everything past the image.** Held rather than started. The container image itself,
     recorded in the design spec so this slice does not restart from nothing; the federated
     managed-identity credential replacing the client secret, which begins with a live probe
     rather than an interface built on an assumption, per the rule phase 2b-1 cost this project;
     Container Apps at one replica with a rollout that never runs a new revision alongside the
     old, since phase 4c made the single-process assumption load-bearing for correctness and not
     only for the delta link; the Entra authentication front door already decided in
     `docs/OPEN-ITEMS.md`; CI/CD; and telemetry, which carries two jobs, the Graph call volume
     evidence this project was started to produce and detection for the pending stream-mapping
     leak phase 5a deliberately left unfixed, since the tractable half of that item is detection
     rather than repair.
6. **Write tools**, sliced vertically rather than horizontally, per
   `docs/superpowers/specs/2026-09-18-rename-write-path-design.md`: a write layer built ahead of any
   caller is precisely the shape this project already rejected once.
   - **6a: the rename write path. Built and covered by fakes only; the live sitting has not run.**
     `generate_rename_plan` and `execute_rename_plan`, the first write this server has ever made,
     plus only the substrate those two tools need: a `GraphClient` PATCH verb carrying `If-Match`
     and distinguishing success, a 412 precondition failure, and a 404 not-found; `StateStore` plan
     persistence, one entity shape shared by a forward plan and the reversal log that reverses it,
     since a reversal log is a plan by the Decision Record's own words; and a pure domain module,
     `src/domain/rename/plan.ts`, that pairs each `misnamed` artifact with its canonical name and
     excludes what it cannot resolve without `conflictBehavior`. The plan stores concrete
     library-relative paths and a plan-time ETag fetch, not a rule, so a profile edited between
     generating and executing cannot silently retarget an already-reviewed plan. Execution is
     per-item: one file refused on a stale precondition does not block any other file in the same
     plan, and the reversal log is written before any write and corrected as each rename lands, so
     a crash mid-apply fails in the safe direction rather than silently. Deliberately out of this
     slice, and left for 6b and 6c: `generate_move_plan` and `execute_move_plan`, including async
     cross-library polling; `replicate_template`; the `$batch` builder; and `conflictBehavior`.
     Every one of them arrives with the caller that exercises it, the same rule that moved `$batch`
     out of phase 2. **No rename has been applied to a real SharePoint library, no reversal log has
     been replayed, and no real 412 has been observed.** `docs/OPEN-ITEMS.md` carries the dated
     record of exactly what is and is not covered; the merge gate is the full loop against the
     sandbox tenant described in the design spec's own verification section, and it has not run.
   - **6b and 6c.** Held rather than started: the move tools, `replicate_template`, `$batch`, and
     `conflictBehavior`, in the order 6a's own design spec lays out.
   Then **Copilot Studio integration and governance**, then the **evaluation suite**, whose
   questions are already written in `docs/EVALUATION-QUESTIONS.md`. They exist early on purpose, so
   phase 3 has a concrete target rather than inventing its own test afterward.

Of the three decisions the parent spec required before phase 2, two are settled and recorded in
`docs/OPEN-ITEMS.md`: the per-site grant does not accept a delegated token, and the MCP endpoint
authenticates through Container Apps built-in Entra auth. The third, which delegated scopes the
setup command's device-code sign-in must request, is still open, but it governs that sign-in
rather than the server's own Graph access, so it did not block phase 2b-1 and does not block
2c.

A fourth question, which nobody thought to ask, was settled the hard way on 2026-09-16: whether the
Excel API accepts an app-only token at all. It does not. The lesson is recorded here rather than
only in `docs/OPEN-ITEMS.md` because it generalizes past Excel. Phase 2b-1 was built, reviewed
across six tasks, and merged without one call ever reaching the endpoint it was written for, and
every fake in the suite answered as though the call had been accepted. A fake proves the code does
what the author believed the API would do. When a phase depends on an API surface this project has
never actually called, the cheapest possible live probe against that surface comes first, before
the design that assumes it.

Phase 6a produced a related failure on 2026-09-18, against this project's own reconciliation engine
rather than an external API, and it belongs here because the rule it teaches generalizes, not
because it was caught the same way. The phase 6a spec's "What a rename plan is" section made two
wrong assumptions about what `reconcile()` returns for two files competing for one canonical name:
that they would appear as two separate `ArtifactFinding` entries, and that the collision would be
found by grouping those entries by target path. `matchArtifacts` resolves one winner per slot and
demotes every other candidate to a `DuplicateFinding`, never a second artifact, so neither
assumption survives contact with the engine.

That defect was not found by a dedicated test written to catch it. Task 4's twelve tool-level tests
for `generate_rename_plan` already called the real `reconcile()` through the tool's own handler.
Nine of them failed first, against a separate wrong assumption, that `expectedPath` is a full file
path rather than the rendered taxonomy folder it actually is. Once that was fixed, the twelfth test
still failed, and tracing `match.ts` from that one remaining failure is what found the
two-artifacts-collide assumption above. `tests/domain/rename/plan.reconcile.test.ts` was written
afterward, so a future mismatch of this kind fails directly in the domain layer instead of only
surfacing as a tool-test failure that still has to be traced back to its cause. It closes the gap
this incident found; it did not itself catch this one.

A second, distinct family lived in four separate fixtures across three review rounds, and it is not
the same mistake as the grouping error above, though it is adjacent to it: each fixture hand-built a
report in which an artifact, a duplicate, or an orphan already occupied a rename candidate's target
path, independently of how `matchArtifacts` actually resolves competing candidates for one slot, a
shape that turns out to be unreachable once traced against the engine's own resolution. Three were
deleted in `55dc5ee`, "fix(tools): correct rename exclusion reasons and cost reporting found in
review", by a reviewer reading them and reproducing against the engine. The fourth, the
orphan-occupancy fixture, was found by the implementer's own reasoning during a later fix round and
deleted in `b7d48ef`, whose own message says as much: "each survived review until traced against the
engine." Every one of these four fixtures passed its own review before being caught, at the cost of
human tracing across three separate rounds, and none was caught by any reconcile()-backed test; each
was simply shown unreachable and deleted, with no replacement.

The rule both incidents point to: when a module consumes another module's output, at least one test
must obtain that output from the real producer rather than construct it. A fixture proves the code
does what its author believed the producer returns, which is exactly the shape of the Excel lesson
above, just aimed inward instead of outward. `plan.reconcile.test.ts` is what stops the next one
from surviving at all; it is not what caught either family described here.

## Reference

- MCP TypeScript SDK: `https://github.com/modelcontextprotocol/typescript-sdk`
- Microsoft Graph JS SDK: `https://github.com/microsoftgraph/msgraph-sdk-javascript`. Not a
  dependency; see the Decision Record. Useful as a reference for Graph's request and response
  shapes.
