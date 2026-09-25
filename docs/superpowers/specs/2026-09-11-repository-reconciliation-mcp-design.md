# Design: Repository Reconciliation MCP Server

Date: 2026-09-11
Status: Approved and substantially implemented. Phases 1 through 6a are built, each under its own
implementation plan in `docs/superpowers/plans/`. This document remains binding for anything it
still settles; where a later phase overturned something, the change is recorded as a dated
amendment in place rather than by rewriting the original. `CLAUDE.md` carries the current build
sequence and `docs/OPEN-ITEMS.md` the evidence for what has been run live.
Author: Adam Powell (Ironwright), with Claude Code

## Problem

SharePoint document repositories used for recurring compliance deliverables drift. Folders
exist without the reports they imply, filenames diverge from the approved standard, files
land at a client root instead of a dated folder, and the only way to find out is a recursive
folder walk costing hundreds of Graph calls. Existing MCP tooling makes this worse rather
than better, because every surveyed server wraps one Graph endpoint per tool, which
reproduces the ID-based navigation overhead, the enumeration cost, and the stale-ID failures
that caused the problem.

The deeper point from `Pain-Points.txt` is that the repository is not the only source of
truth. An operational tracking workbook records which clients owe which deliverables on what
cadence. The question worth answering is not "what files exist" but "what files should exist,
and do they." That is a reconciliation problem, and no first-party or community MCP server
implements one. A competitive review on 2026-09-11 confirmed this for both Microsoft's
Work IQ surface and every community SharePoint server found.

## Decisions

Locked before this session, carried forward from `CLAUDE.md` and the architecture research:
TypeScript with the official MCP SDK, and plain `fetch` for Microsoft Graph rather than the
Graph JS SDK (amended 2026-09-13; see the graph-lib paragraph below);
`StreamableHTTPServerTransport` in stateless mode with a new `McpServer` per request;
path-based driveItem addressing over ID addressing, `$batch`, delta query with persisted
`deltaLink`s, and Microsoft Search as the out-of-taxonomy cross-check; non-persistent Excel
sessions with deferred single-flight queueing; Azure Table Storage for state; Azure Container
Apps for hosting; Entra confidential client scoped via `Sites.Selected`;
plan-then-execute for every mutating operation with dry run as the default.


> **Amended 2026-09-16.** The non-persistent Excel session named in this paragraph is void. A live
> tenant run proved the Graph Excel API refuses app-only tokens at every application permission
> tested, so no session of either kind can be opened by this server. The workbook is read by
> downloading the `.xlsx` through `/content` and parsing the bytes in process, under the condition
> that an unevaluable cell becomes a rejected row rather than a substituted value. The reasoning
> the original decision rested on, that this server must be structurally incapable of writing to
> the customer's operational authority, is not weakened by the change; a downloaded copy cannot
> write back at all. See `docs/OPEN-ITEMS.md` for the evidence and `CLAUDE.md` for the current
> Decision Record entry.

Decided in this session:

**This is an Ironwright product, not an internal tool.** Built off-hours on personal
infrastructure. The originating consumer is a Copilot Studio steward agent at the author's
employer, which is a first user rather than an owner. Consequences: no employer-specific
constants in the codebase, and no employer infrastructure used for development.

**Elastic License 2.0**, replacing Apache 2.0, matching the precedent set by Axis for a
commercial single-developer Ironwright tool. Apache 2.0 would have permitted a competing
vendor to resell the reconciliation engine, which is the one genuinely novel asset here.

**Recurring-deliverable compliance is the fixed domain shape.** The engine assumes clients
times periods times deliverable types. It does not attempt a general-purpose expected-state
rule language, which is the most common way a project of this kind stalls before shipping.
Within that shape, taxonomy, filename standard, workbook mapping, and per-client cadence are
all declarative profile data. The shape covers phishing-simulation and security-training
reporting, and also vulnerability scan reports, patch reports, backup verification, and QBRs.

**Workbook layout is described by a declarative mapping authored by an introspection tool.**
A read-only `describe_workbook` reads the real workbook, detects tables and headers, and infers
column types, so a human can author the mapping from what the tool reports. Amended 2026-09-18 by
phase 4c: it proposes no candidate `columns` mapping at all and says so in its own response. The
profile's `columns` keys are the profile author's own vocabulary, tied to deliverables this tool
has never seen, so a mapping it invented would be a plausible artifact that is harder to audit
than no artifact. Requiring customers to restructure
the workbook that is their live operational authority was rejected; that artifact is the one
they are least willing to change.

**One server instance per customer tenant.** Each customer gets their own Container App,
Entra app registration, `Sites.Selected` grant, and profile set. A single instance may hold
several profiles for several libraries inside that one tenant. This keeps `Sites.Selected`
a genuine least-privilege boundary and avoids concentrating bulk rename and bulk move
credentials for multiple organizations into one instance maintained by one person. Every
customer has to register the MCP server in their own Power Platform environment regardless,
so multi-tenant hosting would have bought less than it appeared to.

**Profiles are deployment configuration, not repository content.** A profile carries real
site IDs, client names, and workbook paths. Only a synthetic example profile is committed.

**ETag preconditions on every write.** Borrowed from XMV Solutions' `mcp-server-sharepoint`,
which uses ETag-based stale-write detection on checkin. Graph enforces the precondition via
`If-Match`, which is stronger than comparing recorded field values, and it removes the need
for a confirmation-token expiry timer: a plan stays valid exactly as long as the files it
describes are untouched.

**Two independent write gates.** A deployment-level gate and a per-call confirm flag.
Copilot Studio's DLP and Advanced Connector Policy granularity is per-server rather than
per-tool, so platform governance cannot serve as either one.

**Entra OAuth on the endpoint, enforced by the hosting platform.** Decided 2026-09-12,
correcting an omission: the original safety model governed only what a tool does once
called, never who may call. Container Apps built-in authentication validates the token
before a request reaches the server, so there is no in-process validation code to get
wrong and no route can be shipped unprotected by accident. Copilot Studio's MCP wizard
speaks OAuth 2.0 directly. The protection lives in the deployment definition rather than
in application code, so it must be part of that definition and never assumed.

**A separate, long-lived grant-issuing application per tenant.** Decided 2026-09-12,
after a live run confirmed that `POST /sites/{site-id}/permissions` refuses a delegated
token even for a Global Administrator. One small bootstrap application holds
`Sites.FullControl.All` permanently and does nothing but issue per-site grants. The
server's own identity therefore never holds more than `Sites.Selected` at any moment,
including transiently. The rejected alternative was granting the server's own application
full control and stripping it afterward, which reaches the same end state but leaves a
tenant-wide credential valid for roughly an hour, because removing a role assignment does
not revoke an issued token.

## Architecture

Five layers. Each is usable and testable without the layer above it.

**`graph-lib`** carries no domain knowledge. Path-based driveItem addressing as the default
mode, with ID addressing only as a cached fallback. ETag capture and `If-Match` application.
A `$batch` builder respecting the 20-request and 4 MB caps, supporting `dependsOn`, and
auto-splitting larger batches. A delta client that persists `deltaLink`s. An Excel session
manager using a non-persistent session, and automatic recreation when an expired session
returns 404. Amended 2026-09-14: the session is non-persistent, not `persistChanges: true`,
because `persistChanges` is what makes a session write-capable and this server only reads a
document the spec calls the customer's live operational authority; a non-persistent session
gives the same speed and the same consistent view across calls and cannot commit a change,
which makes the read-only guarantee structural. The single-flight queue per workbook this
paragraph previously described is deferred, not adopted: it assumes a long-lived process
holding sessions across calls, and this server builds a fresh `McpServer` per request,
statelessly, so there is nothing to serialize. A `Retry-After`-aware backoff wrapper on
every call. A `conflictBehavior` helper. Every call goes through plain `fetch`; see
`2026-09-13-graph-repository-snapshot-design.md` for why the Graph JS SDK was declined.
Auth arrives through a token-provider interface so tests inject a fake.

> **Amended 2026-09-19. Three things in the paragraph above are not what `graph-lib` is.** The
> Excel session manager is void for the reason the Decisions banner gives, and the module was
> deleted on 2026-09-16; the workbook is read by downloading the `.xlsx` through `/content` and
> parsing the bytes in process. The `$batch` builder has never been built: it moved to phase 6 to
> arrive with its first caller, and phase 6a deferred it again and issues renames sequentially, so
> there is no `$batch` in `src/` at all. ID addressing as a cached fallback is likewise unbuilt;
> every call in the codebase is path-addressed. What the paragraph describes accurately is ETag
> capture and `If-Match` application, the delta client with persisted `deltaLink`s, the
> `Retry-After`-aware backoff, plain `fetch`, and the token-provider seam. `conflictBehavior` is
> deferred with the move tools. This note is here because a reader arriving at Architecture
> directly does not pass the banner under Decisions.

**`store`** is the state index behind a `StateStore` interface, with an Azure Table Storage
implementation for real use and an in-memory implementation for tests.

**`domain`** is pure, with no I/O and no Graph dependency, and it is the product. Profile
schema and validation, expected-state derivation, path and filename rendering, the matcher
that classifies actual files against expected artifacts, and the diff that emits structured
findings. Plain functions over plain data.

**`tools`** is the MCP layer and stays thin: validate input with Zod, call `domain` or
`graph-lib`, return `structuredContent`.

**`server`** is the stateless Streamable HTTP transport, a fresh `McpServer` per request, and
a `GET /health` endpoint kept separate from `POST /mcp` because probes are GET and MCP is POST.

The load-bearing property is that `domain` is pure. The principle that nothing writes to
production before read-only output is validated becomes true by construction, because the
entire reconciliation engine can be built and exhaustively tested before any tenant access
exists. It is also the structural opposite of the thin-wrapper pattern, where domain logic
and Graph calls are the same code.

## Profile schema

Illustrative, with synthetic values:

```jsonc
{
  "profileId": "example",
  "identity": {
    "siteUrl": "https://contoso.sharepoint.com/sites/Example",
    "library": "Compliance Reports",
    "workbookPath": "/Trackers/Operational Tracking Workbook.xlsx"
  },
  "taxonomy": {
    // Ordered path segment templates. Expresses Year > Client > Month without the
    // engine knowing those words, so a different customer taxonomy is config, not code.
    "segments": ["{year}", "{client}", "{month:02}-{monthName}"]
  },
  "naming": {
    "template": "{year}-{month:02}_{client}_{deliverable}.xlsx",
    // Recognizers identify files that are present but named wrong. `verdict` is how a
    // profile rules on near misses: an accepted alias is "compliant", a file needing a
    // rename is "misnamed". This keeps that judgment out of engine code.
    "recognizers": [
      {
        "id": "legacy-spaced",
        "pattern": "^(?<client>[A-Z0-9]+) Monthly - (?<monthName>[A-Za-z]{3,}) (?<year>\\d{4})\\.xlsx$",
        "deliverable": "MonthlyTraining",
        "verdict": "misnamed"
      },
      {
        "id": "vendor-token",
        "pattern": "^(?<year>\\d{4})-(?<month>\\d{2})_(?<client>[^_]+)_VendorTraining\\.xlsx$",
        "deliverable": "MonthlyTraining",
        "verdict": "misnamed"
      }
    ]
  },
  "deliverables": [
    {
      "id": "MonthlyTraining",
      "token": "MonthlyTraining",
      "cadence": "monthly",
      // `workbookField` names a key in workbookMapping.columns below, never a raw
      // column header, so renaming a spreadsheet column touches the mapping only.
      "appliesTo": { "workbookField": "monthlyTraining", "truthy": true }
    },
    {
      "id": "QuarterlyPhishing",
      "token": "QuarterlyPhishing",
      "cadence": "quarterly",
      // A taxonomy with a month segment still needs one month to render for a
      // non-monthly period. "last" anchors to the final month of the period, which
      // matches how a report covering a quarter is produced after it closes.
      "periodAnchor": "last",
      "appliesTo": { "workbookField": "quarterlyPhishing", "truthy": true }
    }
  ],
  "workbookMapping": {
    "source": { "kind": "table", "name": "ClientRoster" },
    "headerRow": 1,
    "columns": {
      "client": "Client",
      "monthlyTraining": "Monthly Training",
      "quarterlyPhishing": "Quarterly Phishing",
      "effectiveFrom": "Onboarded"
    }
  },
  "window": { "mode": "rolling", "months": 12, "respectEffectiveFrom": true }
}
```

## Expected state and matching

Expected state is a cross product. For each client in the workbook, for each deliverable that
client owes, for each period inside the window, derive one expected artifact carrying its
rendered path and filename.

Cadence and taxonomy interact, so period rendering is defined rather than left implicit. A
monthly deliverable renders one artifact per month. A deliverable on any longer cadence
renders one artifact per period, anchored to a single month by its `periodAnchor`, which
defaults to the last month of the period. A period is in scope when it falls inside the
window and, if `respectEffectiveFrom` is set, at or after the client's effective date, so a
client onboarded in March is not reported as delinquent for January.

Actual state is `inventory_tree` output plus a Microsoft Search cross-check. The cross-check
is not optional: a pure tree walk counts a file sitting at a client root as missing, which is
pain point two and the highest-consequence false negative in the system.

The matcher resolves every expected artifact to exactly one state:

| State | Meaning |
|---|---|
| `compliant` | Correct name in the correct location |
| `misnamed` | Correct location, name matched a recognizer with verdict `misnamed` |
| `misplaced` | Correct name, wrong location |
| `misnamed_and_misplaced` | Both |
| `missing` | No candidate file found anywhere |

Files matching no expected artifact are reported as orphans. Empty folders are reported as a
separate informational finding rather than as evidence of anything, since folder existence
does not imply report existence.

## Tool surface

Twelve tools, inside the recommended 25 to 30 ceiling for a single agent.

| Tool | Kind | Notes |
|---|---|---|
| `inventory_tree` | read | Full tree via delta; reports its own Graph call count |
| `describe_workbook` | read | No source: lists sheets and tables. One source: its header row and columns, no mapping proposed |
| `reconcile_workbook_vs_repository` | read | Centerpiece; expected versus actual, structured gap report |
| `query_repository` | read | Operational questions answered from the state index |
| `validate_structure` | read | Per-client compliance against the profile taxonomy |
| `generate_rename_plan` | plan | Produces a persisted, reviewable plan |
| `execute_rename_plan` | write | Dry run by default; `confirm: true` for a live pass |
| `generate_move_plan` | plan | Produces a persisted, reviewable plan |
| `execute_move_plan` | write | Same-library moves; cross-library is phase 6b-2 |
| `replicate_template` | write | Validates the source client internally before replicating |
| `generate_custom_plan` | plan | Steps an operator describes, resolved against the index; no workbook needed (phase 6d) |
| `execute_custom_plan` | write | Applies a custom plan through the shared executor (phase 6d) |

The `plan` kind is a third category on purpose. A plan generator performs no repository
writes, but it does persist a plan to the state store, so `readOnlyHint` is false and
`destructiveHint` is false. Calling it read-only would be the kind of decorative annotation
this project is trying not to ship. Plan generators stay registered even in a deployment with
writes disabled, since generating a reviewable plan is useful on its own.

Every tool carries a Zod input schema with real constraints and worked examples in its field
descriptions, an `outputSchema` with `structuredContent`, honest annotations
(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and a description
whose prose states its read-only, destructive, and idempotent status. The prose requirement
exists because automated MCP directory grading penalizes descriptions that omit it, and
because a measured survey of 856 tools found 97 percent had at least one description defect.
A tool name implying safety is not the same as a description stating it.

## Safety model

Six independent layers. The first decides who may call at all: Entra OAuth enforced by
Container Apps built-in authentication, before a request reaches the server. The five below
decide what a caller may then do. Copilot Studio's own governance cannot be any of them,
because its granularity is per-server rather than per-tool.

1. **Deployment gate.** An instance deployed without writes enabled does not register the
   write tools at all. Hiding the capability beats registering it and refusing, because a
   refusal leaves a model that still believes the capability exists and retries differently.
2. **Plan and execute split.** `generate_*` performs no repository writes and persists a plan
   with an ID, a content hash, and per-item before and after state including each item's ETag.
3. **Dry run default.** `execute_*` requires an explicit `confirm: true` for a live pass.
4. **ETag precondition.** Each item applies with `If-Match`. An item whose precondition Graph
   refuses fails with 412, is reported as skipped, and every other item in the same plan still
   applies. Per-item outcome reporting is the honest shape, since SharePoint offers no cross-item
   atomicity. Amended 2026-09-19 by phase 6a, which measured both halves of this: per-item
   continuation is confirmed live, and a 412 does NOT mean the item changed, because Graph
   evaluates `If-Match` before existence and answers 412 for an absent path too, so the executor
   reports only that the item at that path is not the one the plan recorded. There is also no
   batch here; renames are issued one at a time. See
   `2026-09-18-rename-write-path-design.md` for both findings.
5. **Reversal log.** Written before anything applies. A reversal log is itself a valid plan,
   so rollback runs through `execute_*_plan` like any other plan. There is no separate
   rollback code path to get wrong at the moment it is needed.

`replicate_template` runs `validate_structure` against the source client internally and
refuses when the source is non-compliant. An LLM cannot be trusted to sequence two calls in
order, so the gate belongs inside the tool rather than in guidance.

Cross-library moves return 202 with a monitor URL. The executor polls to a terminal state and
surfaces per-item status, because a naive implementation reports either false success or a
timeout mistaken for failure.

## State store

Azure Table Storage. Entities are capped at 1 MB with a 64 KB limit per string property, so
collections are stored one entity per member rather than as a single serialized blob.

| Table | Partition key | Row key | Holds |
|---|---|---|---|
| `DeltaLinks` | profileId | driveId | `deltaLink`, last scan timestamp |
| `Inventory` | profileId + driveId | driveItem id | path, name, type, size, modified, ETag |
| `Plans` | profileId | planId | kind, driveId, created timestamp, the plan's items and exclusions as JSON, and `reverses` when it is a reversal log |

**Amended 2026-09-19 by phase 6a, which built this and verified it live.** There are three tables,
not four. The `PlanItems` row above is gone: a plan's items and its plan-time exclusions are
serialized into two String properties of the one `Plans` entity, `items` and `excluded`, and
`savePlan` refuses with `PlanTooLargeError` when the two together exceed `MAX_PLAN_JSON_CHARS`,
32000, a margin under Azure Table's 32768-character limit on a single String property. The
per-member rationale at the head of this section does not apply to a plan. It exists so a
collection that grows without bound is not squeezed into one property, which is why `Inventory`
is one entity per file; a plan is generated, reviewed and executed as a single reviewed artifact,
is never partially updated, and is refused rather than truncated when it will not fit, so one
entity is the shape that matches how it is used. A reversal log is stored as a plan in this same
table with `reverses` naming the plan it reverses, per the Decision Record's own words that a
reversal log is a plan. `docs/SETUP.md` describes the shipped shape; phase 6b and 6c inherit plan
persistence from the code and from that description, not from the row this amendment replaces. The
cap has never been approached against the real service; `docs/OPEN-ITEMS.md` carries that as open.

The inventory is keyed by item id rather than by a path hash because delta cannot maintain a
path-keyed table: a deleted item arrives as an id and a `deleted` facet carrying no path at all,
and a moved item arrives under the same id with a new path, so a path-keyed table has nothing to
hash on a delete and leaves a ghost row behind on every move. Corrected 2026-09-13.

## Testing

Most tests live in `domain`, against a synthetic repository tree and a synthetic workbook,
with golden-file reconciliation outputs. No Graph, no tenant, no network.

`graph-lib` gets a fake transport. Error paths are required CI gates, not aspirations: Excel
session 404 and recreation, 429 with `Retry-After`, batch auto-split past 20 requests,
item-level failure inside an otherwise successful batch, async move polling to both success
and failure, ETag mismatch producing 412, and the documented `conflictBehavior` replace
inconsistency between folders and files verified empirically rather than trusted from docs.

**Amended 2026-09-19. Two of those gates have nothing to gate.** The Excel session was deleted on
2026-09-16 and batch auto-split was never built, so neither has code behind it and neither is a CI
gate; they return only if the capability does. Async move polling and `conflictBehavior` are
deferred with the move tools and are gates for 6b, not open holes today. What is gated now is 429
with `Retry-After`, ETag mismatch producing 412, and item-level failure inside an otherwise
successful run, which for phase 6a means a per-item failure in a sequential loop rather than inside
a batch.

Two contract tests guard the tool layer. One asserts every registered tool has an output
schema, annotations, and a description stating its safety status, and that the prose and the
annotations agree. The other fires two concurrent requests and asserts no shared state, since
the SDK requires a fresh server instance per request and cross-request contamination is silent.

Integration testing runs against the author's own M365 developer tenant with a synthetic
library and workbook. Never a mirror of real client compliance data. This also resolves the
sandbox provisioning question: synthetic fixtures in a personal dev tenant, not an anonymized
copy of production.

## Phases

1. **Foundation.** Scaffold, stateless transport with per-request server instances, separate
   `GET /health`, profile schema and validator, all ten tools stubbed with real schemas and
   annotations, both contract tests, CI including the error-path harness gate, and a scripted
   setup command that carries out both halves of `Sites.Selected` and verifies the result. Both
   halves, because the permission is two grants: the app registration requests Graph's
   `Sites.Selected` app role and gets a service principal and an admin-consenting
   `appRoleAssignment` for it, and only then does the per-site
   `POST /sites/{site-id}/permissions` grant mean anything. Verification calls Graph as the new
   app. The scripted setup exists because skipping either half produces a 403 that looks like a
   broken app registration, and because "everyone
   ships the same Azure AD walkthrough and nobody improves it" is a documented ecosystem-wide
   missed opportunity. This runs repeatedly under one-instance-per-tenant.
2. **Graph layer and store.** Split in two on 2026-09-13, because the original entry was seven
   units and contained work with no caller until phase 6. **2a:** token provider, backoff, path
   addressing, ETag capture, delta, both `StateStore` implementations, and a scripted `scan`
   command that produces a persisted `RepositorySnapshot`. **2b** split further on 2026-09-14,
   because it bundled three pieces of work with three different consumers and three different
   states of readiness. **2b-1**, the name the slice's own spec uses, is now the workbook snapshot
   alone: Excel sessions and the `WorkbookSnapshot`. **2c** is the Microsoft Search cross-check, its
   own slice with its own spec still to write. `$batch` moves to phase 6, alongside
   `conflictBehavior`, because the write tools are its first real caller: renaming two hundred files
   is two hundred requests without it and ten with it, and building it now would pin its split
   boundaries and partial-failure semantics against guesses about a consumer that does not exist.
3. **Domain engine.** Expected-state derivation, renderers, matcher, diff. Pure and
   fixture-tested. Has no dependency on phase 2 and can be built in parallel with it.
4. **Read tools**, sliced on 2026-09-14 because wiring the first tool forces an execution layer
   with no prior consumer to build against. `2026-09-14-reconcile-tool-wiring-design.md` is
   **4a**: the handler contract, the per-process `ToolContext`, the profile registry, the
   in-process single-flight scan coordinator, and `reconcile_workbook_vs_repository` wired end to
   end. `inventory_tree`, `describe_workbook`, `query_repository`, and `validate_structure`
   inherit the layer as stubs, with no retrofit. MVP checkpoint: the highest-value capability is
   usable here, before any write tool exists, and it is reached when this slice's tool is
   confirmed against real read-only data, not when the slice merges, since nothing in it has run
   against a tenant yet.
5. **Hosting.** Container Apps at min replicas 1, managed identity or Key Vault for the
   client credential, CI/CD, and Graph call volume telemetry, which is the before-and-after
   evidence for the recursive-inventory pain point that started the project.
6. **Write tools.** Plan and execute pairs, ETag preconditions, reversal log,
   `replicate_template`. Begins only after phase 4 output has been confirmed against real
   read-only data.
7. **Copilot Studio integration and governance.** MCP wizard registration for dev and test,
   DLP and Advanced Connector Policy classification, connector in its own solution for
   cross-environment portability, and Agent 365 BYO MCP graduation when governance bandwidth
   allows. Work IQ as a complementary primitive layer is re-evaluated here against current
   documentation rather than against earlier assumptions.
8. **Evaluation suite.** The questions are written already, in
   `docs/EVALUATION-QUESTIONS.md`, deliberately ahead of the engine so phase 3 builds toward
   them. Roughly ten realistic, read-only, independently verifiable questions
   requiring multi-tool reasoning against a real repository and workbook. This is the actual
   test of whether the break-the-mold goal was met.

Phase 3 running parallel to phase 2 is a deliberate departure from the build sequence in
`CLAUDE.md`, which made sandbox provisioning a phase 1 or 2 prerequisite. Keeping the engine
pure means the highest-value logic is not gated on a tenant existing. The sandbox still
matters for phase 6 write testing, where it is genuinely load-bearing.

Eight phases is more than one implementation plan should carry. Each phase gets its own plan,
written when the phase is ready to start, so that later plans can absorb what earlier phases
actually taught. The first plan covers phase 1 only.

## Out of scope

Multi-tenant hosting. A general-purpose expected-state rule language. Any dependency on a
community MCP server, including the strongest one found, which carries a directory-graded
maintenance warning. Restructuring into a multi-agent topology, which becomes relevant only
if tool count across servers approaches the recommended ceiling. Azure Functions as the host
while self-hosted remote MCP there remains in preview.

## Follow-up work this design implies

**Done. Kept as the record of what this design implied rather than as outstanding work.**

`CLAUDE.md` needed a rewrite. It referenced a Statement of Work package that has been removed,
numbered its phases against it, framed the project as employer-owned, listed open decisions this
document settles, and omitted `describe_workbook` from its tool table. All of that was corrected;
the current `CLAUDE.md` is the Decision Record this project works from.

`README.md` states the license and the Ironwright product framing.

## A practice this project learned the hard way

Nine times during phase 1 the same defect shipped past a passing suite: a message correct
read on its own and wrong read against what the program had actually done at the moment it
printed. A remedy naming an application that rollback had just deleted. A prerequisite that
stopped being true when a call moved to a different credential. Advice to consent a permission
the command had already consented. Each was individually reasonable and each survived review,
because a reviewer reads what changed and these were wrong in relation to code nobody touched.

Careful wording did not fix it. Two things did.

The first is a rule: a function that cannot observe an outcome must not assert that outcome.
`interpretVerification` is pure and runs before rollback, so it cannot claim what rollback
achieved. A builder printed while an application still exists cannot say the application is
gone. Rewording such a claim more cautiously leaves the defect in place; removing it from the
place that cannot know it is what works.

The second is a practice: when changing anything an operator reads, enumerate every message
the command can print, reconstruct each composed string from its parts, and for each one name
the path that produces it and confirm that every object it mentions still exists at that
moment and every action it suggests is possible with the credential the operator holds then.
Two of the last three instances were found by that enumeration rather than by review. It is
cheap, it is mechanical, and it finds the ones review structurally misses.

Tests help less here than they should. A substring assertion passes on a message that has
become false, and pinning a string in isolation says nothing about whether it agrees with the
message printed four lines above it.

## Watch items

Phase 1's reviews left open questions and carried-forward risks that later phases must read.
They are recorded in `docs/OPEN-ITEMS.md`. Three of them require a decision before
phase 2 begins: whether the per-site grant accepts a delegated token, which delegated scopes
the setup sign-in must request, and how the MCP endpoint authenticates callers.


If Microsoft ships first-party reconciliation or batch tree inventory in Work IQ, the correct
response is to shrink this server's surface to the reconciliation delta rather than compete on
primitives.

Work IQ's architecture is roughly ten generic verb tools over resource paths with runtime
schema discovery. That is a coherent alternative philosophy to outcome-shaped composite tools,
and it is recorded here as considered and declined rather than unexamined. Outcome-shaped
tools are what the ecosystem criticism and Anthropic's own guidance to group tools around
intent actually recommend.

Preview-status dependencies, currently Agent 365 BYO MCP and the Work IQ MCP tool layer,
should be reconfirmed against Microsoft documentation immediately before the phase that needs
them rather than trusted from research dated earlier.
