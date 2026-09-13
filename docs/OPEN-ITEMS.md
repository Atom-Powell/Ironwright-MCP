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

## Found by using the tool, 2026-09-12

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
refusal, its ambiguous-match refusal, and its success message are covered by tests against
fakes, not by a live delete against a real tenant. No live failure on any of these paths has
been observed.
