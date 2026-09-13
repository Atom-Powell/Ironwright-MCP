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

**Stack and transport.** TypeScript and Node with the official MCP SDK and the Microsoft Graph
JS SDK. `StreamableHTTPServerTransport` in stateless mode with a new `McpServer` per request,
which Copilot Studio requires and which prevents cross-request state leakage.

**Graph access, in priority order.** Path-based `driveItem` addressing over ID addressing.
`$batch` for combining requests, respecting the 20-request and 4 MB caps. Delta query with a
persisted `deltaLink`. Microsoft Search as the cross-check for files outside the expected
taxonomy. ETags with `If-Match` on every write.

**Excel as a database.** Persistent workbook sessions, the session header on every call,
explicit detection and recreation of expired sessions, and a sequential single-flight queue per
workbook.

**State store.** Azure Table Storage for per-drive `deltaLink`s, inventory snapshots, plans, and
reversal logs.

**Hosting.** Azure Container Apps, Node-native and stateless, minimum one replica. Cloudflare
Workers was considered and rejected for this workload. Do not relitigate without a real cost or
latency reason.

**Identity.** Entra confidential client scoped via `Sites.Selected`, never tenant-wide
`Sites.ReadWrite.All`. This is the real least-privilege boundary, because Copilot Studio's DLP
governance is per-server rather than per-tool and cannot substitute for it.

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
| `describe_workbook` | read | Proposes a workbook mapping for human review |
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

## Working Agreement

- **Design before implementation.** Significant features get a short design dialogue with
  decisions confirmed before code is written.
- **STOP-AND-ASK is load-bearing.** Architectural forks, anything touching the Decision Record,
  and licensing or naming questions surface for a decision rather than being auto-resolved.
- **Gate-based approval.** No destructive or cross-module operation without a clean tree, a green
  suite, and sign-off.
- **Conventional commits.** Direct to main for routine work; feature branches with PRs and no
  auto-merge for anything risky or architectural.
- **Project knowledge wins** over background knowledge, but flag drift, since this surface moves
  fast and the locked decisions were current as of September 2026 rather than evergreen.
- **Direct prose over bullet-point walls** in explanations. This file uses structure because it
  is a reference document, not because that is the house style for a session.

## Build Sequence

The spec carries the full phase descriptions. Status as of 2026-09-12:

1. **Foundation.** Complete and merged. Stateless transport, all ten tools registered as honest
   stubs behind the contract test, the pure profile schema, the two-layer write gate, and a
   scripted per-tenant setup verified end to end against a live tenant.
2. **Graph performance layer.** Next. Path addressing, batch, delta, Excel sessions, the state
   store.
3. **Reconciliation engine.** Pure and fixture-tested, no Graph dependency, so it can be built in
   parallel with phase 2. This is the MVP checkpoint.
4. **Read tools wired**, then **hosting**, then **write tools**, then **Copilot Studio
   integration and governance**, then the **evaluation suite** of roughly ten realistic
   multi-tool questions, which is the actual test of whether the break-the-mold goal was met.

Three decisions block phase 2 and are written up in `docs/OPEN-ITEMS.md`. Read them
before starting it.

## Still open

The product name. The repo is `Ironwright-MCP` and the README calls it Ironwright MCP, but no
distinct product name has been chosen, and the reconciliation and stewardship framing suggests
better options exist. Not urgent, and cheaper to change now than after a Copilot Studio
connector carries it.

## Reference

- MCP TypeScript SDK: `https://github.com/modelcontextprotocol/typescript-sdk`
- Microsoft Graph JS SDK: `https://github.com/microsoftgraph/msgraph-sdk-javascript`
