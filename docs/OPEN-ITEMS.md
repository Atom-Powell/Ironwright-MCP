# Open items

The project's register of decisions awaiting a human, work deliberately deferred, and an honest
account of what is verified against a live tenant versus only against fakes.

It began as a list of phase 1's review leftovers and outgrew that name, which is why it no
longer carries it. Things land here when they need to survive past the session that found them,
because a scratch ledger will not be read by the phase that needs it. Sections are roughly
ordered by when they will matter, not by when they were written.

## Decisions required before the first live setup run

**ANSWERED 2026-09-12 by the first live run: the per-site grant was refused.**
`POST /sites/{site-id}/permissions` returned 403 `accessDenied` against a developer tenant,
using a delegated device-code token, after every preceding step succeeded. The site resolved,
the application and its service principal were created, and the Microsoft Graph app role
assignment (the admin-consent step) completed. Rollback then deleted the registration and left
no secret behind, which is the first live confirmation that the rollback works.

**Confirmed 2026-09-12.** The signed-in account was Global Administrator on that tenant and
site, which removes the insufficient-rights explanation. The documented
application-permission-only restriction holds, and the bootstrap redesign below is required
before the setup command can complete.

The bootstrap carries a tradeoff that needs an explicit decision rather than an assumption.
Granting the new application `Sites.FullControl.All`, minting its app-only token, having it
issue its own per-site grant, and then removing the role assignment does reach the right
steady state: the application ends holding only `Sites.Selected` plus one site grant. But
removing a role assignment does not revoke an already-issued token, so for the remainder of
that token's lifetime, roughly an hour, a credential with tenant-wide full control over every
SharePoint site exists. It never leaves the setup process and is never written down, but it
exists, and this project's whole security posture is built on refusing exactly that grant.

**DECIDED 2026-09-12: option 3, the separate long-lived grant-issuing app.** The server's
identity must never hold more than `Sites.Selected`, including transiently, so option 1's
token window was disqualifying. Options as considered:

1. Accept the bootstrap and its token window, documenting it plainly. Fully scripted.
2. Keep the command as it is through the app registration, consent, and service principal, and
   have the operator issue the one per-site grant themselves with a documented command. This
   reintroduces a manual step, though only one, and the command still removes the other five.
3. Have the operator pre-create a separate, long-lived bootstrap application that holds
   `Sites.FullControl.All` permanently and is used only for issuing grants. Moves the standing
   privilege into an app whose only job is grants, rather than into the server's own identity.

Option 3 is worth a hard look: it keeps the server's identity clean, makes the privileged
thing small and auditable, and is a one-time setup per tenant rather than per run.

A defect in our own diagnostic surfaced here. The 403 message lists directory-role causes and
never mentions that the endpoint may not accept a delegated token at all, which was already
written in this document before the run. It sends the operator to check role assignments when
the cause may be architectural. Fix the message when the bootstrap path is implemented.

**FIXED, found during Task 6's documentation review.** `nextStepForGraphFailure`'s generic 403
branch in `src/setup/cli.ts` still told the operator "the per-site grant needs site owner
rights" after the bootstrap redesign moved that call, and its rollback delete, onto the
bootstrap application's own token. That branch is the most likely 403 this command produces, so
the false claim sat on the likeliest path, and it directly contradicted `docs/SETUP.md`, which
was corrected in the same task to say site ownership is no longer required at all. A sibling
401 branch had the same problem: it told the operator to sign in again for a token failure that
is never about the signed-in operator's own sign-in. Both branches now recognize the
`/sites/{site-id}/permissions` path family and name the real causes, the bootstrap
application's `Sites.FullControl.All` consent and its propagation, instead. Fixed and pinned
with tests in `1acd8ef`, "fix: stop blaming site ownership for a refused per-site grant
message".

Original writeup follows.

**The per-site grant may not accept a delegated token.** Microsoft's reference for
`POST /sites/{site-id}/permissions` lists application permission `Sites.FullControl.All` and
marks delegated as not supported. Field reports are inconsistent: some administrators succeed
from Graph Explorer, others receive `accessDenied`. The setup command reaches that endpoint
with a delegated device-code token only. If the documented restriction holds, the run fails
there, the rollback deletes the registration, and the command can never complete.

This is a genuine chicken-and-egg. Issuing the grant app-only requires an application that
already holds `Sites.FullControl.All` with admin consent, which is the broad grant the
Decision Record refuses, and the application this command creates holds only `Sites.Selected`,
so it cannot grant itself.

One clean way out, proposed during review: assign the new application `Sites.FullControl.All`
as well, mint its app-only token, have it issue its own per-site grant, then remove that role
assignment before printing credentials. Steady-state least privilege is preserved, the
bootstrap is scripted rather than manual, and the whole thing is testable. This needs a
decision, not an assumption, and one live run settles which path is necessary.

**The device-code sign-in requests no scopes of its own.** It asks for
`https://graph.microsoft.com/.default` against Microsoft Graph Command Line Tools, which
yields only what that service principal already has consented in the tenant. The sequence
actually needs delegated `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`,
`Sites.Read.All`, and `Sites.FullControl.All`. Nothing requests them and nothing inspects the
admin token's `scp` claim. A tenant that has never used Graph Command Line Tools will either
prompt for that application's full configured set or fail outright. The wave that found this
also added a helper that reads roles from an access token, which a scope pre-flight could
reuse in a few lines.

**DECIDED 2026-09-12: Entra OAuth enforced by Container Apps built-in authentication.**
Now a sixth safety layer in the design spec, the one deciding who may call at all. Enforced by
the platform rather than in process, so no route ships unprotected by accident, and the
protection must live in the deployment definition. Original framing follows.

**The MCP endpoint has no authentication and the spec's safety model does not mention any.**
All five safety layers govern what a tool does once called; none governs who may call. Phase 1
exposes only stubs, but the read tools return a customer's repository inventory and the write
tools can bulk-rename it. Copilot Studio registration forces an auth choice regardless, so
this is an unrecorded decision rather than a deferred one. Settle it before phase 2.

**Status at the start of phase 2a, 2026-09-13.** Of the three decisions the design spec required
before phase 2, two are settled and recorded above: the per-site grant does not accept a
delegated token, and the MCP endpoint authenticates through Container Apps built-in Entra auth.
The third, which delegated scopes the setup sign-in must request, is still open. It governs the
setup command's device-code flow and not the server's app-only Graph access, so it does not block
phase 2a and phase 2a does not close it.

## Carried into later phases

**Hosting phase.** A production image built with `npm ci --omit=dev && npm run build` will
fail, because the build compiles `src/setup/main.ts`, which imports `@azure/identity`, now a
devDependency. Either build before pruning or exclude `src/setup` from the production
tsconfig.

**Hosting phase.** The MCP SDK deletes a pending stream-mapping entry on close without
resolving it, so an aborted request can leave its handler permanently pending and retain the
closure. This matches the SDK's own stateless example and is not a local defect. Watch it
under load.

**Hosting phase.** The SIGTERM handler has no fallback deadline. One request that never
completes means `close` never calls back and the platform eventually sends SIGKILL.

**Before phase 4 wires real handlers.** `ToolDefinition.inputSchema` is a `z.ZodRawShape`,
which structurally forbids an object-level refinement. `generate_move_plan` already needs one,
since nothing enforces that `scopeValue` is present when `scope` is `client` or `deliverable`.
Cheap to settle now, ten files later.

## Known minor issues

**CLOSED 2026-09-12 by `3b72f52`, "feat: add --delete-bootstrap so the documented teardown is
executable", refined by `884aab3` and `c91ce2b`.** `docs/SETUP.md` recommended deleting the
grant issuer once setup was done, and the command provided no way to do it. `--delete-bootstrap`
now finds the grant issuer by display name and deletes it, using only the operator's delegated
sign-in, refuses an ambiguous match rather than deleting one of several identically named
applications, and refuses to run alongside `--create-bootstrap`. A normal run's success output,
on both the confirmed and unconfirmed verification paths, now also names `--delete-bootstrap` as
the way to remove the grant issuer's standing permission once the site is onboarded, since the
teardown documented only in a file nobody reopens does not happen.

**CLOSED 2026-09-12 by `aaeaa57`, "fix: close the rollback gap, replication race, and stale
remedy in setup".** A site permission granted immediately before a malformed response was not
rolled back: the field check threw before the permission id was captured, so the rollback
removed the application and left the permission behind. Rollback now tracks the attempt itself,
before the response is read, and tolerates deleting a permission that may never have existed,
the same way every other rollback failure already is.

**CLOSED 2026-09-12 by `aaeaa57`, "fix: close the rollback gap, replication race, and stale
remedy in setup".** Creating the service principal immediately after the application
intermittently failed with `Request_ResourceNotFound` from directory replication lag. It now
gets the same bounded retry the token exchange already used for the equivalent lag on the
client-credentials call, so losing that race no longer tears down an otherwise-correct run.

**CLOSED 2026-09-12 by `aaeaa57`, "fix: close the rollback gap, replication race, and stale
remedy in setup", refined by `43df5b1`, "fix: remove the self-contradiction in the
grant-missing message".** The `grant-missing` remedy told the operator to issue a per-site
grant the command had already issued seconds earlier under the bootstrap flow. It now names
propagation as the likelier cause and a mismatched site as the fallback, tells the operator how
to check and correct each, and still never suggests re-running the command, which would only
register a second application.

**CLOSED 2026-09-12 by `8cf5b08`, "feat: resolve bootstrap credentials and extract the setup
error type", finished by the final fix wave.** `src/setup/cli.ts` declared itself pure parsing
and formatting, then imported `run.js` for a single `instanceof` check, which pulled the
adapter and its `fetch` calls into the CLI unit test module graph. `SetupFailedError` now lives
in `src/setup/errors.ts` and both `cli.ts` and its tests import it from there, so nothing in
that module graph reaches the network layer.

The 405 responses and the setup adapter's error paths are covered, but the in-route `-32603`
handler still echoes the SDK's own error message, the one response path carrying text that did
not originate in that file.

## Deferred after the grant-bootstrap work

These were judged Minor across the plan's reviews and left rather than fixed. None blocks a merge.

Import ordering in one test file, which no linter enforces either way. The credential-label
wrapping and the missing-credentials guard both live in `src/setup/main.ts`, which has no test
seam by design, so their correctness rests on inspection; `main.ts` has since grown into the
branch point between the two modes and deserves an extraction in a later phase. A raw network
exception, as opposed to a bad-status response, still loses the credential label, which matters
little because a DNS or socket failure describes itself in a way a 401 does not. The bootstrap
token is deliberately not cached across runs.

Two are worth a second look when this area is next opened. The exit code stays zero on a run
that completed but could not confirm access, on the reasoning that a wrapper discarding the
output would throw away the only copy of the secret; a CI wrapper checking only the status
therefore cannot distinguish a verified run from an unverified one. And the new application's
own token exchange still rolls back an otherwise-correct application when it exhausts its
retries on a propagation error, which is the same destroy-correct-work-over-timing shape that
was deliberately rejected for the verification path.

## Should one bad workbook row abort the whole reconciliation?

Raised 2026-09-13 during the reconciliation engine's second task.

A malformed `effectiveFrom` cell throws, and the throw happens partway through the loop over
clients, so a single date typed as `15/08/2026` in one client's row aborts the report for every
client. The immediate fix was to make that failure name the client and quote the value, so an
operator can fix the cell rather than bisecting a spreadsheet. The behavior itself was left
alone deliberately.

The alternative is to skip the offending row, record it as an issue, and report the rest. That
is probably right for a hand-maintained tracker, where one typo in fifty rows should not cost
the other forty-nine. It is also a change to the report's shape, since those issues need
somewhere to live, which touches the types, the assembly stage and the golden fixture.

Settle it when the engine first runs against a real workbook, because that is when we will know
whether bad cells are rare enough that failing loudly is the better behavior. Deciding now would
be guessing about data nobody has looked at.

Worth noting the tension: this project's stated posture is to fail loudly rather than guess, and
a reconciliation that silently omits a client is exactly the kind of quiet incompleteness the
rest of the design refuses. Whatever is chosen, the omission has to be visible in the report
rather than only in a log.

## CLOSED: the server application teardown mode now exists

**CLOSED 2026-09-13, by `--delete-server-app` (`fd79768` through `b688722`).** The mode this item
called for now exists. It lists the site's permissions and revokes the entry matching the
application while that application's identity still exists, then deletes the application, then
purges it from the tenant's deleted items, which is the forced order this item named: revoke
first because the entry is matched by application id, purge last because a delete alone is only
a soft delete with a 30 day restore window. Dry run is the default and `--confirm` is required to
act. `--force-orphan` covers the case this item raised directly, a grant issuer that is already
gone: it deletes and purges the server application anyway and leaves any permission entry behind,
reporting that it may still be there rather than guessing.

The root cause this item named, not a missing feature so much as the advice that produced the
ordering problem, was corrected in the same work. `docs/SETUP.md` and the setup command's own
success message no longer tell an operator to delete the grant issuer once onboarding is done;
both now say to keep it until every site it onboarded has itself been decommissioned, because
`--delete-server-app`'s revoke step needs that same grant issuer's app-only token.

Everything in the two paragraphs above describes code, not a run. No part of this mode has ever
made a Graph call against a tenant: its behavior is known from reading it and from tests against
a fake `SetupGraph`, and nothing in it has been proven by use. The closure is that the mode
exists, not that it works. The phase 2a live-run checklist further down this file now ends with a
teardown step that would be its first real exercise.

One gap survives, recorded separately below: if the delete succeeds and the purge that follows it
fails, the mode cannot recover on a re-run, because the lookup it uses to find the application
does not see a soft-deleted one.

Original entry follows.

Found while cleaning up after the live run, 2026-09-12.

`--delete-bootstrap` removes the grant issuer, and that path is now covered. Nothing removes the
server application or the per-site permission it was granted, and the two have to come apart in
an awkward order.

Deleting the server application in the portal is easy and invalidates its secret. What survives
is the permission entry on the site, now naming an identity that no longer exists. Removing that
entry needs an app-only token carrying `Sites.FullControl.All`, which means a grant issuer must
exist. So an operator who followed the recommended posture, deleting the grant issuer after
onboarding, has to recreate one solely to remove a permission entry, and creating it needs
Privileged Role Administrator or Global Administrator.

The orphaned entry grants access to nothing, so this is untidiness rather than exposure. It
matters for two cases. Decommissioning a customer leaves residue on their site that the tool
cannot clear. And a test run against a real tenant, which is exactly how this was found, cannot
be fully undone by the tool that made it.

Worth considering together rather than as two features: a mode that removes a server application
and its site grant in the right order, and a decision about whether teardown should offer to
retain the grant issuer when it can see that a server application still holds a grant it may
later need to revoke. The second is the more interesting question, because the current advice to
delete the grant issuer immediately is what creates the ordering problem.

## CLOSED: an already-absent grant issuer reports success, not failure

**CLOSED by Task 1 of the server application teardown plan, commit `0a50aed`, "fix: treat an
already-absent grant issuer as done, not as a failure".** `runDeleteBootstrap` now returns a
distinct `already-absent` outcome instead of throwing when no application matches the display
name, and its own message says so: nothing existed, so nothing was deleted, and that is the
finished state, not a failure. `--delete-bootstrap` against a tenant whose grant issuer is
already gone now prints that message and exits zero.

Original entry follows.

`--delete-bootstrap` was run against a tenant whose grant issuer had already been removed by
hand. The lookup correctly found nothing and the message correctly said no action was needed.
It also printed "Bootstrap deletion failed" and exited 1.

Those disagree. If the grant issuer is already gone, the outcome the operator wanted is true,
and reporting a failure is wrong. A script wrapping this to enforce teardown across tenants
would read a correctly torn-down tenant as a broken one, and would retry or alert on it.

Already-absent should be a success with its own message, distinct from both a completed
deletion and a real failure, and should exit zero.

This is worth recording for what it says about the testing, not just the bug. Nine reviewers,
an enumeration requirement over every operator-facing message, and 352 tests did not surface
it, because all of them reasoned about failure paths in the abstract. None asked what "already
done" should mean. The first live use found it in one run.

## Verified end to end on 2026-09-12

The two-phase setup completed successfully against a real Microsoft 365 developer tenant.
`--create-bootstrap` created the grant issuer with its service principal, a seven day secret,
and an admin-consented `Sites.FullControl.All` role. The normal run then resolved the site,
created the server application holding only `Sites.Selected`, added its secret and service
principal, consented that role, issued the per-site grant on the grant issuer's app-only
token, and verified access with a token minted for the new application. Exit code zero, and
the confirmed path rather than the unconfirmed one, so verification returned success rather
than hitting propagation lag.

This discharges the outstanding verification that had stood since phase 1. Three things had
never executed against a tenant before this run and now have: the client credentials exchange,
its propagation retry, and the verification call.

It also confirms the diagnosis behind the whole redesign. The same grant, against the same site
in the same tenant, was refused with 403 on a delegated token held by a Global Administrator
and succeeded on the grant issuer's app-only token. The documented
application-permission-only restriction is real, and the bootstrap approach resolves it.

Still unexercised: every failure path. Rollback, the propagation retry, the preflight refusal,
the duplicate-bootstrap guard, and every diagnostic message have been tested only against
fakes. The `--delete-bootstrap` path added afterward is in the same position: its not-found
refusal, its ambiguous-match refusal, its dry run, its success message, and, since it gained a
purge on 2026-09-14, the purge itself, its replication-lag retry ladder, and the delete-404
path that falls through to the purge, are all covered by tests against fakes, not by a live
delete against a real tenant. `--delete-server-app`, added 2026-09-13, is the same again and is
the larger gap of the two, because it is the mode with the most steps and the most destructive
ones: the permissions listing and its paging, the revoke, the delete, the purge and its
replication-lag retry, the dry run, `--force-orphan`, and every message each of them prints have
all been run only against fakes. No live failure on any of these paths has been observed.

## Deferred from the reconciliation engine's whole-branch review, 2026-09-13

The engine's final review raised fourteen findings. One Critical and four Important were fixed
in the same wave, along with six of the Minors. Three were deferred deliberately, and one open
question came out of a fix.

**Duplicates and orphans carry no ETag.** `types.ts` says an ETag travels with a file because a
later rename or move plan needs it as an `If-Match` precondition, and the moment the engine saw
the file is the honest moment to capture it. Matched artifacts carry one. Duplicates and orphans
do not, and both are exactly the files a remediation plan will want to act on: a duplicate is a
rename or delete candidate and a misfiled orphan is a move candidate. Adding the field is
cheap; it changes the report shape and the golden fixture, which is why it was not done at the
close of the phase. Settle it when phase 4 writes the first plan generator, because that is the
consumer whose needs decide the shape.

**A client name containing a path separator renders an impossible filename.** A workbook row
naming a client `NORTH/SOUTH` produces an expected path and filename with an embedded separator,
so the slot can never be satisfied and the client is permanently reported as missing everything.
No validation rejects it. The fix is a character restriction on the client column, but the right
character set is a question about real customer data rather than a code decision, and guessing
it now risks rejecting a legitimate name. Decide it against a real workbook.

**Two different causes share one error sentence.** `match.ts` reuses the exact wording that
`profile/schema.ts` uses for a different failure. Both messages are individually accurate, so
this is a diagnosability cost rather than a correctness one: an operator searching for the text
lands on two unrelated call sites. Worth fixing when either message is next touched.

**Should an out-of-window file be its own orphan kind?** The `unexpected` kind covers two
situations that mean different things. A file naming a client, period or deliverable nobody owes
usually means the workbook is stale. A file whose period simply falls outside the reporting
window means nothing is wrong at all: it is last year's report sitting where it belongs. The
comment asserting the stale-workbook cause was corrected during the fix wave, since the engine
cannot observe which case it is looking at, but the conflation is still in the report shape. A
third kind would separate them. That changes the report and the golden fixture, and nobody has
yet asked the question that needs the distinction, so it waits for a real repository.

**A recognizer must now declare a month or a month name.** Added while closing a never-matches
footgun: a recognizer whose pattern captures no period could never satisfy any slot, and the
profile loader accepted it silently. The check is right for every cadence the engine supports
today, all of which report under a month. It would be wrong for a genuinely annual deliverable
whose filename carries only a year, which the parser already refuses for the same reason, so
nothing regressed. If an annual cadence is ever added, this validation and the parser's period
resolution have to move together.

**Lint does not catch a dynamic import of a stage module.** The entry-point rule added during
the fix wave catches static imports, re-exports, `export *`, `require` and every path spelling
tried against it, but `await import("../domain/reconcile/expected.js")` produces no message.
Left as is: the rule's purpose is to stop the boundary eroding through ordinary code, and
nothing in this codebase imports dynamically. Worth revisiting only if a dynamic import appears.

## CLOSED: the test tenant's server application is deleted and purged

**CLOSED 2026-09-13.** The operator deleted `Ironwright Repository Reconciliation` from the
`helloironwright` tenant and confirmed that **App registrations, Deleted applications** is empty,
which is the check that matters: a soft-deleted registration keeps its credentials restorable for
30 days, so the purge, not the delete, is what ends the exposure. The secret displayed in a session
scrollback is no longer recoverable.

Two consequences, both expected and neither a defect.

The per-site permission entry survives on the SharePoint site, naming an identity that no longer
exists. It grants access to nothing, and removing it would need a grant issuer recreated solely for
that, which is not worth doing on a developer tenant. It is an instance of the teardown hole
recorded above, not a new problem.

There is now no server application in that tenant, so phase 2a's live verification needs a fresh
one before it can run: `--create-bootstrap`, then a normal setup run, then the scan. Worth doing in
one sitting.

Original entry follows.

Raised 2026-09-13, after phase 3 merged.

The first live setup run created `Ironwright Repository Reconciliation`, app id
`1c02621a-e9b9-4b7b-a5da-f74e03e2e1ed`, in the `helloironwright` developer tenant. It is still
there, and its client secret was displayed in a Claude Code session's scrollback, so it should be
treated as exposed and the application deleted rather than merely rotated.

Deleting it needs two steps, not one. Entra's delete of an application registration is a soft
delete: the object sits in the tenant's deleted items for 30 days, where anyone with Application
Administrator can restore it along with its credentials. So delete the application, then purge it
from **App registrations, Deleted applications, Delete permanently**, or the secret is recoverable
for a month.

Deleting the application leaves the per-site permission entry behind, naming an identity that no
longer exists. Removing that entry needs an app-only token carrying `Sites.FullControl.All`, so it
needs a grant issuer to exist. On a developer tenant the orphaned entry grants access to nothing
and is not worth recreating a grant issuer for. See the teardown hole above, which is the product
gap this is one instance of.

## Phase 2a: covered only by fakes, 2026-09-13

Phase 2a has not been run against a real tenant. No Graph call, no Azure Storage call, and no
Azurite run has ever been made by this code. Everything below is verified against fake
transports and a fake table client, and nothing more should be read into it than that.

**What is covered.** The Graph client and its `Retry-After` backoff in both the delta-seconds and
HTTP-date header forms. The token provider's caching and single-flight behavior. Path addressing
in both directions and drive resolution. The delta pager, including its resync detection. Both
state store implementations, run against one shared conformance suite. The change conversion and
the snapshot assembly. The scan's orchestration, including its resync path. Every message the
scan command prints. All of it against fakes, all of it green, none of it against Graph or Azure
Table Storage.

**The claim this phase exists to support is unverified.** The reason phase 2a exists is that a
recursive per-folder inventory cost hundreds of Graph calls, and delta plus a persisted
continuation link should reduce that to a small bounded number. The scan reports its own Graph
request count precisely so that claim can be checked against a real tenant. It has not been
checked. Until a live run happens, the request-count reduction is a design argument, not
evidence.

**One line that is unproven and cannot be proven by a fake.**
`tableStateStoreFromConnectionString` in `src/store/table.ts` bridges the real
`@azure/data-tables` `TableClient` to the narrow `TableClientLike` interface with an
`as unknown as` cast:

```
deltaLinks: TableClient.fromConnectionString(connectionString, "DeltaLinks") as unknown as TableClientLike,
inventory: TableClient.fromConnectionString(connectionString, "Inventory") as unknown as TableClientLike,
```

A reviewer confirmed against the installed package that the real client does not structurally
satisfy `TableClientLike` without the cast, so the compiler checks nothing at that line and no
fake can either. The first real connection is what validates it. `ensureTables` is tested against
the fake but has likewise never created a real table.

**The ETag gap, as a precondition for phase 6.** `src/scan/changes.ts` records a file's ETag as
`item.eTag ?? ""`. The domain's `RepositoryFile.etag` is a required string, so a file for which
Graph sent no ETag is stored as an empty string that nothing downstream can distinguish from a
real one. That field exists specifically so a plan generator can use it as an `If-Match`
precondition. The scan command now reports how many files carry no ETag, so the gap is visible
to an operator, but the type still cannot express absence. Phase 6 must settle this before any
write tool sends an `If-Match`, and the honest fix is to make the field optional, which changes
the reconciliation engine's frozen report shape and its golden fixture.

**The environment variable naming split, as a precondition for hosting.** `npm run setup` prints
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`. The server reads `IW_TENANT_ID`,
`IW_CLIENT_ID` and `IW_CLIENT_SECRET`. The missing-credentials message now states the mapping at
the moment of failure, which unblocks an operator, but two names for one value is the actual
defect. The hosting phase is where these names get written into a deployment definition and is
where they should be unified.

**Why the live run has not happened.** The design called for a live run against the developer
tenant used for phase 1: a synthetic library, a profile for it, Azurite, a cold scan, an
immediate second scan, and one scan after each of an add, a rename, a move, and a delete. None of
that ran in the implementing session. It needs a synthetic library created in the tenant by hand
and working server-application credentials, and the server application from the phase 1 setup
run should not be reused: its client secret was displayed in a session's scrollback, and the
outstanding operator action above is to delete and purge it, not rotate it. A session that cannot
create tenant resources or hold live credentials cannot perform this run, so it is left to the
operator.

**What the operator does to close this out.**

1. Settle the credentials question first. Delete and purge the exposed server application per the
   outstanding operator action above, then either create a new server application for the
   developer tenant or run `npm run setup` again to produce one.
2. In the developer tenant, create a synthetic document library with a small tree matching the
   example profile's taxonomy: a year folder, two client folders, and three or four files. Use no
   real client data.
3. Write a profile JSON for the synthetic library under `profiles/`, which is git-ignored.
4. Start Azurite.
5. Run a cold scan against the profile. Record the mode, the file and folder counts, the Graph
   request count, and the write-operation count.
6. Run the scan again immediately. Record whether it reports `incremental`, whether it avoided a
   resync, and the Graph request count, against the design's expectation of a small bounded
   number.
7. Add a file to the synthetic library and scan. Rename a file and scan. Move a file between
   client folders and scan. Delete a file and scan. After each, confirm the snapshot tracks the
   change and that no ghost row survives the move.
8. Tear the server application back down with `npm run setup -- --tenant=<tenant-id>
   --site=<site-url> --delete-server-app`, first without `--confirm` and then with it. This is the
   sitting in which that mode gets exercised against a real tenant for the first time, which the
   teardown design expected rather than a separate trip. Two things to check that no test can
   answer. Confirm **App registrations, Deleted applications** is empty afterward, which is the
   only evidence the purge happened rather than returning not found against a directory that had
   not caught up. And check whether a service principal for that application survives the delete:
   nobody on this project has verified that deleting an application registration also removes its
   service principal, and if one survives, this mode needs a step to remove it and the rollback in
   `runSetup` has the same gap. Record which it was.
9. Record the actual numbers and outcomes from steps 5 through 7 in this file, in a new dated
   section, following the tone of the 2026-09-12 setup entry above: name the numbers, name what
   still was not exercised, and do not describe an untested path as working. Record step 8's two
   answers in the same section.

Until those numbers exist, this phase's central claim, that delta plus a persisted continuation
link bounds the Graph request count, is unverified. The numbers belong in this file when they
exist, not before.

## Neither teardown mode can recover from its own partial purge failure

Found during Task 4 of the server application teardown plan, 2026-09-13, for
`runDeleteServerApp`. Confirmed to apply identically to `runDeleteBootstrap` once that mode
gained its own purge on 2026-09-14: the same comment naming this gap now sits in `run.ts` next
to both functions' purge-failure handling.

Both `runDeleteServerApp` and `runDeleteBootstrap` delete the application, then purge it from
the tenant's deleted items. If the delete succeeds and the purge that follows it then fails, the
application is left soft-deleted rather than gone. For `runDeleteBootstrap` this is arguably the
worse case of the two: the grant issuer holds `Sites.FullControl.All` tenant-wide, the broader
of the two permissions this project isolates.

Neither mode can repair this on a re-run. `findApplicationByDisplayName` queries the live
`/applications` collection, and Entra excludes soft-deleted objects from it; they are returned
only by `/directory/deletedItems`. So a re-run's first call finds nothing, both modes return
`already-absent`, and the purge that never ran is never attempted again. The credential stays
restorable, with its secret, for the remainder of its 30 day window, and nothing about either
mode's own state says so beyond the one failure message from the run that hit it.

That failure message, in both modes, names the fix an operator can make by hand: `DELETE
/directory/deletedItems/{objectId}`, using their own delegated token. Each was written with this
gap already in mind, so the operator is not left guessing, but neither mode can finish the job it
started once this failure occurs.

A real fix needs each mode to look up the application by object id, not display name, once it has
one, so a re-run can find a soft-deleted object and retry the purge against it.
`findApplicationByDisplayName` is the wrong tool for that half of the job: it exists to find an
application nobody has an id for yet, which is only true before the delete, not after. Since the
gap and its shape are now identical in both modes, a fix should address both together rather than
repeating this item a third time for whichever mode is touched next.

## CLOSED: the grant issuer's own teardown never purges it

**CLOSED 2026-09-14 by `3e3fb86`, "feat: purge the grant issuer after --delete-bootstrap, gated
behind --confirm".** `runDeleteBootstrap` now purges the grant issuer from the tenant's deleted
items after a confirmed delete, reusing `purgeDeletedApplicationWithRetry` and its
replication-lag retry unchanged from `runDeleteServerApp`, exactly as this item's own closing
paragraph proposed. Because purging is irreversible in a way the delete alone is not,
`--delete-bootstrap` now also defaults to a dry run and needs `--confirm` to act, matching
`--delete-server-app`; every operator-facing message that names this command, including the
normal run's own grant-issuer-teardown note and `docs/SETUP.md`, was updated so it names
`--confirm` rather than pointing at an invocation that would now only preview. Not verified
against a live tenant; see this file's live-testing entries above for what has and has not
actually been exercised.

Original entry follows.

Noticed during Task 4's review of the server application teardown plan, 2026-09-13.

`runDeleteBootstrap` deletes the grant issuer and returns. It never calls
`purgeDeletedApplication`. The grant issuer holds `Sites.FullControl.All` tenant-wide, the
broader of the two permissions this plan concerned itself with, so the same reasoning
`runDeleteServerApp` applies to the server application applies here at least as strongly,
arguably more: a delete alone is a soft delete, and the application, with its credentials, stays
restorable by anyone holding Application Administrator rights for 30 days afterward.
`docs/SETUP.md` already tells an operator to purge it by hand in the portal if that window is a
concern, which is honest, but it is manual, easy to skip, and not what the mode itself does.

Not fixed here. `--delete-bootstrap` is a different mode from the one this plan built, and this
is exactly the kind of unplanned addition the working agreement asks to route through its own
design step rather than folding into whatever change happens to be nearby. The fix, when it is
taken up, is small: `purgeDeletedApplication` already exists on `SetupGraph`
(`src/setup/adapter.ts`), built for `runDeleteServerApp`'s own teardown, so `runDeleteBootstrap`
would only need to call it after `deleteApplication` succeeds, the same way `runDeleteServerApp`
already does.
