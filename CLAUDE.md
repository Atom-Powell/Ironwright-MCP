# CLAUDE.md: Ironwright MCP

Persistent session anchor. This is a stable reference, not a changelog, and it carries no
status. Where each phase stands lives in exactly one place, the "Where the build stands" table at
the top of `docs/OPEN-ITEMS.md`, alongside open items and decisions awaiting a human. The PAI
vault note and the README point at that table rather than restating it.

## Mission

A purpose-built, path-native Microsoft Graph and SharePoint reconciliation MCP server. It
answers what files should exist in a document library and whether they do, by reading an
operational tracking workbook as the expected state and diffing it against the repository's
actual contents.

The reason it exists is that every surveyed SharePoint MCP server, first-party and community
alike, is a thin per-call Graph wrapper: one tool, one Graph call. That shape reproduces the
recursive enumeration cost, the ID-navigation overhead, and the stale-ID failures that caused
the problem in the first place. This project is composite, server-orchestrated tools with a
real reconciliation engine and deterministic plan-then-execute writes. Since phase 6d it also
covers general file work inside a granted site, with no workbook: an operator describes renames
and moves with declarative selectors, and the server resolves them against its index into the
same reviewable, reversible plans. That is still not a per-call wrapper: the server decides which
files a request means, and nothing is written without a stored plan and a confirm. If an implementation
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
- `docs/OPEN-ITEMS.md` opens with the one status table for the whole build, then holds open
  items, decisions needing a human, and an honest record of what is verified against a live
  tenant versus only against fakes.
- `docs/SETUP.md` is the per-tenant operational procedure.
- `docs/superpowers/plans/` holds executed implementation plans, kept as history.
- `competitive-landscape-refresh-2026-09-24.md` is the current competitive picture: MCP
  marketplaces, adjacent products and user feedback, citation-audited. It corrects parts of the
  older `competitive-landscape.md`.
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
different document library of the same site. ETags with `If-Match` on every write; measured
against a real tenant on 2026-09-19, a `driveItem` PATCH returns the updated item carrying its new
`eTag`, so a write refreshes its own precondition from the response and needs no follow-up metadata
read. Each is built
with the caller that exercises it rather than ahead of any consumer, which is why phase 2b was
split on 2026-09-14: `$batch` moves to phase 6, where the write tools were expected to be its first
real caller, and the Microsoft Search cross-check becomes phase 2c. Amended 2026-09-17: the
cross-check's
original target, a file outside the taxonomy, was already covered by phase 2a's delta scan and the
matcher's `misplaced` finding; the real gap is a second document library of the same site.
Cross-site is out of reach on the same grant, since `Sites.Selected` trims Search results to the
one granted site. Amended 2026-09-19: phase 6a issues renames sequentially and deferred `$batch`
again, so it still has no caller. The measurement that decides when batching earns its complexity
now exists rather than being guessed at: a rename costs exactly one Graph operation, the plan-time
etag fetch costs one per candidate, and an excluded item costs none. Amended 2026-09-24 by phase
6b-1's probes: a same-library move is one PATCH addressing the target folder by
`parentReference.path` written RAW, since Graph refuses a percent-encoded folder with the same
generic 400 an absent folder gets; one PATCH moves and renames together; and every move sends
`conflictBehavior: fail`, which makes 6b-1 `conflictBehavior`'s first caller. Under it, an
occupied target name answers 409 `nameAlreadyExists` and nothing is replaced.

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
reader was its own session, phase 2b-2, and is the shipped reader this entry describes above.

**Single-flight scan coordination.** Adopted 2026-09-14 for scans in `src/scan/coordinator.ts`, where
concurrent scans share a process-level store client and a persisted `deltaLink` that outlive the
request. It exists for one failure: `runScan` answers a delta resync by clearing the inventory and
re-enumerating, and a concurrent call reading it inside that window would report every file in the
library as missing.

**State store.** Azure Table Storage for per-drive `deltaLink`s, inventory snapshots, plans, and
reversal logs. Plans stopped being a promise on 2026-09-19: a plan written by `generate_rename_plan`
persisted and was read back by `execute_rename_plan` in a separate tool call, through the real
`@azure/data-tables` client against Azurite. Azurite rather than a real Azure Table Storage
account, which no part of this store has met yet.

**Hosting. Amended 2026-11-06; the previous entry named Azure Container Apps as the hosting.**
The product is self-hosted in the customer's tenant. The container image is the unit of
deployment and ingress is the customer's choice; the server needs TLS termination in front of it
and nothing else, because inbound authentication is the server's own job. Three ingress paths are
documented: Microsoft dev tunnels as the quick start, Cloudflare Tunnel as the durable no-Azure
path, and Azure Container Apps as the reference cloud deployment, demoted from the only answer to
one of three. The reason was a hard constraint, no Azure spend and no pay-as-you-go anywhere, and
the shape it forced is the better product: one server per customer tenant, an app registration
and a `Sites.Selected` grant created in the customer's tenant, uncommitted profiles, and a license
that already forbids running it as a service for others. A hostname under Ironwright's own domain
fronts only what the operator runs, never a customer endpoint. Cloudflare Workers running the
workload was considered and rejected before this amendment and stays rejected; a tunnel is not
that. The reasoning is in
`docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md`.

**Identity.** Entra confidential client scoped via `Sites.Selected`, never tenant-wide
`Sites.ReadWrite.All`. This is the real least-privilege boundary, because Copilot Studio's DLP
governance is per-server rather than per-tool and cannot substitute for it. Enforced at runtime
since 2026-09-24: the server refuses any Graph token whose roles claim is not exactly
`Sites.Selected`, on every newly minted token and once at startup, and starts anyway only when
no token can be obtained at all, because Entra is unreachable or refuses the client id or secret,
never on a mismatch. An application holding `Sites.Selected` alongside a
broader permission can read sites it was never granted, so the boundary is only real if it is
checked where the token is used.

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
Since phase 6d the product also serves general file work inside a granted site, through
operator-authored plans and library-only profiles, with compliance still the centerpiece.

Amended 2026-11-06: compliance stays the centerpiece and is no longer the only domain. The
product is a core platform (Graph access, state, scan coordination, transport, inbound
authentication) hosting domain modules, each with its own profile kind and tools. The first three
modules are `compliance`, `library` and `assessment`, the last a governed assessment workspace
whose first consumer is a vendor risk agent. A profile addresses a set of sites rather than one,
settled now because the next domain after assessment, a CPA practice with one site per client,
needs it and it is a schema shape that is cheap before a second domain exists and expensive after.
The code holds invariants and the profile holds every convention a customer would recognize as
theirs; no customer constant enters the code. Spec:
`docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md`.

**Setup.** Two phases, because a live run proved Graph refuses a delegated token on the per-site
grant endpoint even for a Global Administrator. A separate grant-issuer application holds
`Sites.FullControl.All` and issues that grant with an app-only token, so the server's own
application never holds more than `Sites.Selected` at any moment, including transiently.

**Write-tool design.** Every mutating tool is plan-then-execute. A `generate_*` tool returns a
reviewable persisted plan; a separate `execute_*` tool applies it. Dry run is the hard default
and live execution needs an explicit confirm flag. Every execute path writes a reversal log
before applying, and that log is itself a valid plan, so rollback runs through the same code
path rather than a separate one.

Amended 2026-11-06: that rule governs every mutating tool over content the server did not create.
A lifecycle tool, the fourth tool kind, is gated by state preconditions instead of a dry run: it
refuses unless the prior stage is verified live in the lists and the drive, it creates records and
files only at paths the server computes, it overwrites only a file it created and only under an
ETag precondition, and it records every write in a per-assessment journal. One call per stage, no
confirm flag, safe to retry because a completed stage is reported rather than repeated. The reason
is a collision between the dry-run default and the assessment consumer's operating model, which
says never ask permission between workflow stages; a confirm flag is the moment generative
orchestration has been observed stopping to ask. The human review the dry run protected exists in
that workflow at the Evidence Auditor and the published document. Rollback of lifecycle writes is
held, because it would be this server's first delete.

## Tool Set

| Tool | Kind | Notes |
|---|---|---|
| `inventory_tree` | read | Full tree via delta, not recursive per-folder walks |
| `describe_workbook` | read | No source: lists sheets and tables. One source: its header row and columns, no mapping proposed |
| `reconcile_workbook_vs_repository` | read | The centerpiece. Expected versus actual, structured gap report |
| `query_repository` | read | Operational questions served from the state index |
| `validate_structure` | read | Per-client compliance against the profile taxonomy |
| `generate_rename_plan` | plan | Reviewable persisted plan |
| `execute_rename_plan` | write | Dry run by default, ETag preconditions |
| `generate_move_plan` | plan | Reviewable persisted plan |
| `execute_move_plan` | write | Same-library moves; cross-library is phase 6b-2 |
| `replicate_template` | write | Validates the source client internally before replicating |
| `generate_custom_plan` | plan | Steps an operator describes, resolved against the index; no workbook needed |
| `execute_custom_plan` | write | Dry run by default, ETag preconditions, reversal log; library-only profiles allowed |

A profile is `compliance` (the default: workbook, taxonomy, naming, deliverables) or `library`
(site and library only). A library-only profile works with `inventory_tree`, `query_repository`'s
`empty_folders` question and the two custom plan tools; every other tool refuses it before any
Graph request, and `tests/tools/profile-kinds.test.ts` makes every tool declare which it is.

There are three kinds, not two. A plan generator writes a plan, so `readOnlyHint` is false for
it. Calling one read-only would be exactly the decorative annotation this project exists to
avoid. A fourth kind, `lifecycle`, was designed on 2026-11-06 for the assessment module and is
described in the Write-tool design amendment above; its seven tools join this table when the
module ships.

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
- **Status has one home.** A phase's state changes in the "Where the build stands" table at the
  top of `docs/OPEN-ITEMS.md` and nowhere else, in the same commit that records the sitting,
  merge, or decision that changed it. No other document carries a copy. Until 2026-09-29 status
  was restated in this file, the README, the vault note and the specs, and keeping four copies
  in step failed repeatedly: after phases 4b and 4c this file still said a completed sitting was
  owed, and on 2026-09-29 the README still said phase 6a while the vault note called a merged PR
  unmerged. Nobody was careless. A copy that no task owns is a copy nobody updates.
- **No plan is written against an unverified assumption.** Every design spec carries an
  Assumptions section listing what the design takes as true about an external API this project
  has not yet called in that exact way, and about another module's output. Each row names its
  evidence: a dated live probe and what it returned, or a test that obtains the output from the
  real producer rather than constructing it. A row with neither blocks the implementation plan.
  The probe or the test comes first, and if it contradicts the spec, the spec is amended before
  any plan task exists. A reviewer checks that section before anything else. This was a lesson
  after phase 2b-1 and was followed when someone remembered it; it is a gate so that it no longer
  depends on that. See Lessons that became rules below.
- **Project knowledge wins** over background knowledge, but flag drift, since this surface moves
  fast and the locked decisions were current as of September 2026 rather than evergreen.
- **Direct prose over bullet-point walls** in explanations. This file uses structure because it
  is a reference document, not because that is the house style for a session.

## Build Sequence

The order and the scope of each phase, which do not change once set. Whether a phase is done,
held, or verified live is status, and status lives in one place: the "Where the build stands"
table at the top of `docs/OPEN-ITEMS.md`. This section deliberately says nothing about it, because
a second copy is the copy that goes stale. The spec carries the full phase descriptions, and the
Build Sequence as this file carried it through 2026-09-29, with every phase's narrative, is kept
frozen at the end of `docs/OPEN-ITEMS.md`.

1. **Foundation.** Stateless transport, every tool registered behind the contract test, the pure
   profile schema, the two-layer write gate, and scripted per-tenant setup.
2. **Graph performance layer**, sliced. 2a: the token provider, retry, path addressing, delta,
   both `StateStore` implementations and the repository snapshot. 2b: the workbook snapshot, read
   from the downloaded `.xlsx` bytes (2b-2), after the Excel session approach (2b-1) was
   invalidated. 2c: the Microsoft Search cross-check for a second library of the same site.
3. **Reconciliation engine.** Pure and fixture-tested, `reconcile` its single public entry. This
   is the MVP checkpoint.
4. **Read tools**, sliced. 4a: the tool execution layer and `reconcile_workbook_vs_repository`.
   4b: `inventory_tree`, `query_repository` and `validate_structure`. 4c: `describe_workbook`.
5. **Hosting**, split at the Azure line. 5a: the deployable server, compiled by `npm run
   build:prod` without `src/setup`, with a bounded shutdown and a `/health` that never calls
   Graph. 5b: the container image, the federated managed-identity credential, Container Apps at
   one replica with no overlapping revisions, the Entra front door, CI/CD and telemetry.
6. **Write tools**, sliced vertically per
   `docs/superpowers/specs/2026-09-18-rename-write-path-design.md`, each slice building only the
   substrate its own tools call. 6a: rename. 6b-1: same-library move. 6b-2: cross-library move.
   6c: `replicate_template` and folder creation. 6d: operator-authored custom plans and
   library-only profiles. `$batch` arrives with the first caller whose measured cost justifies it.
7. **Copilot Studio integration and governance.**
9. **Domain platform and the assessment domain**, added 2026-11-06 and numbered after 8 because
   the order of the earlier phases does not change. Sliced into four plans per
   `docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md`: 9a probes
   and the grant, 9b the core (modules, site sets, inbound authentication, the lifecycle kind, the
   Graph operations, the journal), 9c the assessment module, 9d ingress and Copilot Studio contact.
   The CPA practice domain follows as its own phase once 9 is verified live.
8. **Evaluation suite**, whose questions are already written in `docs/EVALUATION-QUESTIONS.md`, so
   that phase 3 had a concrete target rather than inventing its own test afterward.

## Lessons that became rules

Two incidents produced the assumption gate in the Working Agreement. The full accounts are in the
frozen Build Sequence at the end of `docs/OPEN-ITEMS.md`; what follows is why the rule exists.

**An API this project had never called.** Phase 2b-1 was built, reviewed across six tasks, and
merged without one call reaching the Graph Excel API it was written for, and every fake in the
suite answered as though the call had been accepted. The first live run showed the API refuses
app-only tokens outright. A fake proves the code does what its author believed the API would do.

**A module this project had never read closely.** Phase 6a's spec assumed two files competing
for one canonical name would appear as two `ArtifactFinding` entries; `matchArtifacts` resolves
one winner and demotes the rest to a `DuplicateFinding`. Separately, four hand-built fixtures
described report shapes the engine can never produce, and each survived its own review until
someone traced it against the engine. A fixture proves the code does what its author believed the
producer returns, which is the Excel lesson aimed inward.

Both were caught late and paid for in rework. The gate exists so the next one is caught before a
plan is written, rather than depending on someone remembering these paragraphs.

## Reference

- MCP TypeScript SDK: `https://github.com/modelcontextprotocol/typescript-sdk`
- Microsoft Graph JS SDK: `https://github.com/microsoftgraph/msgraph-sdk-javascript`. Not a
  dependency; see the Decision Record. Useful as a reference for Graph's request and response
  shapes.
