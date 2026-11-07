# Domain platform and the assessment domain

Design spec. Written 2026-11-06 and settled in a design dialogue with the operator the same day.
Status: pre-probe. No implementation plan may be written until every row of the Assumptions table
carries evidence, per the Working Agreement in `CLAUDE.md`. Three Decision Record entries were
amended by the decisions recorded here, in the same commit as this spec.

## Purpose

Turn Ironwright MCP from a server with one domain into a core platform that hosts several, and add
the first new one: a governed assessment workspace, whose first consumer is a vendor risk agent in
Copilot Studio (VRA_V2 at the operator's employer, referred to below as the consumer). The existing
repository reconciliation domain is kept whole and becomes the first module of the platform rather
than being discarded or diluted.

The business driver is the consumer's persistence layer. It reasons well and persists badly. Its
SharePoint writes go through Microsoft's generic SharePoint MCP server, which exposes low level
operations such as create folder, upload file and create list item, each needing caller supplied
ids and paths. Observed failures, all from the consumer's own record:

- a research dossier created before an Assessment ID existed, carrying the placeholder
  `AssessmentID-TBD`;
- dossiers written to the document library root, and to a knowledge folder the workspace contract
  explicitly says is not a workspace;
- the orchestrator choosing SharePoint paths itself;
- a persistence call that stayed in the executing state for tens of minutes;
- persistence and the Evidence Auditor running out of the order the operating model mandates;
- the agent asking permission between mandatory stages despite instructions not to;
- a generic mutation surface with far more authority than the workflow needs.

The conclusion is not that MCP is the wrong mechanism. It is that generic Graph operations are the
wrong abstraction for this consumer. It needs domain level composite tools whose implementation
enforces its storage and lifecycle contract, which is the thesis this project already stands on: the
assistant calls tools, it does not improvise Graph operations.

A second consumer shaped the core even though its domain is not built here. The operator has just
migrated a CPA firm's document management export into SharePoint, one site per client across more
than two thousand client sites, each following a fixed folder template with files tagged by class,
subclass and year. The migration left residue nobody owns in steady state: thousands of files at
library roots, clients incomplete or not migrated, and recurring per client per year deliverables
that are exactly the recurring deliverable shape the compliance domain already models. That domain
is the phase after this one. What it needs from the core now is that a profile can address a set of
sites rather than one, which is a schema shape and cheap to settle before any second domain exists.

## Decisions amended on 2026-11-06

Each of these touched the Decision Record and was settled by the operator in the design dialogue.
The amended entries in `CLAUDE.md` carry the date; this section carries the reasoning.

**Product shape.** Recurring deliverable compliance stays the centerpiece and is no longer the only
domain. The product is a core platform of Graph access, state, scan coordination, transport and
inbound authentication, hosting domain modules, each with its own profile kind and tools. The first
three modules are compliance, library and assessment. Breadth beyond the fixed domain had been held
back in the Copilot Studio integration spec pending a design against the Decision Record; this is
that design.

**Hosting.** The product is self hosted in the customer's tenant, with the container image as the
unit of deployment and ingress the customer's choice. The server needs TLS termination in front of
it and nothing else, because inbound authentication becomes the server's own job. Three ingress
paths are documented: Microsoft dev tunnels as the quick start with no infrastructure, Cloudflare
Tunnel as the durable no Azure path, and Azure Container Apps as the reference cloud deployment,
demoted from the only answer to one of three. The reason is a hard constraint, no Azure spend and no
pay as you go of any kind, and the shape it forces turns out to be the better product: one server
per customer tenant, an app registration and a `Sites.Selected` grant created in the customer's
tenant by the setup script, profiles as uncommitted deployment configuration, and a license that
already forbids running it as a service for others. The only thing that ever lived on Ironwright's
side was the hosting. Phase 5b becomes the documentation of the Container Apps path rather than a
held phase. A hostname under the operator's own domain fronts only what the operator runs:
the probe server, the development tenant server and demos. A customer endpoint never sits behind
it, because that would put the customer's content on Ironwright's infrastructure and undo the
posture.

**Write tool design.** Every mutating tool over content the server did not create stays plan then
execute, dry run by default, with an explicit confirm. A lifecycle tool, a fourth tool kind defined
in this spec, is gated by state preconditions instead of a dry run: it refuses unless the prior
stage is verified live, it creates records and files only at paths the server computes, it
overwrites only a file it created and only under an ETag precondition, and it records every write
in a journal. One call per stage, no confirm flag. The reason is a collision between two rules that
are each right: the project's hard default of dry run, and the consumer's operating model, which
says never ask permission between defined workflow stages. A confirm flag is exactly the moment at
which generative orchestration has been observed stopping to ask the user. The human review point
the dry run protected exists elsewhere in this workflow, at the Evidence Auditor and at the
published document, and the preconditions carry the invariants the consumer actually needs, which
are ordering and placement rather than a human reading a plan.

## Constraints

- **No Azure spend and no pay as you go**, in any tenant, at any step. Every live step runs on the
  Ironwright developer tenant. The employer tenant is never used for development, and a pilot there
  is a separately permissioned step the operator runs by hand, which this spec does not design.
- **No customer constants in the code.** Every name a customer would recognize as theirs, including
  the consumer's library, workspace root, list names, artifact names and ID convention, lives in an
  uncommitted profile. The schema's worked examples use invented names.
- **Adaptability is a design rule, not a feature.** The code holds invariants: uniqueness, ordering,
  verification, placement under server computed paths. The profile holds conventions. When a choice
  arises between a fixed behavior and a profile field with a sensible default, the field wins.
- **The weekend of 2026-11-07 and 2026-11-08** is the build window for the core and the assessment
  module, with the Copilot Studio contact the item that slips if something must.

## Design

### Core and domain modules

The core is what exists today minus the compliance specific wiring: the Graph layer, the state
store, the scan coordinator, the MCP transport and per request server, the tool registry, the
profile registry, the token role guard, and the inbound authentication this spec adds.

A domain module is one object:

```
interface DomainModule<P> {
  kind: string;                      // "compliance" | "library" | "assessment"
  profileSchema: ZodType<P>;         // the kind specific part of a profile
  tools: ToolDefinition[];           // every tool this module registers
}
```

Modules live under `src/modules/<kind>/`, which holds the module object, the tool definitions and
the handlers. The pure domain code stays under `src/domain/`, where the existing lint rule already
enforces that it imports zod and its own siblings and nothing else; the assessment domain's pure
code goes to `src/domain/assessment/`. Nothing in the lint configuration changes. Compliance and
library become modules by moving their tool definitions and handlers under `src/modules/`, not by
rewriting them, and a registry test proves the moved tools produce byte for byte the same results
on the same fixtures as before the move.

The profile registry reads the `kind` field first, picks the module that owns it, and validates the
remainder with that module's schema. An unknown kind fails at startup naming the kinds that exist.
An absent kind means compliance, so every profile written before kinds existed loads unchanged. The
tool list the server registers is the union of every module's tools, filtered by the existing write
gate, and the existing profile kinds test keeps requiring every tool to declare which kinds it
accepts. A handler receives its profile already typed to the kind it declared.

### Site sets

Every profile shares one base: `profileId`, `kind`, and `sites`, a non empty list of site entries.
A site entry carries `siteUrl`, `library`, an optional `searchRegion` and an optional `clientId`,
the last for the case where the client is the site rather than a folder segment. The existing
`identity` block becomes a site list of one, and the loader accepts the old shape by rewriting it
into a one entry list so existing profiles keep loading.

The startup grant check becomes a check over every listed site. The scan coordinator, the delta
links and the inventory are already keyed by profile and drive, so a profile with many sites scans
many drives with no change to that model. The compliance and library modules keep working over a
one entry list this phase; walking a multi site set from a tool is the firm's domain and is out of
scope here. The Microsoft Search cross check is unchanged: `Sites.Selected` trims results to granted
sites, and a profile with many granted sites simply sees more.

The grant model stays `Sites.Selected`, and the token role guard keeps refusing anything broader.
The grant issuer gains a loop over a sites file so two thousand per site grants is a scripted
morning rather than an argument for a tenant wide permission. That loop is built with the firm's
domain, not here; it is recorded so the site set schema is understood as its first half.

### Graph additions

Four operations, path addressed, each returning the item it produced so the next step has the id
and ETag without a second read. Every one is new to this project and is a probe before it is a plan
task.

- **Create folder** under a parent path, sending `conflictBehavior: fail`. A folder already present
  answers 409 `nameAlreadyExists`; the caller reads it and reports it satisfied, because the
  workspace tree is additive and a retry must not fail on its own earlier success.
- **Create file** at a path by the small file content PUT with `conflictBehavior: fail`, so an
  occupied name answers 409 and nothing is replaced. Capped at the 4 MB small upload limit, refused
  above it with a plain message. The upload session API waits for a caller that needs it.
- **Overwrite file** by the same PUT under `If-Match`. The project has measured Graph evaluating
  `If-Match` before existence on PATCH; the probe confirms the same on PUT and that the response
  carries the new ETag.
- **List items** under the site, by list name: read one by id, query by a field filter, create with
  a fields object, update fields by id. Whether `Sites.Selected` reaches list items at all is the
  first probe. This project has only ever proven that grant on drive items. If the answer is no,
  the design is amended before any plan exists; the state lists are the consumer's system of record
  and there is no version of the module that pretends otherwise.

Read back reuses the existing content download. Every write a lifecycle tool makes is followed by
a read of what it wrote, which is the consumer's own rule and the only way a tool can report
"persisted" without asserting what it did not observe.

### The journal

The store gains one thing: a per assessment journal, appended by every lifecycle write and read by
the status tool. An entry records the stage, the operation, the target as the server computed it,
the ETag before and after, a content hash, the time and the correlation id.

The journal is the audit record and the reversal record for what is reversible. A created folder or
file names its own delete; an overwrite names the prior ETag and hash and the SharePoint version
that held the prior content. Rollback of lifecycle writes is not built in this phase. A delete is
the one Graph operation this server has never issued, and it should not first be issued inside a
rollback; phase 6c held folder creation for the same reason. The spec says so and so does the
status table.

Nothing authoritative about an assessment lives in the store. State is read from the lists and the
drive on every call. A wiped store loses journal history and nothing else.

### Lifecycle tools, the fourth kind

`ToolKind` gains `lifecycle`. Its fixed safety sentence, asserted by the contract test over the
whole registry:

> Not read-only: this tool advances an assessment by one stage when its preconditions hold. It
> creates records and files only at paths the server computes, overwrites only files it created
> and only under an ETag precondition, refuses when the prior stage is not verified, and records
> every write in the assessment journal. It needs no confirm flag and is safe to retry: a stage
> already completed is reported, not repeated.

Annotations: not read only, not destructive, idempotent, open world.

Preconditions are read live from the lists and the drive on every call, never from the store and
never from what the caller says happened. The caller supplies an Assessment ID and content; the
server resolves every path, list and column from the profile. A precondition failure is a structured
refusal naming the stage expected, the stage observed and what was read to decide, so the agent and
the operator see the same evidence. It returns `isError` with that evidence as prose and as
structured content, which the SDK's error path already permits.

The retry rule has one hard case, opening an assessment, and the operating model answers it: reuse
the vendor and create one assessment. Open returns an existing in progress assessment for the same
vendor and scope instead of creating a second one. That is what makes a retried open safe and what
removes the duplicate ID failure at its source.

### The assessment module

Kind `assessment`. Named generically because nothing in it is vendor risk specific once the
conventions move into the profile.

**Profile.** One site entry. A `workspace` block: the root path template, for example
`Assessments/{vendorFolder}/{assessmentId}`, the subfolders to create under it, and `artifacts`, a
map of named artifact kinds to path templates relative to the root, for example `dossier` to
`Research/{vendor}_Research_Dossier.md` and `publication` to
`{vendorFolder}_{assessmentId}_Risk_Assessment.docx`. An `assessmentId` block with the template
described below. A `lists` block naming the vendor, assessment and finding lists, each with a
column map from the module's logical fields to the list's internal column names, the way the
workbook mapping maps logical fields to column headers. A `lifecycle` block with the labels the
lists use for status, state and disposition values. Placeholders are the ones the templates name;
an unknown placeholder is a validation error, as it is today for taxonomy segments.

**Tools.** Seven: five lifecycle, two read.

| Tool | Kind | Stage | What it does |
|---|---|---|---|
| `open_assessment` | lifecycle | ID | Finds or creates the vendor record. Returns an existing in progress assessment for the same vendor and scope if one exists. Otherwise creates the assessment item, renders the ID from the item id, writes it back, reads it back, creates the workspace root and subfolders, reads them back. Returns the ID, workspace path and vendor folder name. |
| `save_assessment_artifact` | lifecycle | DOSSIER, CORRECTION, EXECUTIVE SUMMARY | Requires the assessment in progress and the workspace present. Creates the file at the profile's path for the artifact kind, or overwrites it under the ETag it just read, then reads it back. Returns path, byte count, hash and version. |
| `read_assessment_artifact` | read | AUDIT | Returns the persisted contents and hash, which is what the Evidence Auditor must receive. Separate from save so a save does not echo a whole dossier through the agent's context. |
| `record_findings` | lifecycle | FINDINGS | Creates one finding item per finding, keyed so a retry updates rather than duplicates, and updates the assessment summary. |
| `transition_assessment` | lifecycle | DECISION, LIFECYCLE | Target of completed or provisional with disposition and risk. Completed requires the dossier present and the publication verified; provisional requires the dossier. Reads live, then updates the item. |
| `verify_publication` | read | VERIFY | Checks the publication exists at the canonical path with the expected name and returns its metadata. |
| `get_assessment` | read | any | Status, which artifacts are present, and the journal summary. Lookup by ID or by vendor. |

Things deliberately outside the module. The AssessmentPayload stays an input to the consumer's
publisher flow, which keeps creating its folders and writing the document exactly as it does
today; this server only verifies the result. The Evidence Auditor is unchanged. Scope resolution
and research are the agent's reasoning and touch no tool here.

**Agent side change**, recorded here and done by hand in Copilot Studio by the operator. The agent
drops the generic SharePoint tool and keeps the Evidence Auditor, the publisher, web research and
its knowledge. Its instructions map each stage of the operating model to one tool above: ID to
open, DOSSIER and CORRECTION to save, AUDIT to read followed by the Auditor, FINDINGS to record,
VERIFY to verify, EXECUTIVE SUMMARY to save, LIFECYCLE to transition. Since the server refuses
every out of order call with the stage it observed, the instructions no longer carry the burden of
ordering alone.

### The Assessment ID

The consumer's record shows no canonical ID format and no minting algorithm, and the placeholder
failure follows directly from that. The server owns the ID.

The ID stage creates the assessment list item first. SharePoint's integer item id is the
uniqueness anchor: unique for the life of the list, never reused, and not something the agent can
invent. The visible ID is rendered from a profile template that may use the item id, a date and a
prefix, for example `{prefix}-{yyyy}-{item:5}` giving `ASM-2026-00042`, written back into the item
and read back before a single folder exists. The workspace folder is named from the rendered ID, so
the ID exists in the list before anything on disk refers to it, which is the exact ordering the
placeholder failure violated.

Rejected: a server held counter, which adds a second source of truth that can drift from the list;
and vendor plus date derivation, which is what the legacy IDs did and what collides. A customer
convention that needs a date scoped sequence can be rendered by the template with the item id
present somewhere in it, and the schema's documentation says what is lost when it is not.

### Inbound authentication

A shared key checked on every request to the MCP endpoint with a constant time compare, carried
either in a header whose name is configurable with `x-api-key` as the default, or as a bearer
token, so whichever mode Copilot Studio's add tool dialog offers is covered. The key comes from the
environment. The server refuses to start without one; a loopback only override exists for local
development and is logged at startup when used. The health endpoint stays open because it reads
nothing and calls nothing. The key never appears in logs, in the call trace, or in an error
message. This is the probe server's check lifted into the core with its tests, and the probe
server then uses the core's implementation rather than its own copy.

Rotation is a restart with a new key. Two concurrent keys were considered and left out until a
deployment needs zero downtime rotation.

### Ingress

The server knows nothing about what fronts it. Three documented paths, in `docs/SETUP.md`:

- **Dev tunnels**, the customer quick start. No infrastructure, no domain, a Microsoft account the
  customer already has. Documented limits: one machine that has to stay up, Microsoft positions dev
  tunnels as development tooling, a tenant administrator can disable them by policy, and there is a
  monthly bandwidth allowance.
- **Cloudflare Tunnel** on a domain the customer owns, the durable no Azure path. This is also what
  the operator runs on their own domain for the probe server and the development tenant server. The
  edge cuts a request after about 100 seconds on the free plan. A lifecycle tool answers in seconds.
  A long first scan may not, and what happens then is an assumption with its own test below before
  the documentation claims it.
- **Container Apps**, the reference cloud deployment, for a customer who already pays for Azure.

A WAF rule allowing only Power Platform's published egress ranges is documented as optional
hardening that needs nothing from the Copilot side. Cloudflare Access service tokens need two
custom headers that Copilot Studio may be unable to send; whether it can is added to probe A3 and
Access is documented as optional until it is known.

## Testing

The domain layer stays pure. Path and ID template rendering, stage precondition evaluation over a
read state object, and journal entry construction are fixture tested, with the fixtures of list
item and drive item shapes taken from the probe recordings rather than written by hand. That is the
lesson that became the assumption gate, applied before the first fixture exists.

The Graph operations get fake server tests for the success, 409 and 412 cases, with the fake's
responses copied from the recordings. Tool handlers run against the in memory store and the fake
Graph, one test per precondition refusal and one per retry. The contract test gains the lifecycle
kind and its sentence. The profile kinds test gains the assessment kind. A registry test proves the
tool list is the union of the modules and that compliance and library tools answer byte for byte as
they did before the move.

One live sitting on the Ironwright developer tenant: a seeded workspace site and three lists, the
whole lifecycle end to end, each lifecycle tool called twice to prove the retry rule, the journal
read back, a publication placed by hand and verified, a transition refused for a missing
publication and then accepted. Then the Copilot Studio trial agent calling through the tunnel,
probe server first and the real server second, with the call trace as the evidence.

## Assumptions

Rows L and F were measured on 2026-11-07 by the probe under `scripts/assessment-probe/`, run against
the Ironwright developer tenant under a token the runner verified to carry exactly `Sites.Selected`.
The redacted recording and report are in `evidence/2026-11-07-assessment-probe/` beside this spec,
and the findings that changed the design are in the 2026-11-07 amendment at the end. Rows A and B
are in `docs/COPILOT-STUDIO-PROBE.md` and remain unverified. A row with no evidence blocks the
implementation plan that depends on it.

| Assumption | Why the design needs it | Probe | Evidence |
|---|---|---|---|
| `Sites.Selected` reaches list items under the site for read, create and update | The state lists are the consumer's system of record | L1 | Confirmed 2026-11-07: read 200, create 201, fields update 200 (L1, L2a, L2b). Under the `read` role the create answered 403 `accessDenied` |
| List item create returns the item with its integer id; a fields PATCH returns the updated fields | ID minting and every status update | L2 | Confirmed 2026-11-07: the body's `id` is the integer rendered as a string, `"2"`; the fields PATCH returned the whole fields object with the new value, and a single item read it back (L2a, L2b, L1b) |
| A list query filtered on a field works on this grant, with or without the non indexed query header | Open by vendor and scope, lookup by ID | L3 | Amended 2026-11-07: without the header, 400 `invalidRequest` naming the column as not indexed; with `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly`, 200 with the one item (L3a, L3b) |
| Folder create by path with `conflictBehavior: fail` returns the item with an ETag and answers 409 on an existing folder | Additive workspace creation and the retry rule | F1 | Confirmed 2026-11-07: 201 with `eTag` in the body, 409 `nameAlreadyExists` on the repeat (F0, F1a, F1b) |
| A small content PUT with `conflictBehavior: fail` refuses an occupied name with 409 | Create file never replaces | F2 | Confirmed 2026-11-07: 201 with `eTag` in the body, 409 `nameAlreadyExists` on the occupied name, and the content read back unchanged (F2a, F2b, F4) |
| The same PUT under `If-Match` answers 412 on a stale ETag and returns the new ETag on success | Overwrite only under a precondition | F3 | Confirmed for the stale and current cases, 200 with a new `eTag` and 412 (F3a, F3b). Amended 2026-11-07 for the absent case: a PUT under `If-Match` to a path holding nothing created the file and answered 201 (F3c) |
| Copilot Studio's add tool dialog accepts a key header or a bearer token | Which inbound mode is wired | A3 | Unverified |
| Copilot Studio accepts a Cloudflare hostname as the server URL | The operator's own ingress | B1 | Unverified |
| A scan in flight survives its client disconnecting at the edge | What the ingress docs may claim about long scans | Test in the suite | Not part of the 9a probe |
| The existing compliance and library tools answer identically after the move to modules | The platform refactor changes nothing it did not mean to | Registry test | Not part of the 9a probe |

## Order of work

Four implementation plans, in this order, each its own branch and PR:

1. **Probes and the grant.** Grant issuer stood back up, the development tenant seeded with a
   workspace site and three lists, probes L1 to F3 run and recorded, this spec amended with their
   evidence. Saturday morning.
2. **Core.** Modules and the registry, the site set profile base, inbound authentication, the
   lifecycle kind in the contract test, the four Graph operations, the journal. Saturday.
3. **Assessment module.** The profile schema, the seven tools, the live sitting. Sunday.
4. **Ingress and contact.** Tunnel on the operator's domain, probe server contact with the Copilot
   Studio trial, then the real server. Sunday, and the item that slips to the following week if
   anything must, because the consumer's pilot needs the module and the contact needs only the
   server to exist.

## Out of scope, each recorded in `docs/OPEN-ITEMS.md`

- Rollback of lifecycle writes, held with its reason above.
- Uploads above 4 MB, which need the upload session API and have no caller.
- Any delete.
- The firm's domain: multi site scanning and queries, the grant issuer loop over a sites file, the
  folder template as a taxonomy, and the recurring deliverable profile for a CPA practice.
- Provisioning the state lists from the profile. This phase maps existing lists; a setup command
  that creates them is the obvious next cut and is not designed here.
- Any pilot in the employer tenant, which is the employer's governance call and the operator's
  by hand step.
- Cross library moves, `$batch` and `replicate_template`, which proceed on their own tracks.

## Documents this branch updates

- `CLAUDE.md`: the three amended Decision Record entries, the tool set table, the build sequence
  gaining this phase.
- `docs/OPEN-ITEMS.md`: the status table rows for the four plans above and the held items.
- `docs/SETUP.md`: the inbound key and the three ingress paths, once built.
- `docs/COPILOT-STUDIO-PROBE.md`: A3 gains the Access header question, B1 the Cloudflare hostname.

## Amendments, 2026-11-06, during plan 9b

Module objects reference the tool definitions in place under `src/tools/definitions/`, where the
design said the definitions would move under `src/modules/`. The physical move is deferred. It is
a rename-only commit when it happens, so nothing about behavior waits on it.

`ProfileSchema` is wrapped in `z.preprocess` with the site normalization, so direct callers of the
schema, such as scripts and fixtures, accept the legacy `identity` shape as well as `sites`. The
parsed `Profile` type carries `sites`, with `identity` kept as the first entry.

A journal row key carries a random suffix, so two entries with the same instant and correlation id
are both kept. Append never replaces. A retried append after an ambiguous failure therefore writes
a duplicate row, which means a lifecycle tool journals after its write is confirmed, not before.

The Azure table is named `Journal`, matching the capitalization of the other three.

The four Graph operations named under plan 9b in "Order of work" were moved to plan 9c, where their first caller lives and after plan 9a's evidence exists. `docs/OPEN-ITEMS.md` already titles the rows that way.

## Amendments, 2026-11-07, from plan 9a's probe run

The probe ran against the Ironwright developer tenant on 2026-11-07, under a token the runner
verified to carry exactly `Sites.Selected`, with the server application's grant widened to `write`
for the run. Fifteen of seventeen steps answered as the Assumptions table assumed. Two did not, and
three things the table never asked about were measured on the way. The evidence is
`evidence/2026-11-07-assessment-probe/recordings.jsonl` and the report beside it.

**`If-Match` on a content PUT does not guard against an absent target.** A PUT to a path holding
nothing, sent with a valid `If-Match` taken from another file, created the file and answered 201
(F3c). The project's earlier measurement that Graph evaluates `If-Match` before existence was made
on a driveItem PATCH, where an absent path answers 412, and it does not carry to the small content
PUT. The "overwrite file" operation changes accordingly: an ETag precondition proves that a file
which exists is unchanged, and proves nothing when the file is gone. A lifecycle tool that
overwrites a file it created reads the item first and refuses when it is absent, rather than
relying on the precondition to refuse for it, because otherwise a file an operator had moved or
removed would be recreated at its old path without anyone asking for it. The stale case holds as
assumed: a wrong ETag answers 412, and its error code is `notAllowed` with the message "ETag does
not match current item's value", not the `resourceModified` the PATCH case answers, so the
operation matches on the 412 status and never on the code.

**A filtered list query needs the non-indexed header or an indexed column.**
`$filter=fields/AssessmentId eq '...'` on a plain text column answered 400 `invalidRequest`, with a
message naming the column as not indexed and naming `Prefer:
HonorNonIndexedQueriesWarningMayFailRandomly` as the way to allow it; the same query with that
header answered 200 with the one matching item (L3a, L3b). The module sends that header on every
filtered list query. The header's own name carries the caveat: SharePoint may refuse such a query
once a list passes its view threshold, so the setup documentation tells the operator to index the
columns the module filters on in the consumer's lists, and a 400 on a filtered
query surfaces as the Graph error, whose own message names the column as not indexed and names the
header, rather than something to retry (corrected 2026-11-07 during plan 9c: the code passes
Graph's own error through unwrapped).

**The default library's drive is named `Documents`.** Its URL segment is `Shared Documents`, and
the probe's first run matched no drive by that name and stopped before the drive steps. The server
resolves a library by the drive's `name` as Graph lists it, which is the display name shown as the
library's heading, so a profile names the library that way and never by its URL segment. That was
already how the compliance profiles behaved. It is recorded because it cost a run.

**ETags come back in the body, not the header.** Every create and overwrite answered with `eTag`
in the response body, and the content PUTs carried no `ETag` response header at all (F2a, F3a,
F3c). The four Graph operations read the ETag from the body. The two 409 bodies differ in wording,
"Name already exists" for a folder and "The specified item name already exists." for a file, under
the same `nameAlreadyExists` code, so callers match the code.

**The grant widens and narrows without a propagation window.** A list item create under the `read`
role answered 403 `accessDenied` with nothing more specific; the same request seconds after the
role was patched to `write` answered 201, and an earlier run had seen the reverse. `npm run
probe:assessment:grant` is the command for both directions.

## Amendments, 2026-11-07, during plan 9c

**The profile's lifecycle block.** The `lifecycle` block is `status` with three labels
(`inProgress`, `completed`, `provisional`), a list of dispositions and a list of risks. The
assessments list's state column is written by the server with the last stage it completed and is
reported by `get_assessment`. It is never the sole input to a precondition, which always reads the
artifacts and items directly.

**The publication is never written here.** `save_assessment_artifact` refuses the `publication`
kind. The consumer's own publisher writes it and this server only verifies it.

**The journal's `versionId` stays unset.** Reading a SharePoint version id needs a `/versions`
call this project has never made, and the assumption gate forbids planning against it. The journal
carries `priorContentHash` instead, from a download of the prior bytes through the content path
verified live since phase 2b-2.

**Assessment profiles are accepted where library profiles are.** `inventory_tree`,
`query_repository`, `generate_custom_plan` and `execute_custom_plan` also accept an assessment
profile, since both carry a site and a library and nothing else those tools read. Tools that need a
compliance profile refuse an assessment profile through `profiles.get`, the same gate that refuses
a library profile.

**The vendor folder name.** The server computes it from the vendor name by removing the characters
SharePoint forbids in a name (`" * : < > ? / \ |`), collapsing whitespace and trimming. Once a
vendor record exists, its stored folder name wins over recomputation, and `get_assessment` by
vendor looks the vendor record up first and filters on that stored name, as open does, falling
back to the sanitized name when no record exists.

**The journal stage for a save** is the artifact kind upper cased (`dossier` becomes `DOSSIER`,
`executive_summary` becomes `EXECUTIVE_SUMMARY`), except that an overwrite of the dossier is
`CORRECTION`.

**The OData filter encoding.** The filter is built as `fields/{column} eq '{value}'` with single
quotes doubled inside the value and the whole expression passed through `encodeURIComponent`. The
9a probe sent the expression raw. The encoded form is the HTTP layer's representation of the same
query, and the first live filtered query of the 9c sitting checks it.

**Open reports three outcomes.** `open_assessment` reports created, resumed or already open, and
its text names what the call wrote. On a retry it reads the root and every subfolder live and runs
the folder pass when any is absent, because the root is created first and a present root alone
cannot show a finished workspace.

**Journal keys before an id exists.** Entries written before an assessment id exists are keyed
`(vendor)` and `(unassigned)`.

**When a journal entry is appended.** An entry is appended once Graph's 2xx response confirms the
write. The read back that follows is a second check; its mismatch is reported in the result and
does not remove the entry.

**An unchanged save.** A save whose content hashes equal to what is already stored writes nothing
and reports `unchanged`. It still sets the assessment's State column when that column differs from
the stage, so a State update that failed after a write landed is repaired by the retry. The
consequence is accepted: an identical re-save, or a findings retry, after a later stage moves State
back to that stage. State is informational and no precondition reads it, and a stage order that
would prevent the rewind is not defined in this phase.

**The client's mutating verbs.** `putBytes` is the client's second mutating verb beside `patch`
and the third that can change the tenant beside `post`.

**The site and drive are resolved on every call.** The module reads the site and the drive on each
call, two reads, rather than caching a drive id, because nothing in the server caches a drive id
across calls today and a stale one would be the ID navigation failure the project exists to avoid.
