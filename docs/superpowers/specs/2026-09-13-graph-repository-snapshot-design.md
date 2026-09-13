# Design: the Graph layer and the repository snapshot

Date: 2026-09-13
Status: Approved (design only)
Extends: `2026-09-11-repository-reconciliation-mcp-design.md`, which settles the architecture,
the Graph-access priorities, and the state store. This addendum settles what that spec's phase 2
left open or got wrong: how phase 2 is sliced, which HTTP client the Graph layer uses, how the
delta client and the inventory table fit together, and how any of it is verified against a live
tenant while every tool is still a stub.

Companion to `2026-09-13-reconciliation-engine-design.md`, which settles the shape of the data
this layer must produce. That engine is finished and waiting for its inputs; this is the first
half of supplying them.

## Scope: phase 2a

The parent spec's phase 2 is seven units. It is more than one implementation plan should carry,
and it contains work with no caller until phase 6. This slice is the first half.

**Phase 2a delivers one thing: a real `RepositorySnapshot` for a configured profile, produced
from a live SharePoint document library, persisted so that the second run is incremental.**

In scope: the token provider, the `Retry-After`-aware backoff, path addressing in both
directions, ETag capture, the delta client, the `StateStore` interface with both implementations,
the snapshot assembler, and a scripted `scan` command.

Deferred to phase 2b: the `$batch` builder, the Microsoft Search cross-check, the Excel session
manager, and the `WorkbookSnapshot`.

Deferred to phase 6: the `conflictBehavior` helper, which nothing reads until a write tool exists.

A consequence that has to be stated rather than discovered. Every snapshot this slice produces
carries `searchCrossCheckIncluded: false`, so any reconciliation run against it is a degraded
scan by the engine's own definition: a correctly named file sitting outside the expected taxonomy
is invisible to it. The field exists for exactly this and the report already says so. Nobody
should read a 2a-era report as complete.

## Decision: plain `fetch`, not the Graph JS SDK

The parent spec's Decision Record names the Microsoft Graph JS SDK. That lock was written before
any code existed, and phase 1 went the other way without recording it: `src/setup/adapter.ts`
talks to Graph with `fetch` and a typed `GraphRequestError`. This amends the Decision Record to
match, deliberately rather than by drift.

The SDK's value is mostly its middleware: retry, redirect handling, and a batch helper. Those are
three of the behaviors this phase exists to build deliberately, with the `Retry-After` semantics
and the 20-request auto-split as tested units rather than as inherited defaults. Its batch helper
in particular is awkward about response ordering and per-item failure, which is precisely the
error path the parent spec names as a required CI gate. A dependency that hides the thing under
test is a poor trade for typed models.

Consequences: one HTTP path across setup and the Graph layer, no large runtime dependency, and
the obligation to get throttling right ourselves, which the error-path gates below discharge.

`@azure/identity` stays a devDependency of the setup command. The server's own token provider
calls the token endpoint with `fetch` like everything else.

## Architecture

Three new module groups and one entry point. The domain layer must import none of them. That was
not yet true of the purity lint rule when this was written; it was extended on 2026-09-13 to
deny `**/graph/**`, `**/store/**`, `**/scan/**` and `**/config.js` to the domain layer alongside
the transport, tool and setup layers it already covered.

**`src/graph/`** carries no domain knowledge.

- `token.ts`. A `TokenProvider` interface with one method, and a client-credentials
  implementation that caches the token by its expiry with a skew margin. Tests inject a fake, so
  nothing below this line needs credentials to be testable.
- `retry.ts`. The backoff policy: bounded attempts, `Retry-After` honored in both its
  delta-seconds and HTTP-date forms, and `sleep` injected so the tests do not wait.
- `client.ts`. A `GraphClient` over `fetch` that attaches the bearer token, wraps every call in
  the backoff, and throws the typed `GraphRequestError`. That error type moves out of `src/setup/`
  into a shared home, because it stops being a setup concern the moment a second caller exists.
- `paths.ts`. Path addressing in both directions: building `/drives/{driveId}/root:/{path}:` with
  correct encoding, and turning a `parentReference.path` back into a library-relative path with no
  leading slash. This is the module most likely to be subtly wrong, and it gets the densest unit
  tests in the slice.
- `drive.ts`. Site URL to site id to the named document library's drive id.
- `delta.ts`. Paging through `/drives/{driveId}/root/delta` or a stored `deltaLink`, following
  `@odata.nextLink`, and returning the changes together with the new link.

**`src/store/`** is the state index behind the `StateStore` interface, with an in-memory
implementation for tests and local runs and an `@azure/data-tables` implementation for real use.
This slice needs only the delta link and the inventory. Plans and plan items arrive in phase 6.

**`src/scan/`** is the composition root and the only place Graph knowledge meets domain types. It
imports `RepositorySnapshot` from `domain/reconcile/index.js`, which the entry-point lint rule
permits, and the purity rule keeps that arrow pointing one way.

**`src/scan/main.ts`** is the scripted `scan` command described below.

## Configuration

One server instance per customer tenant, so there is one set of credentials rather than a set per
profile. The tenant id, the client id and the client secret arrive as environment variables, read
by a shared config module that follows `src/server/config.ts`'s established style: refuse a
malformed value by name rather than start with a wrong one. The storage account arrives the same
way, and its absence selects the in-memory store rather than failing, so a local run needs no
cloud account at all.

Nothing in this slice reads a secret from disk or from a profile. Profiles are deployment
configuration describing a repository, not a place credentials live, and the hosting phase
replaces the environment variable with a managed identity or a Key Vault reference without
touching anything below the config module.

## The scan

Load the profile JSON from disk and validate it through the existing pure `loadProfile`.

Resolve the site and its named library to a drive id. Two requests, made fresh on every run
rather than cached, because a stale drive id is exactly the ID-navigation failure this project
exists to avoid, and two requests do not need optimizing.

Read the stored `deltaLink` for that profile and drive. Absent means a full enumeration from
`/drives/{driveId}/root/delta`. Present means an incremental one. Page through, applying each
page's changes to the stored inventory in the order they arrive, since delta orders its pages so
that a later entry supersedes an earlier one for the same item.

Persist the new `deltaLink` only after the last page has been applied. An interrupted scan then
resumes by re-reading pages it has already seen, which is wasteful and correct, rather than by
skipping changes it never applied, which is cheap and silently wrong.

Read the whole inventory partition back and assemble the snapshot.

### Applying a change

An item carrying a `deleted` facet removes its row. Anything else upserts one.

Deleting a row that is not there is tolerated rather than an error, because the first incremental
scan after a resync legitimately sees deletes for items it never recorded.

The drive root appears in every delta response and is skipped.

An item whose `parentReference.path` is missing is refused loudly, naming the item id, rather
than dropped. A dropped item becomes a file the reconciliation engine reports as missing, which
sends someone to produce a report that already exists. Losing an item has to be louder than
losing a scan.

### Resync

A stored `deltaLink` can be rejected with 410 and `resyncRequired`. The response is to clear that
drive's inventory entirely and re-enumerate from scratch.

The scan's output must say that it happened. A resync is the one case where the run costs what
the recursive walk cost, and an operator watching call counts is owed the reason rather than left
to conclude the optimization does not work.

### Assembling the snapshot

Non-folder rows become `files`, folder rows become `folderPaths`, `scannedAt` is the run's
timestamp, and `searchCrossCheckIncluded` is false for everything this slice produces.

A `subPath` argument filters after assembly rather than in the query, because delta cannot filter
by path.

The engine's collapse-by-path input contract is satisfied by construction. Keying the inventory
by item id means a delta page repeating an item upserts one row rather than adding a second, so
the engine's own collapse rule is left to handle only the residual case it was written for.

## The state store

| Table | PartitionKey | RowKey | Properties |
|---|---|---|---|
| `DeltaLinks` | profileId | driveId | `deltaLink`, `lastScanAt` |
| `Inventory` | profileId + driveId | encoded driveItem id | `itemId`, `path`, `name`, `isFolder`, `size`, `modified`, `etag` |

**The inventory row key changes from the parent spec's path hash to the item id.** This corrects
a defect rather than expressing a preference. Delta cannot maintain a path-keyed table: a deleted
item arrives as an id and a `deleted` facet carrying no path at all, so there is nothing to hash,
and a renamed or moved item arrives under the same id with a new path, so a path-keyed table
leaves a ghost row behind on every move. Both failures produce a snapshot that is confidently
wrong. Building the snapshot reads the whole partition in any case, so keying by id costs nothing
that path-keyed lookup was buying.

The inventory partition key joins the profile id and the drive id with a separator that is legal
in an Azure Table key and cannot appear in a profile id, which the profile schema already
restricts to lowercase letters, digits and hyphens.

The row key is an encoding of the item id rather than the raw id, because Azure Table forbids
`/`, `\`, `#` and `?` in keys and a driveItem id is an opaque string whose alphabet we do not
control. The raw id stays as a property so it can be read back without decoding.

Two Table Storage limits shape the writes. A transaction holds at most 100 entities and they must
share a partition, so applying a first enumeration chunks into transactions of 100 within the one
inventory partition. A 50,000-item library is then 500 transactions, which is acceptable and is a
number the scan reports. The 1 MB entity cap and the 64 KB per-property cap are far above
anything an inventory row holds, so the parent spec's one-entity-per-member rule is already
satisfied here.

The in-memory implementation is for tests and for a local run with no storage account. It cannot
demonstrate the incremental path across process restarts, which is why the Azure Table
implementation is in this slice rather than deferred: the incremental claim is the point of the
phase, and an implementation that only ever performs the first full enumeration cannot evidence
it. Local verification runs against the Azurite emulator, and the same code runs against a real
storage account from the hosting phase onward.

## The scan command

`npm run scan -- --profile <path>`, sitting beside `npm run setup`.

It exists because the ten tools are stubs until phase 4, and because phase 1 taught this project
that the first real use of a command finds what the test suite did not: `--delete-bootstrap`
reported failure on an already-torn-down tenant, and 352 tests and nine reviewers had not asked
what "already done" should mean. A layer with no way to run it by hand gets its first real
exercise inside a tool, where the failure is harder to read.

It prints the snapshot's summary counts, whether the run was full or incremental, whether a
resync occurred, the number of Graph requests made, and the number of store transactions written.
The request count is the before-and-after evidence for the recursive-enumeration pain point that
started the project, so it is output rather than telemetry.

The message-audit practice from the parent spec applies to everything this command prints. Every
string it can produce is enumerated, each composed string reconstructed from its parts, and each
one checked against what the program had actually done at the moment it prints. This project
produced the same class of defect nine times and that practice is what stopped it.

## Testing

Unit tests against a fake transport, with no credentials and no network, cover path addressing in
both directions, delta paging and link handling, change application, and snapshot assembly. The
store gets the same treatment through its interface, so the in-memory and Table implementations
are held to one set of expectations.

Error paths are CI gates in `.errors.test.ts` files, which the existing `test:errors` script
already isolates:

- 429 with `Retry-After` as delta-seconds, and again as an HTTP date; 503; and retries exhausted.
- A stored `deltaLink` rejected with 410 `resyncRequired`, asserting the inventory was cleared,
  the scan re-enumerated, and the output said so.
- A delta item with no `parentReference.path`, asserting the refusal names the item id.
- A delete for an item the store never held, asserting it is tolerated.
- A token-endpoint 401, asserting the message names the credential rather than the site.
- A library name matching nothing, asserting the message lists the libraries that do exist,
  because a bare "not found" sends an operator to check the wrong thing.
- A store transaction chunk failing partway.
- The encoded-key round trip over ids containing every character Azure Table forbids.

**Live verification** against the author's own developer tenant with a synthetic library: a first
run enumerating everything, a second run immediately afterward returning no changes at a small
bounded request count, then a file added, renamed, moved and deleted by hand with a scan after
each, confirming the snapshot tracks every one. That sequence is the actual evidence for the
call-count claim, and its numbers belong in `docs/OPEN-ITEMS.md` alongside the record of what is
verified live versus only against fakes.

## Amendments this requires

- `CLAUDE.md` and the parent spec: the Graph client is plain `fetch`, not the Graph JS SDK, for
  the reasons above.
- The parent spec's state-store table: `Inventory` is keyed by item id, with the reason a
  path-keyed table cannot absorb a delta delete.
- The parent spec's phase 2: split into 2a and 2b, with `$batch` and the Search cross-check in 2b
  and `conflictBehavior` in phase 6.
- `docs/OPEN-ITEMS.md`: of the three decisions the parent spec required before phase 2, two are
  settled and recorded. The third, which delegated scopes the setup sign-in must request, remains
  open, is a setup-CLI concern rather than a server one, and does not block this work.

One new runtime dependency, `@azure/data-tables`.

## What this deliberately does not do

No `$batch`. A delta-driven inventory has no use for it: delta returns paged `driveItem`s already
carrying name, size, modified date, ETag, parent path and the file or folder facet, which is every
field the snapshot needs, and the only other calls in the slice are the two that resolve the
drive. Building the builder now would pin its split boundaries, its `dependsOn` support and its
partial-failure semantics against guesses about how phase 6 will use it. It gets built with the
consumer that exercises it.

No Microsoft Search. It belongs with the cross-check that consumes it, and until then the
snapshot says honestly that it did not run.

No writes of any kind. No `If-Match` application, no `conflictBehavior`, no plan tables. ETags are
captured and stored, which is all phase 6 needs from this slice.

No caching of the drive id, and no attempt to reduce the two resolution requests.
