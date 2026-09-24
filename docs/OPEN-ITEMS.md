# Open items

The project's register of decisions awaiting a human, work deliberately deferred, and an honest
account of what is verified against a live tenant versus only against fakes.

It began as a list of phase 1's review leftovers and outgrew that name, which is why it no
longer carries it. Things land here when they need to survive past the session that found them,
because a scratch ledger will not be read by the phase that needs it. Sections are roughly
ordered by when they will matter, not by when they were written.

**Writing a live sitting up here is only half the step.** The other half is correcting that
phase's Build Sequence entry in `CLAUDE.md` in the same commit, because that entry is what says
what the phase still owes and it is the document every session loads. The rule is stated in
`CLAUDE.md`'s Working Agreement; it is repeated here because this file is where the first half
gets done and is therefore where the second half gets forgotten, which it has been twice.

## Decision required: which file should a plan act on when a slot's winner is in another library?

Found by the phase 6b-1 whole-branch review, 2026-09-24. Open, and the operator's to make.

**What the engine does today.** `matchArtifacts` ranks every candidate for a slot, including a copy
the Microsoft Search cross-check found in another library of the same site. A file carrying a
library is always `misplaced`, so it ties on rank with a local misplaced file and the tie falls to
modification time, and it outranks a local `misnamed` file outright. The foreign file can therefore
win the slot, and the local file is only reported, as a duplicate.

**What a plan does with that.** Nothing moves or renames in that case. The foreign winner is
excluded from a move plan as `in_another_library`, and the local loser is excluded from whichever
plan would have acted on it as `slot_won_by_file_in_another_library`, which says that this file lost
its slot to a file in another library and that nothing occupies the canonical path in this library.
Before that reason existed the local file was reported as `target_path_already_occupied` or
`two_files_share_one_target_name`, both false, because the check compared the foreign winner's
library-relative path with this library's canonical path. The fix changed only the reason; which
file wins a slot and which file becomes a candidate are unchanged, deliberately.

**The choice.** Either prefer the local file for local remediation, so a same-library move or
rename puts the local copy at the canonical path and the foreign copy is left to be reported, or
leave the slot as it is and resolve it through cross-library moves in phase 6b-2, which would bring
the foreign winner home. The first would change how a slot is resolved, which every read tool
reports too, so it is a product decision rather than an implementation detail.

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

**CLOSED 2026-09-24 by the token role guard, branch `token-role-guard`.** The item read:
**The server should refuse to start if its own token carries any role other than
`Sites.Selected`.** Found 2026-09-24 by the competitive refresh: a Microsoft Q&A moderator answered,
as by design, that an application holding `Sites.Selected` plus `Files.Read.All` or
`User.Read.All` could read sites it was never granted. Setup already reads the grant issuer's
roles claim (`appRolesFromAccessToken` in `src/setup/steps.ts`), but the running server never
checks its own, so someone adding a permission to the server application in Entra would widen
it silently. The 2026-09-24 token check found `["Sites.Selected"]` only, so nothing is wrong
today; the item is that nothing would say so if it changed. Scheduled 2026-09-24 as its own
small slice ahead of phase 6d, since it needs no Azure resources. Built as
`requireExactRoles` in `src/graph/token.ts`, checking every newly minted token, and
`checkStartupIdentity` in `src/server/identity.ts`, run before the port is bound. Verified live
on 2026-09-24 in the passing direction only: the server started against the sandbox with no
warning and `inventory_tree` answered through the guard at 3 Graph requests. The refusal path was
deliberately not exercised live, since that would mean granting the server application a broad
permission with admin consent; it is covered by unit tests only.

**Report the server version in `/health` and the startup log (phase 5b).** From the same refresh:
a peer server's users asked for a way to see which version is running (Lokka #52), because it
was hardcoded rather than read from `package.json`. Worth doing with 5b's telemetry, once there
is a deployment to ask; nothing to build before then.

**Bound the startup identity check with a timeout (phase 5b).** Found 2026-09-24 by the token role
guard's whole-branch review. `checkStartupIdentity` now asks Entra for a token before the port is
bound, and it has no timeout of its own: it relies on the `fetch` defaults. A token endpoint that
accepts the connection and never answers would hold startup open, and could keep the server past a
Container Apps startup probe, which would restart it for a reason no log line names. Worth a
bounded timeout when 5b sets up the probes; a timeout that expires would take the existing
"could not obtain a token" path, which logs a warning and starts anyway.

**CLOSED 2026-09-24: read before planning phase 6d; findings in the 6d spec's amendments.** The
item read: **Read the Google Drive MCP server with `dry_run` and a restore token before planning phase 6d.**
A search result during the refresh described one, the nearest thing to a reversal log found
outside this project, but its name and repository were not recorded. Find it and read its plan
and undo design first; research only.

**CLOSED 2026-09-18 by phase 5a, `1c79bbf`, "build: compile the server without the setup
command for production", carried through a timeout fix in `4acce7c`.** A production image
built with `npm ci --omit=dev && npm run build` would fail, because the build compiled
`src/setup/main.ts`, which imports `@azure/identity`, a devDependency. `tsconfig.build.json`
extends the base config and excludes `src/setup`, and `npm run build:prod` runs `tsc` against
it; `npm start` already pointed at `dist/server/main.js`. Excluding `src/setup` was chosen over
building before pruning. The setup command issues per-site permission grants using a separate
application holding `Sites.FullControl.All`, an operator tool with no business inside a server
image; compiling it into a deployment would widen what a compromise of that image reaches, from
"can read one granted site" to "contains the machinery for granting access to others." Building
everything and deleting the setup output afterward would still have shipped that code into the
image at some point in the build, and would have left the boundary resting on a cleanup step
rather than on the compiler never having seen the files. `npm run build` (development and CI)
is untouched and still compiles and typechecks `src/setup`, so nothing about this closes that
command's own coverage. `tests/build/production-build.test.ts` asserts the outcome on the
filesystem, shelling out to a real `npm run build:prod`, specifically so this cannot regress
silently the next time something under `src/setup` grows an import; see "Phase 5a" below for what
that test cost to make reliable and for the clean the script needed before the boundary was real.

**Hosting phase, restated rather than fixed.** The MCP SDK deletes a pending stream-mapping
entry on close without resolving it, so an aborted request can leave its handler permanently
pending and retain the closure. This matches the SDK's own stateless example and is not a local
defect, and phase 5a does not fork SDK behavior on a hunch to work around it. What makes the
item tractable is detection rather than repair, and detection is telemetry, which belongs to
phase 5b. See "Phase 5a" below.

**CLOSED 2026-09-18 by phase 5a, `51ca8a1` and `4043930`, "fix(server): exit on a deadline
rather than draining forever" and "fix(server): read the shutdown deadline's connection count
from getConnections".** The SIGTERM handler had no fallback deadline: `close`'s callback fired
only once every in-flight request finished, so one request that never completed meant the
process never exited on its own and the platform eventually sent SIGKILL, with no log saying
why. `installShutdown`, now in `src/server/shutdown.ts`, races the drain against a timer bounded by
`IW_SHUTDOWN_DEADLINE_MS` (default 25000ms) and exits on whichever finishes first, logging one
sentence synchronously before exit to say the drain did not finish. See "Phase 5a" below for the
two defects this introduced and then fixed on the same branch: the first version read a
`connections` property that does not exist on a real `http.Server`, and the second logged
nothing whatsoever, because the API that replaced that property defers its callback and
`process.exit` does not wait for it.

**CLOSED 2026-09-24 by phase 6b-1: a write tool no longer needs a cross-field constraint.**
`generate_move_plan` dropped the stub's `scope` and `scopeValue` for the optional `clients` array
`generate_rename_plan` already takes, so the one rule that needed an object-level refinement no
longer exists. The SDK defect that blocked it is unchanged and still recorded under "The MCP SDK
cannot advertise a refined input schema" below, for the next tool that needs such a rule.

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

## CLOSED: one bad workbook row does not abort the whole reconciliation

**CLOSED 2026-09-14 by `8015edf`, "feat: carry rejected workbook rows into the reconciliation
report", built on the reader's own rejection handling in `6482fa9` and `7b43b46`.** It does not
abort. An unreadable client cell, or any other row the reader cannot parse, is rejected rather
than thrown partway through the loop: `WorkbookSnapshot` carries a `rejectedRows` field, and
`ReconciliationReport` carries a matching `rejectedWorkbookRows` field, both required rather than
optional so a caller cannot forget to populate them. The engine copies the list through
unchanged; it never saw the raw row and does not interpret the rejection, only carries it. The
rest of the workbook still reconciles, and the omission is visible where an operator reads
results, in the report itself, not only in a log, which is the tension the original entry below
named as unresolved.

Original entry follows.

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

## Phase 2a: what the unit tests cover, 2026-09-13

**This section was written before the live sitting and is kept as it was, minus the claims that are
no longer true.** It opened "Phase 2a has not been run against a real tenant. No Graph call, no
Azure Storage call, and no Azurite run has ever been made by this code," which was correct on
2026-09-13 and false from 2026-09-16, when the operator checklist at the foot of this section was
worked through against the developer tenant: see "The first live tenant sitting, 2026-09-16" below,
which is the record. Of that checklist, step 9, the server-application teardown, is the only step
still owed; step 7 was blocked on the day and ran on 2026-09-17 once phase 2b-2 supplied the
workbook snapshot. Correcting it in place rather than appending a line, for the reason the phase 4b
section gives: this is the document a reader consults to decide what counts as evidence. What
follows describes what the unit tests reach.

**What is covered.** The Graph client and its `Retry-After` backoff in both the delta-seconds and
HTTP-date header forms. The token provider's caching and single-flight behavior. Path addressing
in both directions and drive resolution. The delta pager, including its resync detection. Both
state store implementations, run against one shared conformance suite. The change conversion and
the snapshot assembly. The scan's orchestration, including its resync path. Every message the
scan command prints. All of it against fakes, all of it green, none of it against Graph or Azure
Table Storage.

**The claim this phase exists to support was checked on 2026-09-16.** The reason phase 2a exists is
that a recursive per-folder inventory cost hundreds of Graph calls, and delta plus a persisted
continuation link should reduce that to a small bounded number. The scan reports its own Graph
request count precisely so that claim could be checked against a real tenant. A cold scan
enumerated 144 files and 122 folders in 4 Graph requests and an immediate re-scan in 3, against a
tree a recursive walk would have cost at least 122. The figures and their limits are in the sitting
section below; the request-count reduction is a measurement rather than a design argument.

**One line that was unproven and could not be proven by a fake.**
`tableStateStoreFromConnectionString` in `src/store/table.ts` bridges the real
`@azure/data-tables` `TableClient` to the narrow `TableClientLike` interface with an
`as unknown as` cast:

```
deltaLinks: TableClient.fromConnectionString(connectionString, "DeltaLinks") as unknown as TableClientLike,
inventory: TableClient.fromConnectionString(connectionString, "Inventory") as unknown as TableClientLike,
```

A reviewer confirmed against the installed package that the real client does not structurally
satisfy `TableClientLike` without the cast, so the compiler checks nothing at that line and no
fake can either. The first real connection is what validates it, and it did on 2026-09-16: both
casts held against the real `@azure/data-tables` client on Azurite and `ensureTables` created real
tables. Azurite is not Azure Table Storage proper, and that difference is not claimed away here.

**The ETag gap. Settled by phase 6a, by a different route than this entry prescribed.**
`src/scan/changes.ts` records a file's ETag as `item.eTag ?? ""`. The domain's
`RepositoryFile.etag` is a required string, so a file for which Graph sent no ETag is stored as an
empty string that nothing downstream can distinguish from a real one. That field exists so a plan
generator can use it as an `If-Match` precondition. This entry used to prescribe making the field
optional, which would have changed the reconciliation engine's frozen report shape and its golden
fixture. Phase 6a did not do that. `generate_rename_plan` fetches each candidate's etag at plan
time through `readDriveItemEtag` rather than reading it from the inventory, since the inventory's
copy comes from a snapshot that may be hours old, and excludes a candidate as `no_etag_available`
when the fresh fetch returns none. No write ever sends an `If-Match` built from the inventory's
field, so the write path has no empty-string hole. The inventory field itself is untouched and
still writes an empty string, and the scan command still reports how many files carry no ETag, so
the hole survives for any future consumer that reads `RepositoryFile.etag` and believes it.

**The environment variable naming split, as a precondition for hosting.** `npm run setup` prints
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`. The server reads `IW_TENANT_ID`,
`IW_CLIENT_ID` and `IW_CLIENT_SECRET`. The missing-credentials message now states the mapping at
the moment of failure, which unblocks an operator, but two names for one value is the actual
defect. This entry used to say the hosting phase was where these names get written into a
deployment definition and where they should be unified. Phase 5a came and went without unifying
them, and `docs/SETUP.md` now documents both spellings as the standing contract rather than as a
transitional state. Still open, reassigned to phase 5b, which is where a Container Apps deployment
definition actually gets written.

**Why the live run did not happen in the implementing session.** The design called for a live run
against the developer tenant used for phase 1: a synthetic library, a profile for it, Azurite, a
cold scan, an immediate second scan, and one scan after each of an add, a rename, a move, and a
delete. None of that ran in the implementing session. It needs a synthetic library created in the
tenant by hand
and working server-application credentials, and the server application from the phase 1 setup
run should not be reused: its client secret was displayed in a session's scrollback, and the
outstanding operator action above is to delete and purge it, not rotate it. A session that cannot
create tenant resources or hold live credentials cannot perform this run, so it is left to the
operator.

**What the operator does to close this out.**

1. Settle the credentials question first. Delete and purge the exposed server application per the
   outstanding operator action above, then either create a new server application for the
   developer tenant or run `npm run setup` again to produce one.
2. Write a profile JSON for the synthetic library under `profiles/`, which is git-ignored, with the
   taxonomy, naming, workbook mapping and window `npm run seed-library` and the scan below both
   read; `examples/profiles/example.json` is the template to copy from.
3. Run `npm run seed-library -- --profile <path to that profile>`, first without `--confirm` to
   read the dry-run estimate, then with it. In one pass, against the developer tenant and using no
   real client data, it builds a synthetic document library matching the profile's taxonomy and
   places a tracking workbook at the profile's `identity.workbookPath` with a table matching its
   workbook mapping. It plants three deliberate discrepancies, one client absent from the
   repository, one monthly artifact missing, and one monthly artifact misnamed, rather than a clean
   tree, so step 7 below has something to find. It also prints the report it expects the live
   reconciliation tool to return over what it just built. Keep that output; step 7 compares
   against it.
4. Start Azurite.
5. Run a cold scan against the profile. Record the mode, the file and folder counts, the Graph
   request count, and the write-operation count.
6. Run the scan again immediately. Record whether it reports `incremental`, whether it avoided a
   resync, and the Graph request count, against the design's expectation of a small bounded
   number.
7. Call `reconcile_workbook_vs_repository` against the same profile and compare its report,
   finding by finding, against the "Expected report from the live reconciliation tool" that step 3
   printed, before step 8 perturbs anything the comparison depends on. This step needs the tool
   that phase 4a wires; at the time of writing that work sits on the `phase-4a-reconcile-tool-wiring`
   branch rather than `main`, so if it has not merged yet, do steps 1 through 6 and 8 through 10
   and come back to this one once it has. A match here is not evidence that the reconciliation
   engine itself is correct: `scripts/seed/expected.ts` computes the printed expectation by running
   that same engine over the seed plan in memory, so the two sides agree by construction on
   anything the engine gets wrong. What a match does check is Graph, Excel, Azure Table Storage,
   and the tool's own composition, the layers a fake cannot reach. Any difference is a real
   finding.
8. Add a file to the synthetic library and scan. Rename a file and scan. Move a file between
   client folders and scan. Delete a file and scan. After each, confirm the snapshot tracks the
   change and that no ghost row survives the move.
9. Tear the server application back down with `npm run setup -- --tenant=<tenant-id>
   --site=<site-url> --delete-server-app`, first without `--confirm` and then with it. This is the
   sitting in which that mode gets exercised against a real tenant for the first time, which the
   teardown design expected rather than a separate trip. Two things to check that no test can
   answer. Confirm **App registrations, Deleted applications** is empty afterward, which is the
   only evidence the purge happened rather than returning not found against a directory that had
   not caught up. And check whether a service principal for that application survives the delete:
   nobody on this project has verified that deleting an application registration also removes its
   service principal, and if one survives, this mode needs a step to remove it and the rollback in
   `runSetup` has the same gap. Record which it was.
10. Record the actual numbers and outcomes from steps 5, 6, 7 and 8 in this file, in a new dated
   section, following the tone of the 2026-09-12 setup entry above: name the numbers, name what
   still was not exercised, and do not describe an untested path as working. Record step 9's two
   answers in the same section.

Those numbers now exist for steps 5, 6, 7 and 8, and they are in "The first live tenant sitting,
2026-09-16" below, with step 7's in the 2026-09-17 sitting. Step 9's two answers do not exist yet.

## The first live tenant sitting, 2026-09-16

Run against the `helloironwright` developer tenant, site `IronwrightTest`, library `Documents`,
profile `profiles/synthetic.json` derived from `examples/profiles/example.json`. Every number
below was read off a command's own output on the day, not reconstructed afterward. The sitting
did not complete: step 7 is blocked and step 9 was not run. Both are named as such below rather
than left to be inferred from silence.

**Setup, steps 1 and 2. Both succeeded.** `--create-bootstrap` created the grant issuer, and the
normal run created the server application and issued the per-site grant. The run printed the
confirmed arm of `describeGrantIssuerTeardownNote`, which only prints when `verifyAppAccess` has
positively reached the site with the new application's own token, so site access was verified
rather than merely not-errored. The server application was granted read-only, no `--write`,
because nothing in this sitting needs it to write.

This answers the question left open on 2026-09-12, when the per-site grant was refused with 403
`accessDenied` on a delegated token held by a Global Administrator. The separate grant-issuer
design was built for that refusal and this is the first live evidence that it works.

**Repository scanning, steps 5 and 6. The phase 2a claim is verified.**

| | Mode | Files | Folders | Graph requests | Delta pages | Changes applied | Write ops |
|---|---|---|---|---|---|---|---|
| Cold | full | 144 | 122 | **4** | 2 | 321 | 4 |
| Immediate re-scan | incremental | 144 | 122 | **3** | 1 | 0 | 0 |

Both ran with `Store: azure-table` against Azurite. The founding complaint in `Pain-Points.txt`
is that recursive enumeration costs hundreds of operations; a recursive walk of this tree would
issue at least one request per folder, so at least 122. Delta enumerated the same 266 items in 4.
The re-scan reused the persisted `deltaLink`, reported `incremental`, triggered no resync, and
issued no writes because nothing had changed. Until today that reduction was a design argument.
It is now a measurement, on one tree of this size on one tenant.

**`tableStateStoreFromConnectionString` is no longer unproven.** The `as unknown as
TableClientLike` cast in `src/store/table.ts` was recorded as the one line no fake could check.
Both scans above ran through the real `@azure/data-tables` `TableClient` against Azurite,
created their tables, and persisted and re-read a `deltaLink` across process boundaries. The cast
holds. This is Azurite rather than Azure Table Storage proper, which is a real difference and is
not claimed away here.

**Perturbations, step 8. All four tracked correctly.**

| Perturbation | Files after | Changes applied | Write ops | Graph requests |
|---|---|---|---|---|
| Add a file | 145 | 4 | 1 | 3 |
| Rename it | 145 | 4 | 1 | 3 |
| Move it to another client folder | 145 | 4 | 1 | 3 |
| Delete it | 144 | 1 | 1 | 3 |

No ghost row survived the move, which is the check the runbook asked for specifically. A surviving
row would have raised the count to 146 after the move and left it at 145 after the delete; it was
145 and then 144, back to the seeded baseline.

**Step 7 did not run, and cannot.** `reconcile_workbook_vs_repository` needs the workbook snapshot,
and the Excel API refuses this server's tokens. See the blocking entry below. The seeder's printed
prediction was therefore never compared against a live report, so nothing in this sitting says
anything about whether the composed tool returns the right answer. Phase 4a remains verified
against fakes only.

**UPDATE 2026-09-17.** Step 7 ran, in a later sitting, once the bytes-reader replacement existed.
See "The second live tenant sitting, 2026-09-17" below. The paragraph above is an accurate account
of this sitting on 2026-09-16; its last two sentences, that nothing here says whether the tool
returns the right answer and that phase 4a remains verified against fakes only, no longer describe
the project's current state.

**Step 9 did not run when this section was written.** The server application, the grant issuer, and
a throwaway `WAC probe` registration created for the permission testing below were all still
present in the tenant, and the probe application held tenant-wide `Files.ReadWrite.All` and
`Files.Read.All`.

**UPDATE 2026-09-19. Two of the three are gone.** The grant issuer was deleted and purged by
`npm run setup -- --delete-bootstrap --confirm` after the phase 6a live sitting; the command
reported both the delete and the purge, which is what actually ends a standing
`Sites.FullControl.All` rather than leaving the object restorable with its credentials for 30 days.
The throwaway probe application was confirmed absent by a client-credentials token request against
its own recorded id, which Entra refused with `AADSTS700016`, application not found in the
directory. That request is evidence of absence rather than of a bad secret, because 700016 names
the application rather than the credential. The server application remains, holding no more than
`Sites.Selected` with the `read` role on one site.

The two questions teardown exists to answer are now partly answered: the purge path ran and
reported success on a real tenant. Whether a service principal survives an application delete was
not separately checked, so that half stays open.

**Two seeder defects the sitting exposed, both fixed by the workbook-bytes-reader phase's task 9.**

The failure message blamed the wrong thing. `scripts/seed/workbook.ts` used to attribute a failed
range write to the bytes it uploaded, on the reasoning that this is the first call requiring Graph
to open the file as a workbook. The reasoning about call ordering was correct and the conclusion
was still wrong: the bytes were fine, confirmed by downloading them back and by opening them in
Excel for the web. The message named the one cause the code could not distinguish from the real
one, which is the message-audit failure this project has a whole spec section about. Fixed by
deleting the call rather than rewording the message: the range write, the number format call, the
table add and the table rename are all gone, along with every message attached to them, because
the whole populated workbook, table included, is now assembled in memory and uploaded once. There
is no second or third `/workbook/` call left for a failure to be misattributed to.

A workbook failure used to discard the execution report for work that succeeded. `runSeed` in
`scripts/seed-library.ts` called `executeSeed`, then `createSeedWorkbook`, and only then printed
`formatExecutionReport`. The tree was built, 121 folders and 143 files and roughly 264 Graph
requests of real work, and the operator was told nothing about any of it, only that the workbook
step failed. The count was recovered afterward by probing the library. Fixed by printing the tree's
own execution report as soon as `executeSeed` returns, before the workbook step runs at all;
`formatExecutionReport` no longer takes a workbook request count, since at the point it prints, the
workbook step has not observed one yet, and a separate `formatWorkbookReport` prints that count
once `createSeedWorkbook` actually returns it.

**What is still verified only against fakes.** Everything about the workbook, the reconciliation
engine's behavior on live data, the composed tool's output, and the whole write-tool surface,
which does not exist yet. The Microsoft Search cross-check is phase 2c and has not been started,
so both scans above correctly reported themselves as degraded.

**UPDATE 2026-09-17.** The workbook and the composed tool's output are no longer verified only
against fakes; both were exercised in "The second live tenant sitting, 2026-09-17" below. The
reconciliation engine's own correctness on live data still is not established, because that
sitting's expectation was computed by running the same engine over the same plan in memory, so the
two agree by construction on anything the engine gets wrong. The write-tool surface and the
Microsoft Search cross-check remain as described above.

**A second update, 2026-09-17.** The Microsoft Search cross-check is no longer phase 2c and
unstarted, and the claim that both scans above correctly reported themselves as degraded no longer
describes the current state of that check. See "The phase 2c live tenant sitting, 2026-09-17"
below. The write-tool surface is unaffected and remains as described above.

## BLOCKING: the Graph Excel API refuses app-only tokens, so phase 2b-1 cannot run as built

Found 2026-09-16, on the first live tenant sitting, by the seed command's workbook step. This is
the first finding in this project that invalidates a locked decision rather than a message or an
assumption, and it was unreachable by any fake: every Excel test to date has run against a fake
transport that answered as though the call had been accepted.

**What was observed.** `npm run seed-library --confirm` built the tree and uploaded the tracking
workbook, then failed on its first `/workbook/` call with 403 `AccessDenied` and the message
"Could not obtain a WAC access token." WAC is Office Online, which Graph delegates every
`/workbook/` call to.

Four application permissions were tested against the same file in the same tenant, each with an
admin-consented app-only client-credentials token, and each verified by reading the `roles` claim
off the token rather than by trusting the portal:

| Identity | Roles on the token | `GET /workbook/worksheets` | `GET` metadata | `GET /content` |
|---|---|---|---|---|
| Grant issuer | `Sites.FullControl.All` | 403 WAC | 200 | 200 |
| Server application | `Sites.Selected` | 403 WAC | 200 | 200 |
| Throwaway probe | `Files.Read.All` | 403 WAC | 200 | 200 |
| Throwaway probe | `Files.ReadWrite.All`, `Files.Read.All` | 403 WAC | 200 | 200 |

**What was ruled out, and how.** Not the uploaded bytes: the file was downloaded back and is a
valid xlsx, zip magic `504b0304`, carrying `[Content_Types].xml`, `xl/workbook.xml` and
`xl/worksheets/sheet1.xml`, and the operator opened it in Excel for the web, which rendered it.
Not the tenant lacking Office Online: that same interactive open proves WAC works there. Not a
write restriction: a plain read of `/workbook/worksheets` fails identically. Not an insufficient
SharePoint role: `Sites.FullControl.All` is the maximum and fails the same as `Sites.Selected`.

**The mechanism that explains every row above.** WAC issues its token for a user, and an
app-only token carries no user. No application permission can supply an identity that is not
there. Microsoft's Excel reference is consistent with this: it lists exactly two scopes,
`Files.Read` and `Files.ReadWrite`, which are the delegated spellings, and names no application
permission at all.

**What it invalidates.** The Decision Record's "Excel as a database" entry, and with it the whole
of phase 2b-1: the non-persistent session manager, the mapped range read, and
`readWorkbookSnapshot`. The reasoning recorded for non-persistent sessions is still sound on its
own terms; the problem is that no session of either kind can be opened by this server at all. The
reconciliation engine's second input therefore has no supplier, which blocks
`reconcile_workbook_vs_repository` end to end even though phase 4a wired it.

**UPDATE 2026-09-17.** The bytes-reader replacement (phase 2b-2, superseded section below)
supplies the reconciliation engine's second input without opening an Excel session, and
`reconcile_workbook_vs_repository` returned a report against a real library in "The second live
tenant sitting, 2026-09-17" below. The last clause above, that this blocks the tool end to end, no
longer holds; the rest of this finding, about the Excel API itself, is unaffected and still stands.

**What is not affected.** Everything that reaches a file rather than a workbook. Path addressing,
delta, the repository snapshot and `/content` download all work app-only under `Sites.Selected`,
confirmed live in the same sitting.

**DECIDED 2026-09-16: option 1, download and parse, with the rejection rule as a condition.**
The operator chose it on the day the finding was made. Option 2 was disqualified by the stateless
app-only model being itself a locked decision; option 3 was already rejected on 2026-09-11 and
nothing about that reasoning changed.

The condition is load-bearing and is part of the decision rather than an implementation detail.
Any mapped cell whose value cannot be read confidently from the bytes, a formula whose cached
result is absent or stale above all, must surface as a rejected row on the report. It must not
return a substituted value of any kind. Phase 2b-1 already built the rejected-row path and the
engine already carries a rejection onto the report, so this reuses existing machinery rather than
adding a mechanism. A parser that returns an empty string or a zero for an unevaluable cell
produces a wrong compliance finding with no error raised anywhere, which is the failure mode this
project holds to be the most expensive of all.

The replacement for phase 2b-1 is its own design session and has not been written. What is settled
is the direction and its condition, not the shape of the reader.

**Options as considered.**

1. Download the `.xlsx` through `/content`, proven to work app-only, and parse the bytes in
   process. Keeps `Sites.Selected` intact and adds no permission. Costs a parsing dependency and
   means reimplementing what Excel evaluates: shared strings, date serials behind `numFmt`, the
   table definition in `xl/tables/`, and cached formula results. A steelman of this option
   identified the failure mode that matters: a formula cell whose cached value is stale or absent
   yields a wrong compliance finding rather than an error. Any implementation must route such a
   cell to the existing rejected-row path rather than returning a value for it.
2. Give the server a delegated identity. Restores the Excel API exactly as designed and costs the
   stateless app-only model, which is itself a locked decision, plus a signed-in user whose token
   must be refreshed and whose conditional-access policies now sit in the request path.
3. Change where expected state comes from, for example a SharePoint list rather than a workbook.
   Rejected once already, on 2026-09-11, because requiring customers to restructure their live
   tracking workbook was judged unacceptable, and that reasoning has not changed.

## A tracking workbook inside the library it describes is always an orphan

Observed 2026-09-15, during the whole-branch review of the synthetic workbook seeding work, and
confirmed by running the reconciliation engine over the two snapshots that seed produces. This
is an observation for a human, not a decision taken here.

`examples/profiles/example.json` puts `identity.workbookPath` at
`/Trackers/Operational Tracking Workbook.xlsx`, inside the same document library the profile
describes. The scan enumerates the whole library and applies no exclusion for that path, so the
workbook is in the repository snapshot. Its name matches neither `naming.template` nor any of
the profile's recognizers, so the parser cannot read a client, deliverable or period out of it.
The engine therefore reports it as an orphan with `kind: "unrecognized"`, in every report, for
as long as the workbook lives there. Every layer is behaving exactly as designed; there is no
defect in any of them.

The consequence is a product-level one rather than a bug. A customer whose tracker sits in the
library it tracks gets one permanent orphan row that is not a finding and is not actionable, and
an operator reading the orphan list as a work list has to know to skip it. With one tracker that
is a footnote. It is worth deciding deliberately rather than discovering per tenant.

Three shapes a resolution could take, none chosen here. The profile accepts the finding and
whoever reads the report is told to expect it, which costs nothing and leaves the noise. Or the
profile gains a way to name paths the reconciliation ignores, which is a new profile field, a
change to the engine's inputs, and a new way for a real file to be absent from a compliance
report without anybody being told, which is the quiet incompleteness this engine exists to
prevent. Or the customer's workbook lives outside the library, which is an operational change
for them rather than a code change here, and is not always available.

What this branch did instead: `scripts/seed/expected.ts` predicts the orphan, so the expectation
`npm run seed-library` prints matches what the live tool will return, and the printed block says
in prose that the seeder's own workbook is the orphan it lists. That was the right move for a
branch whose scope was the seeder, and it settles nothing about the product question. Step 7 of
the phase 2a checklist above is where an operator meets this for the first time.

## SUPERSEDED: Phase 2b-1 covered only by fakes, 2026-09-14

**SUPERSEDED 2026-09-16 by the workbook-bytes-reader phase (commits `8827fd5` through `b242ab2`),
following from the BLOCKING finding above that the Graph Excel API refuses this server's app-only
tokens.** The Excel session layer this entry describes, `src/graph/excel.ts`, is deleted along
with its tests. Opening a non-persistent session, reading a table's range or a worksheet's used
range through it, retrying once on an expired session, and closing it are none of them things
this server does any more, or can do under the app-only identity model the Decision Record
requires. `src/workbook/read.ts` still turns a grid into records and rejections the way this
entry describes, but the grid now comes from parsing downloaded bytes rather than from a Graph
range read, and `readWorkbookSnapshot` in `src/scan/workbook.ts` is recomposed onto that path. See
the entry below for what is verified about the replacement.

Original entry follows, describing a layer that no longer exists, kept for the history of how
phase 2b was first built and then abandoned rather than as a current account of anything.

Phase 2b-1, the workbook snapshot, has not been run against a real tenant. No Excel call has been
made by this code, against a real workbook or otherwise. Everything below is verified against
fake Graph transports, and nothing more should be read into it than that.

**What is covered.** The Excel session layer in `src/graph/excel.ts`: opening a non-persistent
session, reading a table's range or a worksheet's used range, closing the session, retrying once
on a fresh session when a read 404s as an expired session, and propagating a second failure
without letting a failed close mask the read that already succeeded. The workbook reader in
`src/workbook/read.ts`: turning a grid of cells into records and rejections, rejecting rather
than skipping an unreadable client cell, and the missing-header message. `readWorkbookSnapshot`
in `src/scan/workbook.ts`, the composition root that resolves a drive and calls the range and
grid readers to produce a `WorkbookSnapshot`. All of it against fakes, all of it green, none of
it against a real Excel workbook or Microsoft Graph.

**Why the live run has not happened.** No session in this implementing session could open a real
Excel workbook through Graph; the fakes exist because a live workbook was never available to
read against. The live verification this phase needs is the synthetic tracking workbook
`npm run seed-library` now places in the site, in the same run that builds the synthetic library,
with a table whose headers match the example profile's workbook mapping. Reading that table
through a real, non-persistent Excel session is the first thing that would check the session
layer's retry and close behavior against Graph's actual responses rather than a fake's.

Until that run happens, this phase's session-layer behavior, its rejection handling, and the
snapshot assembly are known from reading the code and from tests against fakes only. None of it
has been proven by use.

## Phase 2b-2: covered only by fakes and hand-written fixtures, 2026-09-16

The workbook-bytes reader that replaced phase 2b-1, per the design at
`docs/superpowers/specs/2026-09-16-workbook-bytes-reader-design.md`, has not been run against a
real tenant or a real Excel-produced workbook either. Everything below is verified against
in-process fixtures, and nothing more should be read into it than that.

**RUN AGAINST A REAL TENANT 2026-09-17.** See "The second live tenant sitting, 2026-09-17" below.
The claim above was accurate when written. It no longer is: the bytes path downloaded a real
workbook from a real SharePoint library and the production parser read it. What it read was the
seeder's own generated bytes, not a workbook Excel itself produced, so the real-Excel-produced-
workbook half of the claim above still stands; the Task 8 fixture below remains the only thing
ever checked against bytes Excel wrote.

**What is covered.** `src/graph/content.ts`'s `downloadDriveItem`, following the driveItem
content redirect and dropping the bearer token before the second request, against a fake
transport. `src/workbook/zip.ts`'s `readZipParts`, refusing an archive whose declared inflated
size exceeds its cap by inspection, before inflating it. `src/workbook/cells.ts`'s `decodeCell`,
the rejection rule itself: a formula with no cached value, an error cell, and a cell whose cached
value is present but empty, all refuse rather than substitute. `src/workbook/sheet.ts`'s
`sheetToGrid`, building a grid from cells by their own reference rather than position, and, since
this branch's own whole-branch review, refusing a bounding box or a declared range whose area
exceeds a fixed cell cap before allocating it. `src/workbook/xlsx.ts`'s `parseWorkbookGrid`,
resolving a named table or worksheet through the workbook's own internal relationships and
failing the read when `fullCalcOnLoad` is set over a range holding a formula. `readWorkbookGrid`
in `src/workbook/read.ts`, unchanged in what it does, now fed by this path instead of a Graph
range read. All of it against fixtures, all of it green, none of it against a real Excel workbook.

**What the fixtures cannot show.** Every fixture the parser is tested against is hand-written XML
in this repository's own test files, and the seeder's bytes in `scripts/seed/blank-workbook.ts`
are hand-written too. The suite proves the reader agrees with what this repository believes Excel
emits, and nothing more: a wrong assumption shared by the reader and every fixture author would
pass every test here and still be wrong against a real workbook.

**DONE 2026-09-16.** Task 8 of the phase 2b-2 plan, a binary fixture Excel itself produced,
carrying a table, a formula, an `#N/A` and a date, is the artifact that would catch that, and it
has landed. See "Task 8 done, and two more findings from the same evening, 2026-09-16" below for
what it proved and what it did not. It no longer blocks live-run sign-off.

Original paragraph follows, describing Task 8 as outstanding, kept for history.

Task 8 of the phase 2b-2 plan, a binary fixture Excel itself produced, carrying a table, a
formula, an `#N/A` and a date, is the one artifact that would catch that. It has not landed;
`tests/workbook/fixtures/real-excel.xlsx` does not exist, and the operator has been asked for it.
This is a blocker on live-run sign-off, not on merge: the design explicitly scoped it as the one
task requiring a human-supplied artifact rather than something an implementing session could
produce itself.

**Why the live run has not happened.** The same synthetic tracking workbook `npm run seed-library`
places in the site is now written directly as bytes (`scripts/seed/workbook.ts`, using
`src/workbook/xlsx.ts`'s own `parseWorkbookGrid` to read its output back before upload) rather
than built through Graph Excel calls, since those calls are what phase 2b-1 proved unreachable.
Downloading that file and parsing it through `readWorkbookSnapshot` against a real tenant is the
live verification this phase needs, and it has not happened in any implementing session to date.

**RAN 2026-09-17.** It has now happened; see "The second live tenant sitting, 2026-09-17" below.
The sentence above, that it has not happened in any implementing session to date, no longer holds.

## Task 8 done, and two more findings from the same evening, 2026-09-16

**Task 8 is complete.** `tests/workbook/fixtures/real-excel.xlsx` exists, produced by Excel for
the web from a starter this repository generated, and `tests/workbook/xlsx.real.test.ts` pins the
production parser against it. A reviewer unzipped the file and checked each assertion against its
actual parts: a table named `ClientRoster` whose declared dimension is `A5:E7` resolves by name to
row offset 5, header cells stored as shared string references resolve through Excel's own
`sharedStrings.xml`, two cells Excel stored as `t="e"` with cached `#N/A` arrive as unevaluable
rather than as empty values, and two cells holding a shared formula with cached results arrive as
those results rather than being rejected. The file carries `docProps/app.xml`, `xl/calcChain.xml`
and `xl/sharedStrings.xml`, none of which this repository's own writers produce. This is the
paragraph in the Phase 2b-2 section above that named Task 8 as a blocker on live-run sign-off;
that claim no longer holds.

This is one workbook, and it settles less than a passing suite might suggest. It does not exercise
an Excel date serial, because the operator's date values stayed text in the file, so that branch
remains covered only by `excelSerialToIsoDate`'s unit tests. It says nothing about the live tenant
path, and `reconcile_workbook_vs_repository` has still never returned a report against a real
library.

**UPDATE 2026-09-17.** The last sentence above no longer holds.
`reconcile_workbook_vs_repository` has now returned a report against a real library; see "The
second live tenant sitting, 2026-09-17" below. The date-serial gap is unaffected: the workbook read
live was the seeder's own generated bytes, not one authored by Excel, so this remains the only
thing ever checked against bytes Excel wrote, and it still does not exercise a date serial.

**The seeder's production writer opens in real Excel.** `seededWorkbookBytes` in
`scripts/seed/blank-workbook.ts` produces a workbook that Excel for the web opens. Verified
2026-09-16 by generating a workbook with that function and having the operator open it in Excel,
edit it and save it. This closes a concern Task 9's implementer had raised and could not settle at
the time: the table XML was written to be well formed OOXML but had never been checked against
real Excel. It now has been. The limit is the same shape as Task 8's: this proves Excel opens and
rewrites the seeder's output, not that a seeded workbook has been read back from a tenant by the
reconcile tool.

**UPDATE 2026-09-17.** A seeded workbook has since been read back from a tenant by the reconcile
tool; see "The second live tenant sitting, 2026-09-17" below. This paragraph's own finding is
unaffected: it is still true, separately, that Excel itself opens and rewrites the seeder's output.

**The hand-written fixture builder produces files Excel refuses to open.** Found the same way.
`tests/workbook/xlsx-fixture.ts`, the test fixture builder the rest of the suite depends on,
produces files Excel reports as possibly corrupt or in an unsupported format when opened directly.
The cause is that it writes only the parts the parser needs, omitting `[Content_Types].xml`,
`_rels/.rels` and `xl/styles.xml`, all of which Excel requires. This is not a defect in that
builder: its job is exercising the parser rather than producing valid workbooks, and a parser
tolerant of minimal input is reasonable. It is recorded because it sharpens what the hand-written
fixtures in the Phase 2b-2 section above actually prove: they show the parser reads a reduced
shape this repository constructs, and that shape is not merely different from what Excel emits, it
is one Excel would reject. A green suite built only on those fixtures should be read with that in
mind.

## The second live tenant sitting, 2026-09-17

Run against the `helloironwright` developer tenant, site `IronwrightTest`, library `Documents`,
profile `profiles/synthetic.json`, on branch `phase-2b-2-workbook-bytes-reader`, with the suite at
1555 tests across 108 files and all gates green. This is the sitting the runbook above, and the
BLOCKING, Phase 2b-2 and Phase 4a sections, have been waiting on since 2026-09-16.

**Step 3, the seeder, completed for the first time.** `npm run seed-library --confirm` processed
121 folders and 143 files in 266 Graph requests, then replaced the tracking workbook in **2** Graph
requests. The previous implementation needed five calls through the Graph Excel API and could not
complete any of them; that is the BLOCKING finding above. Elapsed 63712 ms. The execution report
printed before the workbook step, which is the ordering fix task 9 made, recorded in "The first
live tenant sitting, 2026-09-16" above.

**Steps 5 and 6, the scan.** An incremental scan reported 145 files and 122 folders in 3 Graph
requests over 1 delta page, applying 267 changes with 4 write operations, against the Azure Table
store running on Azurite.

**Step 7 ran, for the first time in this project's history.** `reconcile_workbook_vs_repository`
was called over Streamable HTTP against a running server and returned a report. `isError` false,
2003 ms, 3 Graph requests for the call. The workbook was read through the new bytes path,
provenance `"/Trackers/Operational Tracking Workbook.xlsx#ClientRoster in Documents"`, scan mode
incremental, not resynced.

**The comparison against the expectation the seeder printed.** Every count matched except one:

| | predicted | live |
|---|---|---|
| clients | 13 | 13 |
| artifacts | 156 | 156 |
| non-compliant | 14 | 14 |
| empty folders | 1 | 1 |
| duplicates | 0 | 0 |
| rejected workbook rows | 0 | 0 |
| orphans | 1 | 2 |

The non-compliant rows matched exactly: Client04 one missing, Client09 one misnamed, Client13
twelve missing.

The orphan difference is explained and was arranged deliberately, not a discrepancy. A file named
`starter.xlsx` had been left in the library root earlier that evening, from the work that produced
the Task 8 fixture above. Neither the seeder nor the engine had any knowledge of it, and it was
correctly reported as a second unrecognized orphan. That is orphan detection working on a file
genuinely unknown to the profile, not on one the fixture anticipated.

**Also observed: the write gate hides write tools.** The server registered seven tools rather than
ten. `IW_ALLOW_WRITES` was unset, and `selectTools` in `src/tools/registry.ts` filters tools of
kind `write` when writes are disabled. The three absent tools were exactly `execute_rename_plan`,
`execute_move_plan` and `replicate_template`. The two plan generators, `generate_rename_plan` and
`generate_move_plan`, stayed visible, because they are kind `plan` rather than `write`. This is the
first live confirmation of the outer layer of the two-layer write gate, and of the decision record
that there are three tool kinds rather than two.

**The gate's other position, observed 2026-09-19.** The phase 6a sitting was the first run of this
server with `IW_ALLOW_WRITES=true`. What that run establishes about the outer layer is narrow:
`generate_rename_plan` and `execute_rename_plan` were both reachable through the transport and both
executed, so a tool of kind `write` is advertised when writes are enabled. Nobody recorded how many
tools the registry advertised under that setting, so this file states no count, and the
write-enabled listing has not been checked tool by tool the way the read-only listing above was.

**What this does and does not establish.** It establishes that the composed tool returns a correct
report against a real library, through real Graph, a real downloaded and parsed xlsx, and real
Azure Table Storage via Azurite; that the Excel-free seeder produces a workbook this server can
read back; and that the write gate hides write tools. It does not establish that the reconciliation
engine is correct. The expectation was computed by running the same engine over the same plan in
memory, so the two agree by construction on anything the engine gets wrong. What a match checks is
the layers a fake cannot reach: Graph, the xlsx parser, Azure Table Storage, and the tool's own
composition. It also does not cover the Microsoft Search cross-check, which is phase 2c and
unstarted, so the report correctly declared itself degraded. Azurite is not Azure Table Storage
proper.

**UPDATE 2026-09-17, from the phase 2c sitting.** The Microsoft Search cross-check is no longer
phase 2c and unstarted, and a report from this branch is no longer necessarily degraded on that
account. See "The phase 2c live tenant sitting, 2026-09-17" below. The rest of this paragraph is
unaffected: the reconciliation engine's own correctness is still not established by this sitting,
and Azurite is still not Azure Table Storage proper.

**Step 9, the teardown, still has not run.** The grant issuer and the server application are both
still live in the tenant and both still issue tokens, verified 2026-09-17. The two questions
teardown exists to answer, whether the purge really empties **Deleted applications** and whether a
service principal survives an application delete, remain unanswered.

This sitting updates several claims made before it, listed here rather than left to be inferred
from silence: the "Step 7 did not run, and cannot" paragraph and the "What is still verified only
against fakes" paragraph in "The first live tenant sitting, 2026-09-16" above; the last clause of
"What it invalidates" in the BLOCKING section above; the section framing and the "Why the live run
has not happened" paragraph in "Phase 2b-2: covered only by fakes and hand-written fixtures"
above; the last sentence of "The seeder's production writer opens in real Excel" and of "Task 8 is
complete" in "Task 8 done, and two more findings from the same evening" above; and the framing and
the "Why this matters beyond the usual disclaimer" paragraph in "Phase 4a: covered only by fakes,
2026-09-14" below. Each has its own dated update note at its location rather than being edited
away.

## The phase 2c live tenant sitting, 2026-09-17

Run against the `helloironwright` developer tenant, site `IronwrightTest`, profile
`profiles/synthetic.json`, on branch `phase-2c-search-cross-check`, with the suite at 1635 tests
across 113 files and all gates green. This is the first live run of the Microsoft Search
cross-check, run deliberately before merging, which is the sequence phase 2b-1 skipped.

**Setup.** A second document library named `Archive` was created on the site through Graph, using
the grant issuer, because the server application is read-only by design. `identity.searchRegion`
was set to `NAM` in the profile. Two perturbations were made against `Documents`.
`2026/Client01/02-February/2026-02_Client01_MonthlyTraining.xlsx` was moved into `Archive` at the
identical library-relative path and deleted from `Documents`.
`2026/Client02/02-February/2026-02_Client02_MonthlyTraining.xlsx` was copied into `Archive` at the
identical library-relative path and left in `Documents`. The second case was added deliberately: it
is the input the whole-branch review found would erase the local file, because both copies then
occupy the same library-relative path.

**Result, once the Search index caught up.** The cross-check completed, `searchCrossCheckIncluded`
true, no skip reason, costing 1 Graph request while the inventory scan's own count stayed at 3.

Client01's February artifact moved from `missing` to `misplaced`, with `matched.library` equal to
`Archive`. That is the phase's whole purpose, working against a real tenant. The report names the
library in prose: "1 listed finding was found in another document library rather than the profile's
own: Archive".

Client02 stayed `compliant` with 12 compliant artifacts, despite an `Archive` copy at the identical
relative path whose timestamp was newer, since it was uploaded later. Before the dedupe fix that
copy would have superseded and erased the local file. The fix is proven on live data.

The `Archive` copy was reported as 1 duplicate, not as an orphan. Orphans stayed at 2, the tracking
workbook and `starter.xlsx`, both in the profile's own library. The `Archive` tree contributed no
orphans of its own. The rule that makes this tool usable at a customer with more than one library
holds live.

The matched file carries `etag: ""`, which is the documented consequence of Search returning no
eTag, and is harmless because a local and a foreign file at the same path are no longer compared.

**A defect the live run found, and the most important thing recorded in this section.**
`listDrives` returns a drive `webUrl` that is percent encoded, while a search hit's `webUrl` is
not:

```
drive:  https://helloironwright.sharepoint.com/sites/IronwrightTest/Shared%20Documents
hit:    https://helloironwright.sharepoint.com/sites/IronwrightTest/Shared Documents/2026/Client02/...
```

`relativePathWithinLibrary` stripped the drive URL as a literal prefix, so for any library whose
name contains a space the prefix never matched, every hit was skipped, and the cross-check reported
itself complete having found nothing. It fails safe: nothing errored and nothing warned. `Shared
Documents` is the default name of a SharePoint document library, so this would have hit most real
customers on the most common library name, and the symptom would have been a feature that silently
did nothing.

No test could have caught it. Every fixture builds both URLs itself, so both sides agree by
construction. The live site's second library is named `Archive`, with no space, which is why the
run that exposed the mismatch did not also fail on it. Fixed in commit `2461d6c`, by comparing path
segments after decoding each one.

**A second suspicion, ruled out by evidence.** The same fix raised a concern that the `path:` KQL
scope might also need the unencoded form, and named it the likely cause of the symptom. That was
tested directly against the live index using the `Documents` library, which has a space in its URL
name and 144 indexed files. The encoded form returned 144 hits and the decoded form returned 144
hits. Both are accepted. The scope was never broken, and the concern is closed by measurement
rather than left standing as a suspicion.

**An operational fact, worth recording as a product property rather than a defect.** Search
indexing took approximately seven minutes. The first reconcile after the move reported the artifact
as `missing`, and was correct to: the cross-check completed against an index that did not yet
contain the file. A customer who moves a file and immediately runs a report will see the same
thing.

**A process hazard, worth one line.** The first attempt to call the tool was answered by a stale
server left listening on port 3000 from an earlier sitting, running pre-phase-2c code. It reported
that the cross-check did not run, using wording this branch had already replaced. The new server
had failed to bind with `EADDRINUSE`, and its exit code was the only signal available. A conclusion
drawn from that response would have been confidently wrong.

**What this run establishes, and what it does not.** It establishes, against a real tenant and a
real Search index, that a file moved to a second library is reported `misplaced` with the correct
library named; that the dedupe fix preventing a foreign copy from erasing a locally present file
holds on live data; that a foreign-library file at a colliding path is counted as a duplicate
rather than an orphan; that a second library contributes no orphans of its own; and that the drive
`webUrl` versus search hit `webUrl` encoding defect above is real and is fixed. It does not
establish anything about a library holding more results than the page cap, about a search failing,
about a library listed without a `webUrl`, or about behavior at scale. This run exercised one site
with two libraries, one moved file, and one copied file, and no more than that should be read into
it.

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
behind --confirm", refined by `afbfd97`.** `runDeleteBootstrap` now purges the grant issuer from
the tenant's deleted items after a confirmed delete, reusing `purgeDeletedApplicationWithRetry`
and its replication-lag retry unchanged from `runDeleteServerApp`, exactly as this item's own
closing paragraph proposed. Because purging is irreversible in a way the delete alone is not,
`--delete-bootstrap` now also defaults to a dry run and needs `--confirm` to act, matching
`--delete-server-app`; every operator-facing message that names this command, including the
normal run's own grant-issuer-teardown note and `docs/SETUP.md`, was updated so it names
`--confirm` rather than pointing at an invocation that would now only preview. Review caught that
the first pass left the delete's own 404 unguarded, reporting failure and skipping the purge on
exactly the run most likely to need it; `afbfd97` fixed that by mirroring
`runDeleteServerApp`'s own `applicationDeleted` handling. Not verified against a live tenant; see
this file's live-testing entries above for what has and has not actually been exercised.

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

## Phase 4a: covered only by fakes, 2026-09-14

Phase 4a, the tool execution layer and `reconcile_workbook_vs_repository`, has not run against a
real tenant. No Graph call, no Excel call and no Azure Storage call has been made by this code.
It composes three layers that are each themselves verified against fakes only: phase 2a's Graph
and scan layer, phase 2b-1's Excel and workbook layer, and phase 3's reconciliation engine. A
report this tool produces is exactly as unproven as those three inputs, and nothing in this slice
changes that.

**UPDATE 2026-09-17.** `reconcile_workbook_vs_repository` has since run against a real tenant and
returned a report; see "The second live tenant sitting, 2026-09-17" above. The claim above, that
no Graph call, no Excel call and no Azure Storage call had been made by this code, described the
state through 2026-09-16 and no longer holds. What the "What is covered" list below still describes
accurately is the unit-level test coverage; the tool composition as a whole has now been exercised
live exactly once, which is a single data point, not a suite.

**What is covered.** The handler contract and dispatch in `src/mcp/build-server.ts`. The profile
registry's validation, duplicate-`profileId` detection, and unknown-id message, in
`src/profiles/registry.ts`. The scan coordinator's join behavior, its zeroed Graph cost for a
joiner, and that a failed scan does not poison its key, in `src/scan/coordinator.ts`. The output
shaping's omission and truncation rules and the `clients` filter, in
`src/tools/reconciliation/shape.ts`. The text block, asserted sentence by sentence against a
shaped output that contradicts it. The failure-to-message mapping in `src/tools/errors.ts`. All
of it against fixtures or a fake Graph transport, all of it green, none of it against Graph,
Excel, or Azure Table Storage.

**Why this matters beyond the usual disclaimer.** The tenant sitting that phase 2a and phase
2b-1 are both waiting on now gates a third thing: whether the composed tool returns a report at
all. Until that sitting happens, the claim that a caller can ask this server a compliance
question and get a real answer is a design argument, not evidence.

**UPDATE 2026-09-17.** That sitting happened. The composed tool returned a report against a real
library; see "The second live tenant sitting, 2026-09-17" above. The claim that a caller can ask
this server a compliance question and get a real answer is no longer only a design argument. It is
still not evidence that the answer is correct: see that section's own statement of what the match
does and does not establish.

## The cross-replica scan coordination gap

`ScanCoordinator` (`src/scan/coordinator.ts`) is a process-lifetime map keyed on `profileId`. It
stops two concurrent calls within one replica from racing a delta resync, where `runScan` clears
the inventory and re-enumerates and a concurrent call reading `listInventory` inside that window
would report every file in the library as missing. It coordinates within a replica and not
across them, because the map lives in the process's own memory.

Two replicas can both resync the same drive at the same time, and a call landing on either one
can read a half-rebuilt inventory and report every file as missing, which is the exact failure
the in-process coordinator exists to prevent, just at a scope it cannot see. Hosting stays at one
replica, consistent with the existing Decision Record entry, until phase 5 decides this.

The option that fixes it at any replica count is a lease held in Azure Table, with renewal,
expiry, and crash recovery, plus a matching implementation in the in-memory store used by tests
and local runs. That is genuine distributed-systems work, and it was judged too much for a slice
whose job was wiring one tool end to end, not building a distributed lock. Settle it when phase 5
decides how many replicas this server actually runs.

## Settled by observation: an `isError` result is exempt from output-schema validation

The design spec for phase 4a's tool wiring deliberately refused to assume the answer to this:
does a tool that declares an `outputSchema` and returns `{ isError: true }` with no
`structuredContent` fail output-schema validation? Settled by experiment rather than by
assumption, against the installed `@modelcontextprotocol/sdk` **1.30.0**, confirmed from
`node_modules/@modelcontextprotocol/sdk/package.json` rather than from the `^1.30.0` range in
`package.json`: it does not fail. The SDK exempts an `isError` result from output-schema
validation entirely.

This is an early return in the installed SDK's source
(`dist/esm/server/mcp.js`: `if (result.isError) { return; }`, ahead of the branch that would
otherwise throw on missing `structuredContent`), not a documented guarantee. It was checked
against being a false positive, not merely observed: a non-`isError` result that fails
validation comes back with the SDK's own text replacing the handler's, so a green assertion that
the handler's own message survived is evidence the exemption ran rather than evidence the SDK
substituted its own error for a different one. `tests/mcp/build-server.errors.test.ts` pins the
observed behavior. An SDK upgrade must re-run that test before relying on the exemption again; if
it ever stops holding, the recorded fallback is a discriminated output schema whose error branch
is valid.

## CLOSED: a failed startup reported success and exited zero

**CLOSED 2026-09-14 by `49fa1e7`, "fix(server): suppress the startup line when the port was
never bound".** Found while building `src/server/main.ts` into phase 4a's composition root.
Express 5.2.1's `app.listen` wraps the listen callback in `once()` and also registers it as
`server.once("error", done)` (`node_modules/express/lib/application.js`, lines 598 to 606), so a
bind failure invokes the success callback with the error rather than skipping it, unlike a plain
`http.Server`, which never calls that callback at all on a failed bind. Measured against an
occupied port before the fix: the success line printed, no error line printed, and the process
exited **0**. A container that never bound its port would have reported itself healthy to the
platform about to route traffic to it.

Fixed on this branch. The listen callback now returns early unless `server.listening` is true, so
the success line is never printed falsely instead of being printed and then contradicted. A
separate `error` listener distinguishes a startup failure, which sets `exitCode = 1`, from a
post-listen error such as an accept failure, which must not claim the server is exiting, since it
is still running.

This is unpinned by any test. `src/server/main.ts` is a composition root with no test seam by
design, so its correctness rests on the real runs recorded against the built server rather than
on a suite. An express upgrade should re-check this mechanism by hand, against the file and line
range above, before trusting it again.

## CLOSED: the no-dash style rule was undocumented and unenforced until this branch

**CLOSED 2026-09-14.** Found during review of Task 9's documentation pass. This slice's own task
framing asserted that CLAUDE.md's working agreement already stated the no-dash rule and that a
hygiene test already enforced it across every tracked text file. Neither was true. Before this
branch, CLAUDE.md said nothing about dashes at all. The rule appeared only in executed-plan
documents, which CLAUDE.md itself classes as history rather than as a live reference, and the
rule was enforced by no test:
`tests/source-hygiene.test.ts` had exactly two cases, one confirming files exist to check and one
checking each tracked text file for a NUL byte. Nothing anywhere checked for a dash.

Two things were fixed together, because a committed test enforcing a rule written down nowhere in
the repository is worse than either gap alone. CLAUDE.md's Non-Negotiable Engineering Principles
now state the rule beside the existing emoji and US English line: this repo's prose avoids em
dashes and en dashes, including inside string literals. `tests/source-hygiene.test.ts` now adds
one case per tracked text file, reusing the same `git ls-files -z` listing the NUL-byte check
already builds, asserting the file contains neither an em dash (U+2014) nor an en dash (U+2013).
Of 196 tracked text files matching the suite's own pattern, exactly two are exempt by name:
`competitive-landscape.md` and `iw-mcp(research).md`, both imported research source material that
predates the style rule and that CLAUDE.md itself describes as an input to this project rather
than as its own prose. Every other tracked text file was already clean, so closing the gap needed
a rule to point the check at and a check to enforce the rule, not a rewrite pass.

The separate emoji rule, "No emojis or icons anywhere," has no test behind it. A correct check
needs a character range confident enough to avoid both a miss, a genuine emoji the range does not
cover, and a false flag, an ordinary symbol or CJK character the range wrongly catches, once
variation selectors, zero-width-joiner sequences, and skin-tone modifiers are accounted for. That
is more than a few lines to get right with confidence, so it was left open rather than shipped as
a check nobody can vouch for.

## Phase 4b: what the unit tests cover, 2026-09-17

Phase 4b wired `inventory_tree`, `query_repository` and `validate_structure` onto the execution
layer phase 4a built, on branch `phase-4b-read-tools`, with the suite at 1800 tests across 126
files when the eight tasks finished and 1821 across 127 after the whole-branch fix wave of
2026-09-18, all gates green at both points.

**This section was written before the live sitting and is kept as it was, minus one sentence that
is no longer true.** It read "No call this phase's own code makes has reached a tenant," which was
correct on 2026-09-17 and false from 2026-09-18, when all three tools ran against the live site:
see "The phase 4b live tenant sitting, 2026-09-18" below, which is the record. Correcting it in
place rather than appending a line, because this is the document a reader consults to decide what
counts as evidence, and a false sentence about evidence here is worse than in any other file. Every
layer this phase composes was also verified live in an earlier phase: the Graph and scan layer from
2a, the workbook bytes reader from 2b-2, the cross-check from 2c, and the reconciliation engine from
phase 3. That never transferred to this phase's own code, which is why the sitting was owed and
why what follows describes fakes.

**What is covered.** Per tool: the handler's own input validation, the run composition against a
fake Graph transport and the in-memory `StateStore`, the shaping module's truncation and omission
arithmetic asserted at and either side of its cap, and the text module asserted sentence by
sentence against a shaped output chosen to contradict a naive reading. Across the registry: the
existing contract test over all ten tool definitions, which now bans a top-level refinement on a
tool's input schema outright rather than requiring such a tool to document its constraint, and
separately requires a tool that sets `inputConstraints` to repeat that text in its own
description. `query_repository`'s
zero-request claim has its own test, asserting the fake transport issued no request for any of the
three questions and that a profile with no stored inventory fails rather than returning an empty
result. All of it against fakes, all of it green, none of it against Graph or Azure Table Storage.

**The MCP SDK cannot advertise a refined input schema.** Measured against the installed
`@modelcontextprotocol/sdk` **1.30.0**, confirmed from
`node_modules/@modelcontextprotocol/sdk/package.json` rather than from the `^1.30.0` range in
`package.json`: `registerTool` accepts a `ZodEffects`, the type `.refine()` and `.superRefine()`
produce, without throwing, but `listTools` then advertises that tool's input as
`{ type: "object", properties: {} }`, so every field disappears from what a caller, human or
model, actually sees. Call-time validation still enforces the refinement; only the advertised
schema is empty. The cause is the SDK's `normalizeObjectSchema` detecting an object schema by a
bare `.shape` property, which a `ZodEffects` keeps on `.innerType()` instead of exposing directly.
A top-level refinement is therefore now banned by the contract test, and a characterization test
in `tests/mcp/build-server.test.ts` pins the observed behavior, so a future SDK version that fixes
this will fail that test and say so, rather than the fix going unnoticed. Two routes are still
open for the next tool that needs a cross-field constraint: enforce the constraint inside the
handler's own parse rather than in the advertised schema, or advertise the plain object and parse
call-time input with the refined one. Phase 6 turned out not to need either: phase 6b-1 dropped
`generate_move_plan`'s `scope` and `scopeValue`, the pair that motivated this entry, on 2026-09-24. This is recorded as a defect of the
installed SDK version, not a permanent property of the protocol, which is why the version is
named rather than left implicit.

**A silent-versus-loud divergence still open in the state store.** `getScannedDrives` now
validates its profile id in both implementations. `getDeltaLink`, `setDeltaLink` and
`getLastScanAt` do not. In `src/store/memory.ts` the in-memory implementation always builds its
key through `inventoryPartitionKey`, which throws `UnsafeKeyError` for a malformed profile id, so
those three methods throw too. In `src/store/table.ts` the Table implementation passes the
profile id straight through as a partition key: a read answers `undefined` for a malformed id
exactly as it would for one simply never scanned, and `setDeltaLink` silently writes under an
unsafe partition key rather than refusing it. `clearInventory`, `applyInventoryChanges` and
`listInventory` are already consistent with each other on this point. This is pre-existing,
untouched by this phase, and unreachable today only because every caller passes an id off an
already-validated `Profile`. It is recorded here as an open item rather than fixed, because fixing
it is outside this phase's scope and the reasoning for leaving it needs to survive alongside the
gap itself.

**`query_repository` narrowed a published contract.** Its `question` enum
(`src/tools/query/output.ts`) went from five values to three: `empty_folders`,
`naming_violations`, `recent_reports`. `orphaned_files` and `non_compliant_clients` were removed
because answering either needs expected state, which means the workbook, which means a Graph
download, which would either cost the tool its zero-request promise or give the repository a
second tool deciding whether a client is compliant. The Decision Record makes `reconcile` the
single public entry for exactly that reason, so both removed questions stay where the evidence
for them already lives: both remain answerable through `reconcile_workbook_vs_repository`. This
is a deliberate narrowing of a published contract, not an oversight discovered later.

**`validate_structure` checks conformance, not completeness.** It cannot check that every folder
a client requires exists, because that depends on which deliverables the client owes, a workbook
field this tool deliberately never reads: a taxonomy segment can carry a `{deliverable}`
placeholder, and rendering every deliverable in the profile against every client would report a
client non-compliant for folders it never owed, a confidently wrong verdict of exactly the kind
this project treats as its most expensive failure. `missing` is reachable only for a client named
explicitly in the `clients` argument; with the argument omitted, the client list comes from the
folders present, so a client with no folder cannot appear in the input and cannot be reported
missing. Without a workbook there is no authority on who should exist, and inventing one from the
repository's own folders would be the tool asserting something it cannot observe. Completeness
stays with `reconcile`, which holds the workbook.

**`describe_workbook` is deferred to phase 4c, and its stub carries a defect.** Its input schema,
`src/tools/definitions/describe-workbook.ts`, takes a `siteUrl`, but this server holds
`Sites.Selected` on one named site and cannot read any other, so the schema promises reach the
permission model forbids. The schema was written in phase 1, before the identity decision
hardened, and nothing in phase 4b touches it. 4c owns the correction, most likely replacing
`siteUrl` with a `profileId` or dropping it and taking the granted site from configuration.

**`query_repository` could read a torn inventory, and the residual window it leaves. Fixed
2026-09-18 by the whole-branch fix wave.** `loadSnapshot` read `getScannedDrives` and
`listInventory` directly, the only tool in this codebase reading the inventory without going
through `ScanCoordinator`, which exists for exactly that window. `runScan` answers a delta resync
by clearing the inventory and re-enumerating and persists the new `lastScanAt` only at the end,
and `ToolContext` is per process, so a concurrent `inventory_tree`, `validate_structure` or
`reconcile` resyncing while this tool read would have had it answer from a cleared or half-rebuilt
inventory and stamp the answer with the previous scan's timestamp. That is the substitution
`NeverScannedError` refuses, arriving from the side it does not guard.

The coordinator gained two methods. `settle` awaits a scan already in flight for the profile and
reports whether it failed, and `scansStarted` is a monotonic per-profile count of scans started.
`loadSnapshot` reads the baseline count before calling `settle` at all, not after: `settle`'s own
`await` is itself a microtask checkpoint, and a scan can start inside it, either while this call is
waiting on one already in flight or in the gap after that scan clears from the coordinator's map
but before `settle`'s continuation resumes. A baseline taken after that await would already count
such a scan, and the guard would then compare the counter to itself. `loadSnapshot` settles next,
refuses outright when the scan it waited for failed, since a scan that fails after its resync has
cleared the inventory leaves a store that looks exactly like a smaller library, and then takes a
second reading after its two store reads. A count that changed between the baseline and that second
reading means a scan began somewhere in between, whether during `settle` itself or during the reads
that follow it, and that too is a refusal rather than an answer. Neither method calls Graph, so the
tool's zero-request property is intact.

What that leaves open is worth stating plainly, because "fixed" here means fixed within one
replica. The counter now closes the in-replica window completely: a scan that starts and finishes
anywhere between the baseline read and the second reading, including entirely inside `settle`
itself, still increments the monotonic counter and gets caught. It cannot see a scan run by another
replica against the same Table Storage, nor one run by the `scan` CLI, which calls `runScan`
directly and is outside any coordinator. Both are the same one-replica constraint this file already
carries for the coordinator itself, and neither is detectable from inside this process. A second
replica makes `query_repository` silently racy again, so the minimum-one-replica constraint is load
bearing for correctness and not only for the delta link.

The interleaving is exercised rather than asserted. `tests/tools/query/concurrency.test.ts` drives
the real coordinator and the real in-memory store against the real handler, with a scan fake that
clears and rebuilds in the order `runScan` does, and records what the store actually held at the
moment the handler reached it, so a pass means the race was live. Three of its first four cases
fail against code with no settle-and-counter mechanism at all; the fourth is the control that must
keep passing regardless. A fifth case drives the interleaving those four cannot reach: a scan that
starts inside `settle`'s own microtask checkpoint, after the underlying wait has already resolved
but before `loadSnapshot` resumes. It fails against a coordinator that has the counter mechanism
but reads the baseline after `settle` rather than before, and passes once the baseline read moves
ahead of that `await`.

**The live sitting this phase still owes.** This phase is covered by fakes until it has run
against a tenant, and the branch does not merge until it has. Against the existing seeded
library: call `inventory_tree` with and without a `subPath` and confirm the totals match the
seeder's own counts; call `query_repository` three times and confirm zero Graph requests on each
and a failure before any scan has run; call `validate_structure` with and without `clients` and
confirm the verdicts match what the seeded tree actually contains, including a named client that
does not exist. **All three checks ran on 2026-09-18; the dated record follows below.**

## The phase 4b live tenant sitting, 2026-09-18

All three checks ran against the live site, through the MCP transport and a per-request
`McpServer` rather than by calling handlers directly, so the sitting exercised the same path a
Copilot Studio connection would. The store was emptied first, which is what let the
never-scanned check be genuine rather than arranged.

**`query_repository` refuses before any scan has run.** Against a profile with no stored
inventory it returned `isError` with "Profile "synthetic" has no stored inventory to query yet.
Run inventory_tree or reconcile_workbook_vs_repository first, either of which populates the
index this tool reads from." It did not return zero findings. That distinction is the reason
the failure exists: zero findings and no evidence are different answers.

**`inventory_tree` reproduced phase 2a's measurement through the tool.** A cold call returned
144 files and 122 folders in **4 Graph requests**; every later call cost **3**. Those are the
numbers the CLI produced on 2026-09-16, now measured through the tool layer.

**The sub-path filter holds on live data, including the trap.** `2026` returned 142 files and
121 folders, `2026/Client01` returned 11 files and 10 folders, and `2026/Client0` returned
**nothing at all**. The last one is the check that mattered: a prefix comparison would have
matched every client from Client01 to Client13 and returned almost the whole library. This
repository has shipped that defect twice under other names, and the segment-boundary test is
now confirmed against a real tree rather than against fixtures that agree with it by
construction.

**`query_repository` costs nothing, measured rather than claimed.** All three questions
returned `graphRequests: 0` against a populated index. This is the phase's headline claim and
the thing evaluation question 8 exists to measure.

**`validate_structure` matched the tree.** With no `clients` argument it evaluated the 12 client
folders present and found all 12 compliant, in 3 Graph requests. With
`["Client01","Client02","NoSuchClient"]` it returned 2 compliant and 1 missing, naming
`NoSuchClient`. `missing` appeared only for the client the caller named, which is the rule the
tool is built on.

**The counts cross-check.** 144 files in the library, 142 under `2026/`, and exactly 2 naming
violations. The two violations are the two files outside any client folder, which is why every
client folder is compliant while the violations are real. Three tools agreeing on the same tree
from three different directions is worth more than any one of them agreeing with a fixture.

### The sitting found a defect the suite could not

`recent_reports` applied `RECENT_REPORTS_LIMIT` inside its own answerer, before the shaping layer
computed totals. Against this library it reported:

    Found 50 findings for this question.
    Listing every finding counted above, 50 in all.
    listing: {"returned":50,"omitted":0,"cap":200,"truncated":false}

Roughly 92 parsing files had been dropped by a cap the response never mentioned, and the listing
declared nothing omitted. That is this phase's own binding rule broken, the one requiring totals
over the complete set before truncation and an omission always stated, and it is the project's
named defect: a message correct on its own and wrong about what the program did.

No fixture could have caught it. Every test fixture in the suite has fewer parsing files than the
cap, so the cap never engaged in a test. It took a library with 142 of them.

Fixed before merge. The same call now reports 142 findings, lists 50, states that 92 were left
out, names the cap that actually applied as 50 rather than the 200 that did not, and says plainly
that this tool takes no argument that would return the rest. The two other questions were checked
and were already honest, because neither slices.

### What this sitting does not establish

One site, one library, one profile, 144 files. It says nothing about a library large enough to
exceed `MAX_INVENTORY_ITEMS`, about a client with more non-conforming files than
`MAX_CLIENT_DETAIL`, about a taxonomy other than this one, or about behavior under concurrency
against real storage. The concurrency guard added for the branch review's Critical is covered by
a deterministic test against the real coordinator and the real in-memory store; it has not been
exercised against Azure Table Storage with two callers racing, and the cross-replica window
remains open by design and is recorded above.

## Phase 4c: what the unit tests cover, 2026-09-18

Phase 4c wired `describe_workbook`, the last of the five read tools, on branch
`phase-4c-describe-workbook`.

**This section was written before the live sitting and is kept as it was, minus the claims that are
no longer true.** It read "No call this phase's own code makes has reached a tenant, and nothing
on the branch claims otherwise," which was correct when it was written and false later the same
day, when both modes of the tool ran against the live site: see "The phase 4c live tenant sitting,
2026-09-18" below, which is the record. Correcting it in place rather than appending a line, for
the reason the phase 4b section gives. What follows describes what the unit tests reach.

Two halves of an earlier draft of this paragraph overstated what the phase inherits, and both are
corrected here. It said the phase reuses a drive-download path phase 4a and 4b already exercised
live: only 4a did, since 4b resolves a drive and never downloads content from it. And it credited
the granted-site configuration to those phases as well, which it cannot: 4a and 4b resolve a site
from a profile's own `identity.siteUrl`, and resolving one from `IW_SITE_URL` at startup is a
different mechanism, new on this branch, that had never run anywhere when this was written. What
this phase genuinely inherited from an earlier live run is `resolveDrive` and `downloadDriveItem`
as phase 4a exercised them. The enumeration, header-detection and column-description logic is new
to this codebase and none of it had been proven by use at that point.

**What is covered.** `loadGrantedSiteUrl` in `src/config.ts`, present or absent
(`tests/config.test.ts`). The profile registry's new site-mismatch refusal, a profile whose
`identity.siteUrl` disagrees with the configured site failing by name at startup rather than
loading clean (`tests/profiles/registry.test.ts`, `tests/profiles/registry.errors.test.ts`).
`readWorkbookInventory` in `src/workbook/introspect.ts`: worksheet and table enumeration read
from each part's own declared dimension or ref rather than a built grid
(`tests/workbook/introspect.test.ts`). An earlier draft of this line claimed every unresolved-sheet
and unresolved-table shape was covered, and the whole-branch review disproved it: a declared sheet
whose `r:id` the rels part does not define was reaching neither `sheets` nor `unresolved`, so no
test could have covered a shape the code did not produce. The fix wave of 2026-09-18 made the three
sheet-list rejections first class, split the table reason so a table owned by a declared but
unresolvable sheet is not told its sheet is undeclared, and added one regression test per shape
plus a fixture flag that can omit a single workbook relationship. Covered now: all three sheet-list
rejections, the missing worksheet part, and all three table reasons.
`detectHeaderRow` in `src/workbook/describe.ts`: an unambiguous candidate, no candidate at all,
and the tie that must decline rather than guess (`tests/workbook/describe.header.test.ts`).
`describeColumns`: every inferred type, the non-empty and unevaluable counts, the distinct-value
count, the sample cap and its omitted count, and the withheld-samples path
(`tests/workbook/describe.columns.test.ts`). The tool's own composition root,
`runDescribeWorkbook` in `src/tools/describe/run.ts`, against a fake Graph transport and
hand-built xlsx fixtures for both modes, the unknown-source self-correction, and the
`fullCalcOnLoad` withholding (`tests/tools/describe/run.test.ts`). The shaping and text modules,
asserted the same way every other tool's are, sentence by sentence against a shaped output chosen
to contradict a naive reading (`tests/tools/describe/shape.test.ts`,
`tests/tools/describe/text.test.ts`). A wire test driving the tool through a real MCP client over
an in-memory transport, asserting the SDK's own output validation passes against a populated
`structuredContent` including at least one described column
(`tests/tools/describe/wire.test.ts`). All of it against fakes and hand-built fixtures, all of it
green, none of it against a real workbook or a real site.

**The live sitting this phase owed**, copied from the design spec rather than restated from
memory: run both modes against the real tracking workbook and confirm that the source and header
row the deep mode proposes are the ones `profiles/synthetic.json` already uses, and that the
columns it describes include the header texts that profile's mapping names. The tool should
rediscover a mapping this repository independently knows is correct. If it proposes something
different, either the tool is wrong or the profile is, and both are worth knowing before merge;
neither is discoverable from a fixture this phase's own author wrote. It ran on 2026-09-18 and the
tool rediscovered the mapping; the record, and the request-count defect the sitting found, are
below.

**`IW_SITE_URL` is now required server configuration, and phase 5 hosting must set it or the
server will not start.** The stub this phase replaced took a `siteUrl` input, which promised a
reach the `Sites.Selected` permission model forbids: this server holds one site's grant and
cannot read any other, and nothing in the running server could previously tell a caller which
site that was, since `IW_SITE_URL` was read only by the setup command. `describe_workbook` now
takes `library` and `workbookPath` and no site at all, resolved against `IW_SITE_URL` at
startup. It buys more than this one tool: the profile registry now refuses at startup a profile
whose `identity.siteUrl` disagrees with the configured site, instead of that mismatch surfacing
later as a 403 on the profile's first Graph call, which is the same class of misleading failure
the setup command was already corrected for once and that this file already records the cost of.
`docs/SETUP.md` carries the same requirement, next to where it already lists what the running
server reads from its environment.

**The tool describes richly and proposes only what it can observe.** It never guesses which
column is the client, or fills in any part of a profile's `columns` map, because those keys are
the profile author's own vocabulary, tied to deliverables this tool has never seen; a mapping it
invented would be a plausible artifact that is harder to audit than no artifact. For a worksheet
it declines to propose a header row when two candidates score equally, rather than picking one:
a header row wrong by one shifts every column beneath it, and the resulting mapping still
validates and reads the wrong data, which is exactly the class of failure this project treats as
its most expensive. For a table the header row is not a guess at all. `resolveHeaderRow` in
`src/tools/describe/run.ts` reads the table's own `headerRowCount` declaration: present and
nonzero means row 1, declared `"0"` means the table asserts it has none and the tool reports
that rather than treating the first data row as a header.

**There is no `date` inferred type, and this is deliberate.** A date in xlsx is a number carrying
a number format, and the cell decoder built for the compliance path deliberately does not read
styles, so a date serial and an ordinary number are indistinguishable at the layer this tool
reads from. `describeColumns`'s `InferredType` is `string`, `number`, `boolean`, `mixed`, or
`empty`, with no sixth case. Claiming to infer `date` would assert something this code cannot
observe; a column of date serials reports as `number`, with its samples showing the serials,
which is what the file actually holds.

**When the workbook is `fullCalcOnLoad` and the range holds a formula, every sample for that
source is withheld, not just samples from formula cells.** `sheetToGrid` reports whether a range
contained a formula at all, not which cells did, and teaching it per-cell tracking would mean
changing the module phase 2b-2 built to be the trustworthy half of the compliance path, for the
sake of a sample display in a different tool. `buildSourceOutput` in
`src/tools/describe/run.ts` withholds every sample for the source instead, which is the
conservative direction and needs nothing new from the reader. Structure, header text, types and
counts are still reported in full, because structure is not stale; only the sample values, which
could be read from a cached result the file itself says may be wrong, are withheld, and the
response states that they were and why.

**Sheets and tables that cannot be resolved are recorded, not dropped.** A review during this
phase found `readWorkbookInventory`'s first draft silently omitting a table whose owning sheet
could not be resolved, and reporting a sheet whose worksheet part was missing from the archive as
`{ rows: 0, columns: 0 }`, a shape identical to a legitimately empty sheet. Both are wrong for the
same reason: a workbook survey that quietly returns a shorter, confident-looking list, or reports
a broken sheet as though it were merely small, cannot be trusted about what it did not find any
more than about what it did. `WorkbookInventory` now carries an `unresolved` array alongside
`sheets` and `tables`, and every sheet or table `readWorkbookInventory` observed but could not
resolve is recorded there with the specific part that was missing or orphaned, rather than being
folded into either list or left out of the response. This is the same rule the workbook reader
already applies to a row it cannot turn into a client record: refusing a thing and reporting it is
one rule, not two, and the reporting half is what makes a rejection honest rather than a silent
gap.

**A cost figure was reporting the wrong number, and no test in the suite could see it.**
`graphRequests` originally read `context.graph.requests()` directly, the process-lifetime counter
on the Graph client `main.ts` builds once and shares across every per-request server, while the
schema and the response prose both promise what this call itself paid. Every test in the suite
builds a fresh `ToolContext` and makes exactly one call, so the shared counter and a per-call
counter read the same value in every test that exercised it, and the defect was invisible to the
whole suite by construction. `runDescribeWorkbook` now brackets the counter with
`requestsAtStart` and reports the delta, the same pattern `src/scan/run.ts` already used for the
identical reason. The shape of the blind spot generalizes past this one field: any per-call figure
measured against a counter shared across calls will pass a test suite that only ever makes one
call before checking it, and will still be wrong the moment a second call happens in the same
process, which is the server's normal operating condition and never the test's.

### The phase 4c whole-branch fix wave, 2026-09-18

Six tasks each passed their own review; the whole-branch review then found what the seams hid. One
wave closed all of it, leaving the suite at 1955 tests across 134 files with no new test file, all
four gates green. Nothing below has run against a tenant.

**The Critical: a declared sheet could vanish, and the tool then said nothing had.**
`listSheetEntries` dropped a `<sheet>` entry on a missing name, a missing `r:id`, or an `r:id` the
rels part does not define, and a dropped entry reached neither `sheets` nor `unresolved`. The
inventory came back one sheet short and the prose then said "Every worksheet and table this
workbook declares resolved cleanly." The third condition is a real workbook defect that
`resolveWorksheet` raises as a first-class `WorkbookFileError` on the compliance path, so the
survey and the compliance path disagreed about the same file. All three now return a rejection in
the shape the module already uses; a dangling `r:id` names the undefined id, and an entry with no
name is reported under its position in the sheet list, that being the only identifier the file
gives it. The second-order defect went with it: `sheetNameByPart` was built from the truncated
list, so a table owned by a dropped sheet was told its sheet "is not among the workbook's declared
sheets," which the workbook plainly contradicts. That reason now has three branches, and the middle
one says what was actually observed rather than choosing between two explanations it cannot
separate.

**Header scoring is one property, and that is now written down rather than outstanding.** The spec
named two; only the first shipped. The second could only break a tie, and a tie is the evidence
failing to decide. The design spec carries the ruling as its third dated amendment.

**The tool now says which site it read.** `IW_SITE_URL`'s justification had two halves and only one
had shipped. `siteUrl` is on the structured output and in the first sentence of the prose. The
static `description` still names no site: every tool definition is a module-level constant built
before any configuration is read, so a description carrying the value would make the definition a
factory and the registry with it.

**`reconcile_workbook_vs_repository` was undercounting its own Graph cost by three on every call,
and saying something false on every joined one.** `readWorkbookSnapshot` pays `resolveDrive` twice
and `downloadDriveItem` once, none of it counted, while the prose said "This call cost N Graph
requests." On a joined scan it said the call "issued no Graph request of its own," which was never
true: the coordinator shares the repository snapshot and nothing else, so a joiner still reads the
workbook itself. `workbookReadGraphRequestsByThisCall` is now its own named, unsummed clause,
measured by bracketing the shared counter rather than assumed as a constant, and the joined
sentence names what the call did pay. Kept separate rather than folded in, because
`graphRequestsByThisCall` is the figure this file records a live delta-enumeration baseline for.

**The workbook grid's second door has a mechanical guard.** `resolveWorkbookGrid` returns the
compliance path's grid without `parseWorkbookGrid`'s `fullCalcOnLoad` refusal, and only a doc
comment held the line. An eslint `no-restricted-imports` pattern, narrowed by import name so the
module's other exports stay available, now permits it in the workbook layer and in
`describe_workbook` alone, pinned by seven cases in `tests/lint-guardrails.test.ts` including the
two that guard the guard.

**Smaller corrections in the same wave.** A non-text header cell now renders as Excel shows it, so
a header row holding a year is no longer indistinguishable from a column with no header at all.
`samplesOmitted` is measured against the sample list actually built, so a column whose samples were
withheld reports every value as omitted rather than reporting none; the interface comment and the
implementation had been contradicting each other 130 lines apart. An empty-text sample renders as
`(empty text)` so it is visible among real values, and the deliberate split between `isBlankCell`
and `describeColumns` on the empty string is documented at both ends. `position` is sheet-absolute,
which the spec bullet now says and a test at a non-1 `firstColumn` pins. The prose can no longer
render `describing the source ""`. The response carries `readAt`, from the tool context's clock,
which every other read tool had in some form and this one lacked while reading a live file.
`sheet.ts`'s note that `read.ts` is the only consumer of an unbounded grid was stale and now names
the second one and why it needs no bounds of its own.

**Documentation corrected in the same wave, in `CLAUDE.md` and in this file.** Phase 4b was
described as never having run against a tenant, which stopped being true on 2026-09-18; the
"Status as of" date above the build sequence was a day behind the work it described; and this
file's phase 4c section overstated both what phase 4a and 4b had exercised live and what the
introspection tests covered.

### A table part with a ref but no name is invisible to `describe_workbook`, 2026-09-18

Found the same day as the whole-branch fix wave above, by a reviewer who reproduced it against
the tip. `findTables` in `src/workbook/xlsx.ts` requires both a `name` and a `ref` attribute
before it reports a table part at all, so a table part carrying a `ref` but no `name` never
becomes a `TableInfo`. `resolveTable`, `readWorkbookInventory` in `src/workbook/introspect.ts`,
and `describe_workbook`'s inventory mode all call `findTables`, so such a table appears in none of
their outputs: not in `tables`, not in `unresolved`. A workbook built with exactly this shape
produced "1 worksheet and 0 tables resolved" alongside "Every worksheet and table this workbook
declares resolved cleanly; none is reported as unresolved," which is false about the file.

This is not fixed here. `findTables` is on the compliance path: `resolveTable` calls it, so a
change to its return type reaches the range a profile's `workbookMapping` actually reads, which is
a change with its own blast radius and its own review, not a rider on a prose fix. What is fixed
here is the prose. The sentence above, the `sheets` and `tables` schema descriptions, and
`describe_workbook`'s own static description all claimed to cover every worksheet and table "the
workbook declares." None of them can back that claim while `findTables` can silently skip a table
part, so all four now say what they actually cover: what this tool resolved, not what the workbook
declares. `tests/workbook/introspect.test.ts` and `tests/tools/describe/run.test.ts` each pin the
gap directly, with a fixture flag (`TableSpec.omitName`) that builds exactly this table shape.

The first pass at this fix missed one instance of its own, in the same file: `output.ts`'s `mode`
field description read "\"inventory\" lists every worksheet and table the workbook declares," the
identical claim in a fifth place, read by a model deciding how to call the tool rather than by an
operator reading a response. A second search of `output.ts` for the same claim, rather than trusting
the four-item list from memory, found one more: the `unresolved` field's own description said a
partly broken workbook "must not read as a workbook with fewer sheets or tables than it actually
declares," which is the exact guarantee this defect violates, stated as a promise rather than as a
count. Both are narrowed the same way, to what this tool tracked rather than what the workbook
declares. The search covered every `.describe()` string in `output.ts`, `describe-workbook.ts`'s
static description, and a repo-wide grep for the same phrasing; nothing else in the tree carries
this claim. The other hits that phrase turns up, `introspect.ts`'s `unownedTableReason` and
`zip.ts`'s declared-byte-count message, state an observed count rather than claim totality, and are
not instances of the same defect.

One piece of the reasoning above is worth correcting, since it argued the gap has nowhere to be
reported. It does not follow that a nameless table has no identifier to report it under. The sheet
path already handles the equivalent case: `listSheetEntries` reports a `<sheet>` entry with no
name attribute under its position in the workbook's sheet list, which is the only identifier the
file gives it. A table part is not even that badly off, since a table part has a part name
(`xl/tables/table3.xml`, say), which is a stronger identifier than a bare position, having survived
`readZipParts`'s own filter already. The real reason nothing here reports it is only that
`findTables` never returns it, not that there is nothing to name it by.

The likely shape of a real fix, so whoever takes it does not start from scratch: leave `findTables`
alone and add a cheap, purely additive check next to its caller instead. `resolveWorkbookGrid` and
`readWorkbookInventory` in `introspect.ts` both already hold the parts map that `readZipParts`
returned, which includes every `xl/tables/*.xml` entry regardless of what its root tag declares.
Counting those entries and comparing that count against what `findTables` actually returned would
detect the gap without changing `findTables`'s return type or its callers' contract at all; the
difference is exactly the table parts this residual can never resolve to a name, and each can be
reported the same way an unnamed sheet already is, by its part path rather than by a name the file
never gave it.

## The phase 4c live tenant sitting, 2026-09-18

Both modes ran against the live site through the MCP transport and a per-request `McpServer`
rather than by calling handlers directly, so the sitting exercised the same path a Copilot
Studio connection would.

**The server names its site at startup**, which is the configuration change this phase made
working end to end: "listening on port 3000, site
https://helloironwright.sharepoint.com/sites/IronwrightTest, writes disabled, 1 profile from
profiles, azure-table store".

**The merge gate passed: the tool rediscovered a mapping this repository independently knows
is correct.** That was the point of choosing this check over any fixture. Inventory mode found
one worksheet and one table, the table being `ClientRoster` on `Sheet1`, ref `A1:D14`,
14 rows, 4 columns, declaring a header row. Source mode against that table proposed header
row 1 and described four columns whose headers are `Client`, `Monthly Training`,
`Quarterly Phishing` and `Onboarded`.

`profiles/synthetic.json` independently names source `{kind: table, name: ClientRoster}`,
`headerRow: 1`, and those same four header texts in its columns map. The tool was told none of
it.

**The evidence the tool reports instead of guessing works on real data.** The `Client` column
came back with 13 distinct values across 13 non-empty cells while the other three each have a
single distinct value. An operator reading that picks the client column immediately. This is
the whole argument for describing richly and proposing nothing: the tool never claimed to know
which column was the client, and the reader cannot miss it.

**The refusal to propose a columns map is stated in the response**, not merely implied: "This
tool proposes no columns map. Header text, inferred type, distinct count and sample values
above are the evidence; deciding which field each column is and writing that into the profile
remains yours to do."

### The sitting found a defect no fixture could

The tool reported `graphRequests: 4`. Every unit test pinned 3. The tool was right and the
tests were wrong about production.

`sendForBytes` in `src/graph/client.ts` increments the request counter and runs twice for one
content download: once against Graph, which answers a 302, and once against the redirect
target, deliberately without the bearer token because that target is pre-authenticated
storage. A download therefore costs 2 counted requests. The shared test fake charged 1.

Every download-inclusive cost assertion in the suite was one request short of what a real
tenant pays, including the `reconcile_workbook_vs_repository` workbook-read figure added
earlier on this same branch. No fixture could have caught it, because the fake defined the
number the tests were checking against.

Fixed in `9c70ffd` by charging the fake what the client actually costs, with each corrected
figure derived from the client's own code rather than adjusted until the tests passed.

Two fakes elsewhere carry the same modeling gap and were left alone because nothing asserts
their request counts: the scripted clients in `tests/scan/workbook.test.ts` and
`tests/scan/workbook.errors.test.ts`. They are latent rather than wrong today, and the first
test in either file to assert a request count will reproduce the understatement.

### One operational property, not a defect

`Sheet1` reports zero rows, zero columns and no used range, because that worksheet part
declares no `<dimension>` element. A sheet holding a 14 row table reporting zero rows reads as
wrong and is in fact the honest answer: the tool does not guess a size the file does not state,
and the absent `usedRange` is what says so. A customer opening the inventory on such a workbook
will see the same thing.

### What this sitting does not establish

One workbook, one table, one worksheet, four columns, thirteen data rows. It says nothing
about a workbook exceeding any of the caps, a worksheet source where the header row must be
detected rather than read from a table declaration, a workbook whose internal wiring is broken
in any of the ways the unresolved reporting exists for, or a `fullCalcOnLoad` workbook where
samples are withheld. Every one of those is covered by fixtures only.

In particular the header row here was determinate, read from the table's own declaration, so
the worksheet heuristic and its refusal to decide between two equally plausible candidates have
still never run against a real file.

## Phase 5a: making the server deployable, 2026-09-18

Phase 5a covers three changes verifiable on a development machine: separating the production
compile from the development one, bounding the shutdown, and settling what health means. It was
sliced this way, rather than building the container image the parent design originally centered
on, because the amendment recorded in
`docs/superpowers/specs/2026-09-18-hosting-image-design.md` found, while writing the
implementation plan and before any code, that the development machine has no container runtime
at all: no Docker, no Podman, no WSL distribution. Writing a Dockerfile nobody can build and
merging it anyway is the same shape as phase 2b-1, designed, built, reviewed across six tasks and
merged against an Excel API nobody had ever called; this project does not repeat that. The image
is held for its own slice, not dropped: the multi-stage build, the `node:22-slim` base and the
reasoning against Alpine, the non-root runtime user, and the `.dockerignore` excluding `profiles/`
are all recorded in the design spec so that slice does not restart from nothing.

Because the container is deferred, the merge gate changed to match what this phase can actually
prove. It is that the COMPILED PRODUCTION OUTPUT answers all five read tools correctly against
the live tenant, run as `node dist/server/main.js` from `npm run build:prod`, not `tsx` against
source. Every live sitting before this one, phases 2a through 4c, used `tsx`. The compiled
artifact had never been executed at all, and the production compile is exactly where excluding the
setup command could break something source execution hides. **That run happened on 2026-09-18 and
passed**; see "The phase 5a merge gate, 2026-09-18" below, which is the record, including what it
does not establish.

**The production compile now excludes `src/setup`, and that is a security boundary rather than a
size saving.** See the closed carried item above for the mechanism. The reasoning is restated
here because it is the point of the change, not an implementation detail: the setup command
issues per-site permission grants using a separate application holding `Sites.FullControl.All`.
Compiling it into a deployment would widen what a compromise of that deployment reaches, from
"can read one granted site" to "contains the machinery for granting access to others." The
devDependency failure, `@azure/identity` pulled in by `src/setup/main.ts` under `npm ci
--omit=dev && npm run build`, was only the symptom that surfaced the question; the fix is drawn
at the boundary the symptom happened to expose, not at removing the symptom itself. This closes a
carried item that had been open for the hosting phase since phase 2a.

**The boundary was resting on a clean tree, which is the alternative this phase had rejected by
name.** `tsc` does not prune its `outDir`. Excluding `src/setup` keeps setup output out of a
compile, and it removes nothing already sitting in `dist` from the development build that almost
always ran first: `rm -rf dist && npm run build && npm run build:prod` left `dist/setup/main.js`
in place, verified by the whole-branch review. That is build-then-prune arrived at by accident,
and worse, because nothing pruned. The test passed only because the test deleted `dist` itself.
`build:prod` now clears `dist` before compiling, so the script is the boundary rather than a
precondition of it, and the test seeds a leftover `dist/setup/main.js` and asserts the script
removes it. The clean is inline `node -e` rather than a new dependency or a shell command, since
`rm -rf` is not portable to the machine this project is developed on.

**The shutdown now always exits, on a deadline, and says so before it does.** See the closed
carried item above for the commit and the mechanism. The defect it replaces: the old handler
exited only from `server.close`'s callback, so one request that never completed meant `close`
never called back, the process never exited on its own terms, and the platform eventually sent
SIGKILL with no log anywhere saying why. `installShutdown` now races the drain against a timer
bounded by `IW_SHUTDOWN_DEADLINE_MS` and exits on whichever finishes first. When the deadline
wins it logs, synchronously and before exiting, that the deadline was reached with the drain
incomplete. It logs no number, and that is the second correction below rather than an omission.

**A stale type nearly shipped a lie, and this is the third instance of the same pattern on this
project.** The deadline log's first version read `server.connections` to report how many
requests were still in flight. That property does not exist on a real `http.Server` at runtime;
only `@types/node` still declares it, a stale type left over from an API Node has since removed.
`tsc` therefore agreed with the code, and the runtime did not: every deadline-reached log in
production would have read `undefined requests still in flight`, always taking the plural
branch, and said nothing true. It survived the implementer's own review because
`fakeHttpServer`, the test double every shutdown test drove, invented a `connections` field with
no equivalent on the real API. The tests checked the code against the fake, and nothing checked
the fake against reality. The first two instances of this pattern on this project are recorded
elsewhere in this file: the Graph Excel API, designed and built across six tasks against an
endpoint nobody had called, and the `graphRequests` figure in phase 4c that a shared, per-call
counter mismatch left invisible to a suite where every test made exactly one call. The fix here
has two halves, and the second is not optional, per the same reasoning `CLAUDE.md` already states
for the Excel episode. The log no longer states a number it did not obtain: `getConnections` is
the real, asynchronous API, exit does not wait on its callback, and a deadline that fires without
a usable count logs that the drain was incomplete rather than printing a figure it never read.
And a test now runs `installShutdown` against a real `node:http` server with a request whose
handler deliberately never responds, which is the one case a hand-written fake cannot fail: the
fake defines the very field the defect was in.

**Then the replacement logged nothing at all, and the whole-branch review caught it by running
it.** Moving the count onto `getConnections` fixed the invented number and introduced a worse
failure in the same edit. `getConnections` defers its callback through `process.nextTick`, and
`process.exit` terminates without draining that queue, so calling `exit` anywhere near the
request starves the callback permanently. The deadline sentence lived inside that callback, so
the deadline sentence never printed. Driven against a real `http.Server` with a genuinely open
request and the real `process.exit`, the only output was the SIGTERM line: the spec's own
requirement unmet, and the exact silence the change had been made to remove, since the closed
carried item above justified the deadline on the grounds that SIGKILL left no log explaining
itself.

Three documents asserted the log happened. None of them was wrong about the code's intent and
all three were wrong about its behavior, which is this project's message-audit defect at the
scale of a phase rather than a sentence. The fix is an ordering, not new prose: the numberless
sentence already existed as the error branch, and it now runs synchronously, first, before
`finish`. `finish` then commits the exit before anything else is attempted, so no synchronous
throw can cost the guarantee.

**`getConnections` is gone entirely, rather than kept as best-effort enrichment.** The first
version of this fix retained the call behind the exit and labeled it best effort, which was
honest about its reachability and wrong about what to do with it. Code that production cannot
reach, retained so that tests can exercise it, inverts what the tests are for: those tests assert
behavior the deployed server is structurally incapable of exhibiting, which makes them tests of a
fiction. That is the same family as the three defects this project has already spent phases on, a
fake encoding what its author believed, a count read from a property that does not exist, a log
documented in three places that never prints, arrived at one step earlier. The property worth
protecting was never "report a count", it was "never state a number you did not obtain", and with
no number produced at all that property now holds trivially and permanently. The tests that drove
the call went with it, including the plural-branch case, which had no subject left; a test with no
subject is not coverage. What stays in the code is the comment saying why there is no count, since
that is the surprising part and the next reader will otherwise try to add one back.

Keeping it against a future where `exit` is wired to something that returns, a graceful-exit
wrapper say, was considered and rejected. This project does not build for futures it has not
observed, and `exit` is injected precisely so that whoever wires it differently owns what that
implies. If that day comes, adding a count back is smaller than the comment explaining why it was
kept.

Only the test that asserts from inside `exit` itself pins the ordering, because that is the only
moment that can distinguish a correct ordering from the regression at all; once `exit` returns,
nothing observable tells them apart, and an assertion made after everything settles would pass on
either. The real-`http.Server` test asserts the same line by position but does not guard the
ordering: it exists to prove that `close` genuinely withholds its callback while a request is
outstanding, so the deadline is what ends the process rather than the drain.

**What this episode says about the earlier fix.** The correction that replaced
`server.connections` was reviewed, tested against a real `http.Server`, and merged, and it still
shipped a function whose single output was unreachable. The real-server test passed because it
injected an exit that returns. A test double for `process.exit` is as capable of hiding a defect
as a test double for `http.Server` was, and the pattern is the same one this file has now
recorded four times: the suite checked the code against something that was not the thing.

**Health answers one question and deliberately checks nothing.** `GET /health` reports that this
process can serve, not that the tenant, Graph, or the state store is reachable, and it must not
call Microsoft Graph. A health check that depends on a third party turns that party's outage into
an instance restart loop, which is strictly worse than serving one caller an error: the platform
kills the instance, the replacement fails the same check, and one degraded dependency becomes a
total outage of a server that could have kept answering everyone else. Configuration and profile
problems already exit the process before the port binds, which is preserved and unchanged, so a
process that is answering `/health` has already passed everything worth checking. A test pins the
one dependency-reaching path that exists in `createApp` today, the injected `serverFactory`, and
asserts the health handler never invokes it. That test cannot see a check added through a second
`AppOptions` field or an inline import in the handler itself; the route comment says so
explicitly, alongside the rule, so the rule holds by convention beyond the one seam the suite can
actually enforce, and a future reader is not left believing the test guards more than it does.

**The container image was moved out of this phase, held rather than dropped.** The development
machine has no container runtime, discovered while writing the implementation plan and before any
code was written. The Dockerfile, the `.dockerignore`, the base image choice and its reasoning,
and the runtime user are all recorded in the design spec rather than built here, so the slice that
takes them up does not start from nothing. The merge gate that would have been the container
answering all five read tools against the live tenant becomes the compiled production output
doing the same, which is the only evidence this phase carries beyond its own unit tests: nothing
here has been run live, and the paragraph above states that plainly rather than implying it.

**What this phase deliberately did not fix.** `docs/OPEN-ITEMS.md` has recorded since phase 2a
that the MCP SDK deletes a pending stream-mapping entry on close without resolving it, so an
aborted request can leave its handler permanently pending and retain the closure, and that this
matches the SDK's own stateless example rather than being a local defect. Phase 5a does not fork
SDK behavior on a hunch to work around it. What makes the item tractable is detection rather than
repair, and detection is telemetry, which belongs to phase 5b: 5a bounds the shutdown it can
bound, and 5b learns to observe the leak; neither should be read as having fixed the other.

**Importing the server's entry point started the server, and one test did.** `src/server/main.ts`
calls `main()` at module scope, which was harmless for as long as nothing imported it. This phase
added the first test that did, to reach the exported `installShutdown`. The whole-branch review
ran it rather than reasoning about it: with the deployment environment exported, importing that
module binds a port inside the vitest worker, and with `IW_TABLE_CONNECTION_STRING` set it awaits
`ensureTables` first and makes a real Azure Table call. The suite was green only because a worker
with no environment threw in `loadConfig` and the top-level catch set a `process.exitCode` vitest
ignores. The merge-gate shell is precisely the shell where that environment is exported, so
running the gate as planned would have had `npm test` bind ports and reach Azure.

The handler moved to `src/server/shutdown.ts` and `main.ts` imports it, rather than guarding
`main()` behind an entry-point check. Both close this instance; only the extraction leaves the
entry point with nothing importable at all, so it closes the class for every future test instead
of for the one that found it, and it is what "modular over monolithic" already asks for. Nothing
else in the tree imports `main.ts` for a value, checked across `src`, `tests` and `scripts`.

No task owned the question. Task 2 owned exporting `installShutdown`, and exporting anything from
a self-executing entry point is the seam between that task and the file it was exported from.

**What this phase is covered by, and what it is not.** Every change is covered by unit tests: the
production compile by a test that seeds a leftover `dist/setup/main.js` and shells out to a real
`npm run build:prod`, asserting the server entry point exists afterward and the setup output does
not; the shutdown by tests driving the real ordering (drain first, deadline first, the same tick,
a second signal mid-drain) against a hand-written fake that supplies only timing and no data at
all, plus one case against a real `node:http` server with a genuinely open request, proving that
`close` really does withhold its callback and that the deadline really is what ends the process;
and health by a test asserting the handler never invokes the one injected dependency seam.
`npm test` passed at 136 files and 1982 tests, run repeatedly back to back with no changes
between the runs, after the branch's own history of a report claiming a clean suite that turned
out to be a lucky single run rather than a reproducible one (see the closed shutdown item above:
the production-compile test's default 5 second timeout had no margin under full-suite worker
contention and needed an explicit, explained 60 second allowance before it held reliably). Beyond
those unit tests, this phase's live evidence is its merge gate: the compiled production output
answering all five read tools against the live tenant, through `node dist/server/main.js` rather
than `tsx`. That gate ran on 2026-09-18 and is recorded immediately below, with what it does not
establish.

## The phase 5a merge gate, 2026-09-18

The compiled production output answered all five read tools against the live tenant. This is the
first time this project has executed its compiled artifact at all. Every live sitting before this
one ran `tsx` against TypeScript source, so nothing had ever exercised what a deployment would
actually run.

Built with `npm run build:prod` and started as `node dist/server/main.js`. The startup line names
the site, which is the phase 4c configuration change working through the compiled path:

    listening on port 3000, site https://helloironwright.sharepoint.com/sites/IronwrightTest,
    writes disabled, 1 profile from profiles, azure-table store

`GET /health` answered `{"status":"ok"}`.

**Every figure matched the phase 4b and 4c sittings exactly**, which is the result that matters:
the compiled artifact behaves identically to the source runs, so the production compile's exclusion
of the setup command broke nothing that source execution was hiding.

- `query_repository` against an unscanned profile refused, naming both ways to populate the index.
  It did not answer zero.
- `inventory_tree` cold: 144 files, 122 folders, 4 Graph requests.
- `query_repository`, all three questions: **0 Graph requests each**. `recent_reports` reported 142
  findings, which is the phase 4c fix working: before it, that answer capped at 50 and called it the
  complete total.
- `validate_structure`: 12 client folders, all compliant, 3 Graph requests.
- `describe_workbook` source mode: proposed header row 1 and the headers `Client`,
  `Monthly Training`, `Quarterly Phishing`, `Onboarded`, which is the mapping
  `profiles/synthetic.json` independently uses.
- `reconcile_workbook_vs_repository`: returned its report in 2.1 seconds.

### What this gate does NOT establish, and it is the part worth reading

**The shutdown deadline was not exercised here.** Windows does not deliver a POSIX SIGTERM: killing
the process terminates it without running the handler, so the one behavior this phase exists to add
cannot be demonstrated against the running compiled server on this machine.

It is covered by unit tests and by a reviewer's probe that loaded the COMPILED `dist/server/shutdown.js`
into a real `node:http` server with a genuinely open request and the real `process.exit`, printing:

    received SIGTERM, finishing in-flight requests before exit
    shutdown deadline of 50ms reached with the drain not complete, exiting

That probe carried a negative control: moving the log back after the exit call made the deadline
line vanish, which is the defect it replaced. So the behavior is verified against compiled code, and
it is not verified against a platform delivering a real signal. Phase 5b, which has a platform, owes
that check.

**Nothing about a container was verified**, because none was built. The image left this phase for
want of a runtime on the development machine.

**The store was Azurite, not Azure Table Storage.** The same emulator every previous sitting used.

### What the branch found on the way

Two Criticals, both at joins no task owned, both proven by probe rather than argument.

The entry point started a server when imported. `main()` ran at module scope, and this branch added
the first test that imported that module to reach an exported function. With the deployment
environment set, that import bound a port; with a table connection string set, it made a real Azure
call. The merge gate's own shell is where that environment is exported, so running this gate before
the fix would have had `npm test` binding ports and reaching Azure. Closed by extracting the function
into its own module; the entry point now exports nothing, and a comment says that is load bearing.

The shutdown deadline logged nothing at all, while three documents said it logged a count. The
count came from `getConnections`, which defers through `process.nextTick`, and `process.exit` does
not drain that queue. Closed by logging one sentence synchronously before exiting, with no number.
The enrichment was then deleted outright, because after the reordering it was unreachable in
production and existed only for tests, which made those tests assertions about behavior the
deployed server cannot exhibit.

A third finding is worth recording because of where it was: two places claimed the tests catch an
ordering regression "by position", and under that exact regression only one of the two tests failed.
The branch that fixed a documented-but-never-printed log corrected a documented-but-never-run
assertion before merging.

## The phase 6b-1 live sitting, 2026-09-24: the first move this server has made

Run against the sandbox tenant through the MCP transport, from source, with the plan store on
Azurite. The server application's grant was widened to `write` in place with `set-site-role.ts`
and restored to `read` at the end; every change the sitting seeded was undone and a fresh plan
afterward matched the pre-sitting baseline exactly.

**Two probes came first and one overturned the plan.** The first measured the six questions in
the 6b-1 spec. The second measured how `parentReference.path` must be written, and found that the
natural guess, percent-encoding it the way Graph returns it, is refused with the same generic 400
an absent folder gets, while raw folder names containing a space, `#`, `%`, `&`, `'`, `+`, `;`,
commas and non-ASCII letters all land. The plan's code assumed the encoded form; it was corrected
before implementation. Had it not been, every move into a folder with a space in its name would
have been reported as a failure indistinguishable from a missing folder.

**Both `in_another_library` paths fired on real data before anything was seeded.** The library
still holds the phase 2c sitting's `Archive` residue: Client01's February report exists only in
`Archive`, so it wins its slot as a misplaced artifact, and Client02's has a copy there beside the
local original, so the copy is a losing duplicate. Both were excluded naming `Archive`. The second
is the shape the Task 5 review found silently dropped by the plan's own code; this is the live
evidence the fix was needed.

**The loop.** Four cases were seeded: a correctly named file in the previous month's folder, a
vendor-token file in the previous month's folder, a third file whose target month folder was
renamed away, and a misnamed file in the right folder for the rename regression.

1. `generate_move_plan` planned two moves and excluded the absent-folder file as
   `target_folder_absent`, spending two etag lookups for two candidates and none on the three
   exclusions. Four Graph requests for the workbook, three for the scan.
2. The dry run named exactly the plan's two files and issued zero Graph operations.
3. The confirmed run moved both with two Graph operations. The vendor-token file was moved and
   renamed by one PATCH. Listing the folders afterward, and a fresh plan finding nothing to move,
   confirmed both.
4. The reversal plan moved both back, restoring the second file's folder and its original name in
   one write, and the listing confirmed it.
5. With the absent folder restored, a three-item plan was generated. One file was then renamed away
   and back, changing its ETag without moving it, and another file was renamed into the third
   item's target path. Executing gave one `moved`, one `precondition_refused` and one
   `target_name_taken`. The occupant kept its place and the refused file stayed in its source
   folder, so `conflictBehavior: fail` held against real Graph.
6. That mixed run's reversal log over-covers by design. Replaying it moved back only the item that
   had moved and refused the other two on their stale ETags. One of those two entries pointed at a
   path that by then held a different file, the occupant, and the stale precondition is exactly
   what stopped the rollback from moving it.
7. `generate_rename_plan` and `execute_rename_plan` ran end to end through the refactored executor:
   three renames, three `renamed`, then rolled back with three `renamed`. The rename path verified
   on 2026-09-19 did not regress.

### What this sitting did NOT establish

- **Cross-library moves.** Out of this slice by design. Phase 6b-2 begins with its own probe.
- **A folder name the probes did not try.** The characters above were measured; others were not.
  A move into such a folder that Graph refuses is reported as `failed`, never applied wrongly.
- **The empty-body PATCH case**, again: every PATCH returned a body carrying an `eTag`.
- **A real Azure Table Storage account.** Azurite again, the instance left running since the 6a
  sitting.
- **Scale and concurrency.** Three items at most, one caller at a time.

## The phase 6a live sitting, 2026-09-19: the first write this server has made

The full loop in the design spec's verification section ran against the sandbox tenant and passed.
Everything below is measured, not predicted.

**The grant.** The server application's `Sites.Selected` role on the site was widened from `read` to
`write` in place for the sitting and restored to `read` immediately afterward. It was NOT widened by
re-running `npm run setup --write`: `runSetup` always creates a NEW application and prints its
secret to stdout, which would have orphaned the current registration and put a client secret in a
terminal scrollback, the incident that already cost this project an application on 2026-09-13.
`.superpowers/live-sitting/set-site-role.ts` patches the one existing permission, matches on
application id so it cannot widen another application's grant, and prints no secret.

**generate_rename_plan, live.** 2.2 to 4.3 seconds per call. Four Graph requests for the workbook,
three or four for the scan, and one etag lookup per candidate. The plan persisted through the real
`@azure/data-tables` client against Azurite and was read back by the executor in a separate call.

**The duplicates exclusion fired on real data, which no fixture had ever reached.** Re-seeding left
a compliant file from the previous seed sitting at `Client08`'s canonical path alongside the newly
planted misnamed one. The engine collapsed them into one slot, the compliant file won it, and the
misnamed file arrived as a `DuplicateFinding`. The plan excluded it as
`target_path_already_occupied`, which is the correct one of the three reasons, and issued only ONE
etag lookup for two misnamed files, so an exclusion genuinely costs no Graph request. This is the
code path the phase 6a spec originally described as unreachable-through-artifacts and that the
branch's second correction created.

**The first write.** Two renames, two Graph operations, zero failures, reversal log written before
the first PATCH.

**Graph's PATCH response carries the new `eTag`.** Previously assumed. Two renames cost exactly two
operations and `reversalEntriesNotRefreshed` was zero, so no fallback metadata read was needed and
every reversal entry was refreshed from the response body.

**The rollback worked and was not refused.** Two renamed back, zero refused. Had the reversal
entries carried their stale pre-rename etags, every one would have been refused; that they were not
is the live proof of the refresh chain the spec calls easy to get wrong and silently useless. A
fresh delta scan then found the library exactly where it started.

**Per-item preconditions hold against real Graph.** One file was edited between generating and
executing. That item alone came back `changed_since_plan` (the outcome's name on the day; it was
renamed `precondition_refused` later the same day, for the reason the finding below gives, so
`changed_since_plan` no longer appears in `src/`) and the untouched file still renamed.

### The finding: Graph evaluates If-Match before existence

A reversal entry for a file that had never been renamed, and whose source path therefore held
nothing, came back `changed_since_plan` rather than `not_found`. A direct probe
(`.superpowers/live-sitting/probe-precondition.ts`) settles why:

    absent path, no If-Match     : 400 invalidRequest
    absent path, stale If-Match  : 412 resourceModified
    present path, stale If-Match : 412 resourceModified

Graph checks the precondition first. This server always sends `If-Match`, so:

- `renameDriveItem`'s `not_found` outcome is unreachable in practice, and the executor's
  `not_found` count will always be zero.
- `changed_since_plan` was reported for a file that is merely absent, and its operator-facing line
  said "refused because the file changed since the plan", which is false in that case. A function
  that cannot observe an outcome must not assert it, and here it asserted a cause it did not check.

Not a safety defect: the write is correctly refused either way and nothing is lost. It was a
reporting defect on a write tool, which this project grades highly, and it is now corrected. The
outcome is renamed `precondition_refused`, and every rendered line and schema description says only
what the code observed: Graph refused the write because the item at that path is not the one the
plan recorded, without guessing which of "changed" or "absent" caused it, since 412 alone does not
distinguish the two and distinguishing them would cost a GET per refusal this project deliberately
does not pay. The `not_found` outcome stays in the schema, labeled as expected to be zero for the
reason above, rather than being removed: nothing proves a negative, and removing a branch on a
write path is the worse risk.

### What this sitting did NOT establish

- **The empty-body PATCH case never occurred.** Every PATCH returned a body carrying an `eTag`, so
  the guard added for a 204 or null response, which was the branch's last Critical, is still
  unexercised against a real tenant. It is a guard against a shape Graph did not produce here.
- **The store was Azurite, not Azure Table Storage.** The `Plans` table's
  `as unknown as TableClientLike` cast now has an emulator behind it rather than a fake, but not a
  real storage account, and `MAX_PLAN_JSON_CHARS` was never approached.
- **Scale and concurrency.** Two items in a plan, one caller at a time. Nothing about batching,
  throttling, a retried operation spending more than one request, or two callers executing at once.
- **`cTag` versus `eTag`.** The code uses `eTag` throughout and it worked; nothing here shows
  `cTag` would not also have worked, or what either does across a content change.

## Phase 6a: what the unit tests cover, 2026-09-18

Phase 6a is the first write path this server has.

**This section was written before the live sitting and is kept as it was, minus three claims that
are no longer true.** It read "As of this commit it is covered by fakes only. No rename has been
applied to a real SharePoint library, no reversal log has been replayed, and no real 412 has been
observed." All three were correct on 2026-09-18 and false from 2026-09-19, when the full loop ran
against the sandbox tenant: see "The phase 6a live sitting, 2026-09-19: the first write this server
has made" above, which is the record. Correcting it in place rather than appending a line, for the
reason the phase 4b section gives: this is the document a reader consults to decide what counts as
evidence, and a false sentence about evidence here is worse than in any other file. What follows
describes what the unit tests reach, which is still worth knowing alongside the sitting.

Every fake in this suite rejects `patch` except the two written for the rename tests, which apply
renames into memory. A fake proves the code does what its author believed Graph does.

**The merge gate passed on 2026-09-19.** The gate was the full loop against the sandbox tenant:
generate, dry run, execute, confirm the renames in SharePoint, roll back through the reversal log,
confirm the library returned to where it started, then edit one file between generating and
executing and confirm that item alone is refused while the others apply. Every step ran and passed.
The confirmation step is a fresh delta scan, so what it establishes is that paths, names and counts
are back at the seeded baseline, not that the library is byte for byte where it started; the sitting
write-up above claims only the former.

**The Azure Table 32768-character limit has never been probed live.** `MAX_PLAN_JSON_CHARS` in
`src/store/types.ts` sets the plan-size cap at 32000, a margin under Azure Table's documented
32768-character limit on a single String property, and `PlanTooLargeError` fires whenever a stored
plan's JSON exceeds it. Plan persistence itself did reach the real `@azure/data-tables` client on
Azurite during the 2026-09-19 sitting, but no plan anywhere near the cap did: every test that
exercises the cap runs against `FakeTableClient`, and the sitting's plans held two items. So the
margin's own correctness, that a plan just under 32000 characters actually persists and a plan just
over it is actually rejected by the real service rather than by this project's own arithmetic, is
still unverified.

**The empty-body PATCH fallback is still unexercised against a real tenant.**
`src/tools/rename/execute.ts` carries a fallback branch, reached when a PATCH response has no
`eTag`, that falls back to a metadata GET through `readDriveItemEtag`. That branch is exercised in
`tests/tools/rename/execute.test.ts` and `tests/tools/rename/execute.errors.test.ts`, but only
against fakes that were told to omit the etag. Every PATCH in the 2026-09-19 sitting returned a body
carrying an `eTag`, so nothing has yet observed Graph omitting it, which is the premise the branch
exists to cover. The other two questions this entry used to raise, whether a stale etag yields 412
and whether a successful PATCH carries the new `eTag`, were both answered by measurement in that
sitting and are recorded there.

### The phase 6a whole-branch fix wave, 2026-09-19

Two things the fix wave settled it could not fix, recorded here rather than left implicit.

**A confirmed run leaves the stored inventory and delta link stale, and this server is now what
makes them stale.** `execute_rename_plan` renames files in the library and writes nothing back to
the inventory, so every path it changed is wrong in the stored snapshot until the next scan.
`query_repository` answers from that snapshot at zero Graph requests, which is its own documented
promise and not a defect, and it reports the scan's timestamp, so a reader is told how old the
answer is. What is new in this branch is the cause: before phase 6a, a divergence between the
snapshot and the library was always somebody else's edit arriving between scans, and now this
server can produce one itself within a single session. A caller who renames and then queries gets
the pre-rename paths back with an honest timestamp attached. Whether the executor should invalidate
the delta link, apply its own changes to the inventory, or leave both alone is a design question
this wave did not answer and did not want to answer inside a fix.

**No `as unknown as TableClientLike` cast has met a real Azure Table Storage account.**
`tableStateStoreFromConnectionString` in `src/store/table.ts` now makes three such casts, not two.
The `DeltaLinks` and `Inventory` casts were held against the real `@azure/data-tables` client on
Azurite on 2026-09-16, recorded under "Phase 2a: what the unit tests cover" above; the `Plans` cast
is new in this branch and was held against that same real client on Azurite on 2026-09-19, when a
plan generated by one tool call was read back by the executor in a separate call. All three are
therefore proven against the emulator and none against a real storage account. The compiler checks
nothing at those lines by construction, so no fake can check them either. The phase 6a entry above
records the 32768-character cap as unprobed, which is a different claim: the cap is about what the
service accepts, the cast is about whether the real client satisfies the interface this code calls
through at all.
