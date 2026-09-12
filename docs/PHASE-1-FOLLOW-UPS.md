# Phase 1 follow-ups

Open items carried out of phase 1's reviews. Recorded here rather than in a scratch ledger
because the later phases that need them will not read a scratch ledger.

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

Three options, none obviously correct:

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

A site permission granted immediately before a malformed response is not rolled back: the
field check throws before the permission id is captured, so the rollback removes the
application and leaves the permission. Capturing the site id and treating the permission as
possibly-granted from the moment the call starts would close it.

Creating the service principal immediately after the application intermittently fails with
`Request_ResourceNotFound` from directory replication lag. Bounded retry exists for the same
class of failure on the token exchange but not here, and with rollback in place, losing that
race now tears down the whole run.

The `grant-missing` remedy tells the operator to issue a per-site grant the command issued
seconds earlier. Given the sequence, a 403 with the role present is more likely propagation
than an absent grant, and the consent remedy already acknowledges propagation while this one
does not.

`src/setup/cli.ts` declares itself pure parsing and formatting, then imports `run.js` for a
single `instanceof` check, which pulls the adapter and its `fetch` calls into the CLI unit
test module graph. Nothing breaks, but the stated boundary is smeared. Moving
`SetupFailedError` to its own module restores it.

The 405 responses and the setup adapter's error paths are covered, but the in-route `-32603`
handler still echoes the SDK's own error message, the one response path carrying text that did
not originate in that file.

## Outstanding verification

The first live run happened on 2026-09-12 against the `helloironwright` developer tenant and
failed at the per-site grant, as recorded at the top of this document. Everything before that
call worked, so what is verified is: device-code sign-in, site resolution, application and
service principal creation, the Microsoft Graph app role assignment, and rollback on failure.

What remains unverified is everything after the grant: the client-credentials exchange, its
propagation retry, and the access check that mints a token for the new application. None of
that has ever executed. The setup command must not be described as working.
