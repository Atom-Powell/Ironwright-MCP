# Setup

One server instance serves one customer tenant. Setup has four modes rather than one command.
`--create-bootstrap` runs once per tenant and creates a small application whose only job is
issuing and revoking site permission grants. The normal run creates the server's own application
and grants it access to one SharePoint site, using the bootstrap application's credentials for the
one call that a signed-in person's token cannot make. `--delete-server-app` removes that server
application and the site permission it was granted, in the order that keeps the permission entry
revocable while its identity still exists, and is how a site gets decommissioned.
`--delete-bootstrap` removes the bootstrap application itself; it is meant to be kept, not deleted
right after onboarding, because `--delete-server-app` needs it for as long as any site it helped
onboard is still live. Read this whole document before running any of them: the bootstrap
application holds a permission broad enough that you should decide you are comfortable with the
design before you create it, not after.

## Why bootstrapping is a separate step

A live run of this tool on 2026-09-12 against a real developer tenant reached the per-site
permission grant, `POST /sites/{site-id}/permissions`, and was refused with a 403. The
signed-in account was a Global Administrator on that tenant and site, which rules out
insufficient rights as the explanation. Microsoft's own reference for that endpoint lists only
an application permission as supported and marks delegated access unsupported, and this run
confirms that restriction is enforced, not theoretical. No directory role fixes it, because the
problem is not the caller's rights, it is the kind of token Graph will accept at that one
endpoint: it has to be an application's own token, not a person's.

That forces every setup command in this space into the same corner. Something has to hold an
application permission broad enough to grant site access before any site-specific grant exists,
because the server's own application cannot grant itself the permission it needs. The obvious
shortcut is to give the server's own application that broad permission temporarily: grant it
`Sites.FullControl.All`, have it mint an app-only token and issue its own per-site grant, then
remove the role assignment. That reaches the right end state, but removing a role assignment
does not revoke a token already issued under it, so for roughly an hour a credential with
tenant-wide control over every SharePoint site in the tenant would exist, attached to the same
application this project's whole design otherwise limits to `Sites.Selected`. This project's
security posture is built on refusing exactly that kind of standing broad grant, even
temporarily, so the shortcut was rejected.

The alternative is to put the standing privilege somewhere else: a separate application,
created once per tenant, whose only purpose is issuing and revoking site permission grants,
and which holds `Sites.FullControl.All` for as long as it exists rather than transiently on the
server's own identity. Isolating the privilege this way costs a second application to track,
but it means the server's own application never holds more than `Sites.Selected`, including
transiently, and the one credential that can touch every site in the tenant is small, named for
what it does, and easy to audit or revoke on its own. `--create-bootstrap` creates that
application. Its secret is issued with a seven-day expiry and rotated with each recreation, and
the application itself is meant to be deleted once every site it onboarded has in turn been
decommissioned, not once the current onboarding finishes; see "Retiring the grant issuer" below.

## What you need

- A user with Application Administrator or Cloud Application Administrator rights in the
  target tenant, to create an app registration and its service principal. `--create-bootstrap`
  and the normal run each create one, so both of those two modes need this.
- A user with Privileged Role Administrator or Global Administrator rights, to grant admin
  consent for a Microsoft Graph application permission. This is required for `--create-bootstrap`
  and the normal run too, and it is worth stating plainly because it is easy to assume
  Application Administrator covers it: that role can consent to every API except Microsoft
  Graph, and both `Sites.FullControl.All` and `Sites.Selected` are Microsoft Graph permissions.
  This is the one prerequisite no script can work around for those two modes. The two roles
  above can be the same person, and in practice usually are, since a Global Administrator
  satisfies both.
- `--delete-bootstrap` needs only Application Administrator or Cloud Application Administrator, and needs it for a narrower reason
  than the other two modes: deleting the grant issuer and purging it afterward are directory-object
  operations, not consent operations, so no admin consent is involved and Privileged Role
  Administrator or Global Administrator is not required. This matters when deciding who can run
  teardown in a customer tenant: it can be delegated to whoever holds either of those roles
  there, without also asking for one of the two more senior roles.
- `--delete-server-app` needs the same Application Administrator or Cloud Application
  Administrator rights as `--delete-bootstrap`, for the same reason: deleting the server
  application and purging it afterward are directory-object operations, not consent operations.
  It also needs `IW_BOOTSTRAP_CLIENT_ID` and `IW_BOOTSTRAP_CLIENT_SECRET`, the grant issuer's own
  credentials, to revoke the per-site permission entry before deleting the application it was
  granted to. `--force-orphan` is the only way to run it without them, and it leaves that entry
  behind on the site.
- Site owner rights are not required for any of the four modes. The per-site grant is issued by
  the bootstrap application's own token, not by the signed-in operator's, so nobody running these
  commands needs any standing permission on the SharePoint site itself.
- Node 22.2 or later, which is what `engines.node` declares. The floor is 22.2 rather than 22.0
  because `scripts/seed-library.ts` builds the synthetic tracking workbook's ZIP container with
  `zlib.crc32`, which landed in that release.

## Running `--create-bootstrap`

```bash
npm install
npm run setup -- --tenant=<tenant-id> --create-bootstrap
```

This takes no `--site`: the bootstrap application never touches a site, so there is nothing to
resolve. It registers the application as `Ironwright Grant Issuer`, which is deliberately not
the name the normal run uses, so the two are told apart in the tenant's app list and nobody
rotates the secret on the wrong one. Pass `--name` if you would rather call it something else.

The command refuses to run if an application with that name already exists, rather than adding
a second holder of `Sites.FullControl.All` that looks identical to the first. It names the
existing application and what to do with it. If its secret was never recorded or has expired,
or if its `Sites.FullControl.All` permission was never consented, delete that application and
run this again. That last case is what an operator following the normal run's own preflight
message reaches this command for, so it is a supported path here, not a dead end.

The command signs you in with a device code, resolves Microsoft Graph's own service principal
to find the real `Sites.FullControl.All` application role id, creates the application and its
service principal, and assigns that role from the new service principal to Graph's, which is
what admin consent means for an application permission. There is no separate consent step to
perform afterward in the portal. An earlier version of this command's own output implied one;
if you see language elsewhere suggesting the bootstrap application still needs consenting after
this command finishes, that is wrong. If the role assignment call in this command succeeds at
all, consent already happened, because that call only succeeds for a signed-in Privileged Role
Administrator or Global Administrator in the first place.

On success it prints:

- `IW_BOOTSTRAP_CLIENT_ID`
- `IW_BOOTSTRAP_CLIENT_SECRET`

Store these as the grant-issuing application's credentials, in Key Vault or the container app's
secret store, and not in the repository or a command line. They belong in the environment as
`IW_BOOTSTRAP_CLIENT_ID` and `IW_BOOTSTRAP_CLIENT_SECRET`, which is where every later normal run
reads them from. A command-line flag, `--bootstrap-client-id` and `--bootstrap-client-secret`,
exists too, but only as a fallback for a caller that already manages secrets some other way: a
flag puts a credential for an application holding tenant-wide site control into shell history,
which the environment variables do not.

## Retiring the grant issuer

The recommended posture is to keep the grant-issuing application until every site it helped
onboard has itself been decommissioned, not to delete it once the current onboarding finishes.
`--delete-server-app`, covered below, is how a site gets decommissioned, and its first step,
revoking the per-site permission entry the grant issuer originally issued, needs that same
grant issuer's own app-only token. Deleting the grant issuer early does not save anything: it
only means recreating one with `--create-bootstrap` before that revoke can run at all. Delete it
once, at the end, when no server application it provisioned still needs a permission revoked:

```bash
npm run setup -- --tenant=<tenant-id> --delete-bootstrap --confirm
```

This takes no `--site`, for the same reason `--create-bootstrap` does not: the grant issuer
never touches a site itself. Dry run is the default here, the same as every other destructive
path in this project: omit `--confirm` first to see which application this command found and
that it would delete and purge it, and pass `--confirm` only once that preview looks right. This
is a deliberate gate, not the original behavior of this command: purging is irreversible in a way
a plain delete is not, since recreating a grant issuer under the same name with
`--create-bootstrap` mints a new object id and a new secret, not the one just purged, so there is
no undoing a wrong purge the way there is no undoing any other confirmed write in this project.

It signs you in with a device code, finds the application by the display name `--create-bootstrap`
used (pass `--name` if you gave it a different one), and, once confirmed, deletes it, then purges
it from the tenant's deleted items, which is what actually ends its `Sites.FullControl.All`
permission rather than merely scheduling its removal; see the purge paragraph below. It refuses to
run alongside `--create-bootstrap`, and it refuses to guess which application to delete if more
than one matches that name, rather than removing one of several identically named holders of
`Sites.FullControl.All`.

Unlike the normal run, `--delete-bootstrap` needs no `IW_BOOTSTRAP_CLIENT_ID` or
`IW_BOOTSTRAP_CLIENT_SECRET`. It acts using only the signed-in device-code session, the same
one every mode uses to create the app registration in the first place, because deleting an
application registration needs Application Administrator rights over the directory object
itself, not the bootstrap application's own credentials. That is deliberate: this mode also
covers a grant issuer whose secret was never recorded or has already expired, and requiring
that exact secret here would make it unusable in precisely the situation it is for. If you have
lost or outlived the bootstrap secret, you do not need to recreate the grant issuer just to
remove it; run this command as it is.

The secret's seven-day expiry and deletion are not the same thing, and treating them as
interchangeable is the mistake this section exists to prevent. The expiry disables one
credential: after the secret lapses, nobody can mint a new token with it, but the application
object is untouched, and so is the admin-consented `Sites.FullControl.All` role assignment it
holds. Anyone in the tenant with Application Administrator rights can add a new secret to that
application and regain tenant-wide SharePoint access, with no further consent prompt, for as long
as the application still exists. Deletion removes the application object itself, and with it every
role assignment it held. Only deletion ends the standing privilege; expiry only ends one way of
using it.

This matters more in a customer tenant than in a developer one. The grant issuer holds full
control over every SharePoint site the customer owns for as long as it exists, so a client
security review will ask how long that is. Under the posture above, the honest answer is: for
the life of every site it onboarded, because a live server application may still need its
permission revoked at any point up to that site's decommissioning. That is a real, standing
privilege for that whole span, not a one-time bootstrap cost, so the answer a security review
needs is not "it is deleted quickly" but "it is tracked, its secret is rotated on a seven-day
cycle, and it is deleted once nothing it provisioned still depends on it."

Deleting the grant issuer does not affect an already-deployed server. The server's own
application holds `Sites.Selected` and its own per-site grant, both issued during the normal
run, and neither depends on the grant issuer continuing to exist. The deployed server keeps
working after `--delete-bootstrap` succeeds; what stops working is any later attempt to revoke
that server's own permission entry through `--delete-server-app`, which is exactly why this
section recommends deleting the grant issuer last, not first.

One caveat to the claim above that deletion ends the standing privilege: Entra's delete of an
application registration is a soft delete, not an immediate purge. The application sits in the
tenant's deleted items for 30 days, where the same Application Administrator rights this command
needed can restore it, role assignment and all. That is true of every application deletion in
Entra, not a gap specific to this command, which is exactly why a confirmed `--delete-bootstrap`
run purges the application immediately afterward, the same way `--delete-server-app` below does
for the server application: stopping at the delete would schedule the removal of a tenant-wide
credential thirty days out rather than performing it, and the grant issuer holds the broader of
the two permissions this project isolates, so leaving that gap open here would be worse, not
better, than leaving it on the server application.

The purge can still fail to confirm anything even when nothing is actually wrong. It runs
immediately after the delete, in the same directory that has not always finished replicating the
delete yet, and Graph answers a purge against an object that has not surfaced in deleted items
with the same 404 it would return for one that is already gone. This command retries that specific
404 on a short ladder before giving up, and its own output says plainly whether the purge was
confirmed or not, and, separately, whether the retry ladder actually ran; a run that ends without
confirming the purge is not necessarily a failure, but it does mean checking App registrations,
Deleted applications in the Entra admin portal before treating the credential as gone. If a
confirmed purge is not enough, for example ahead of a client security review that wants
independent verification, check that portal view regardless of what this command reported.

Once the grant issuer is deleted, remove `IW_BOOTSTRAP_CLIENT_ID` and `IW_BOOTSTRAP_CLIENT_SECRET`
from wherever you stored them. Left in place, they name an application that no longer exists,
and the next normal run that reads them fails at its preflight with a rejected-credentials
message that reads like a wrong secret rather than a deleted application.

Treat the grant issuer, for its entire lifetime, as a privileged credential with a tracked owner
and an expiry date, not as permanent infrastructure and not as disposable bootstrap scaffolding
either. It is neither: it is a standing credential that this product's own teardown path depends
on for as long as any site it provisioned is still live.

## Running the normal setup

```bash
npm run setup -- --tenant=<tenant-id> --site=https://<tenant>.sharepoint.com/sites/<SiteName> --write
```

Omit `--write` to grant read-only site access, which is the right choice for a deployment that
will never run remediation.

**`--write` is decided when the application is created, and no mode of this command widens an
existing grant.** `--write` only shapes the per-site permission that a full `runSetup` issues for
the application it is creating in that same run. Re-running setup with `--write` against a
deployment that was granted read is therefore the wrong move: it creates a SECOND application,
prints a new client secret to stdout, and leaves the live registration in place and unchanged, so
the deployment is now orphaned from the grant you just widened, and a secret is in a terminal
scrollback. Widening today means patching the existing site permission entry directly, with the
grant issuer's app-only token: list `GET /sites/{site-id}/permissions`, find the entry whose
`grantedToIdentitiesV2[0].application.id` is the server application's client id, matching on that
id rather than on position so another application's grant on the same site cannot be widened by
accident, and `PATCH` that one entry with `{"roles": ["write"]}`. Restore it to `read` the same way
when the write work is finished. The 2026-09-19 rename sitting did exactly this, in both
directions, rather than re-running setup. A first-class command for this is not built; when one is,
it belongs here.

Before this command does anything else, it checks that `IW_BOOTSTRAP_CLIENT_ID` and
`IW_BOOTSTRAP_CLIENT_SECRET` are set and that the token they produce carries
`Sites.FullControl.All`. If either check fails, it refuses to create anything and says which
credential is missing or which permission is absent, rather than signing you in, creating an
application, a secret, a service principal, and a consented role assignment, and only then
failing at the per-site grant with a rollback that deletes everything it just made. Run
`--create-bootstrap` first if you see this.

## The permission model

**The server refuses to run with more than `Sites.Selected`.** Before it opens its port, and again
on every new token it obtains, the server reads its own token's application roles and refuses any
token that carries anything other than exactly `Sites.Selected`. Adding a permission such as
`Files.Read.All` to the server application would otherwise widen it to every site in the tenant
without a sign. At startup a mismatch stops the process with a message naming the extra or missing
permissions. Remove the extra permission from the server application in Entra and start it again.
While running, a tool call that is handed a refused token stops there with the same explanation,
though it may already have read from Graph with the token before it. Once the extra permission is
removed, the change takes effect when the server's current token expires, up to about an hour, or
immediately on restart, because the refused token stays cached until then. If no token can be
obtained at startup at all, because Entra is unreachable or refuses the client id or secret, the
server logs a warning and starts anyway, and the check runs on the first token it does obtain. It
never starts anyway on a mismatch.

`Sites.Selected` is two grants, not one, and the second is worthless without the first.

The first grant is the application permission itself. The app registration this command
creates has to request Microsoft Graph's `Sites.Selected` app role, and an administrator has to
consent to it in the tenant. Until that happens, tokens issued for the app carry no roles claim
at all and Graph refuses everything the app asks for. The second grant is per site.
`POST /sites/{site-id}/permissions` names one app and one site, and it is what turns a
consented `Sites.Selected` into read or write access to that one library. This is the
least-privilege boundary the whole project rests on: the server's application can reach the
sites it was granted and no others.

The command performs both grants, in order, using two different tokens, and then verifies. It
resolves the site first, so a mistyped URL costs nothing. Then it creates the registration with
`Sites.Selected` requested, creates the service principal for it, assigns the app role from that
service principal to Microsoft Graph's service principal using your own signed-in token, which
is the admin consent step and needs the same Privileged Role Administrator or Global
Administrator rights described above, grants the per-site permission using the bootstrap
application's app-only token, and finally calls Graph as the new app to confirm the result.

The service principal matters more than it looks. `POST /applications` creates a registration,
not an identity. Without an explicit `POST /servicePrincipals` there is nothing in the tenant
for a role assignment to attach to and nothing for the token endpoint to resolve, and the first
client credentials request fails with AADSTS700016 naming an application that plainly does
exist.

Setup runs from a development install, which is what a plain `npm install` in a clone gives
you. It is the only thing in this repository that needs `@azure/identity`, and that package
pulls in an interactive authentication stack that has no business inside a container holding
bulk write credentials, so it is a development dependency along with the TypeScript runner the
command is launched with. A production install made with `--omit=dev` runs the server and not
this command.

## Running `--delete-server-app`

```bash
npm run setup -- --tenant=<tenant-id> --site=https://<tenant>.sharepoint.com/sites/<SiteName> --delete-server-app --confirm
```

This is the counterpart to the normal run above: it removes the server application that a normal
run created and the per-site permission it was granted, rather than creating either. It is how a
site gets decommissioned. Dry run is the default here, the same as every other destructive path
in this project: omit `--confirm` first to see what the command found and exactly what it would
do, and pass `--confirm` only once that preview looks right.

The order it acts in is forced, not a preference. The per-site permission entry is matched to the
application by its application id, so revoking it has to happen while that identity still exists;
deleting the application first would leave an entry naming an id nothing can look up again. So
this command lists the site's permissions and revokes the matching entry, then deletes the
application, then purges it from the tenant's deleted items. The purge is not optional cleanup:
Entra's delete of an application registration is a soft delete, and the object stays restorable,
with its credentials, in the tenant's deleted items for 30 days. Stopping at the delete schedules
the credential's removal thirty days out rather than performing it, so this command always purges
after a delete that succeeds, the same way a confirmed `--delete-bootstrap` above purges the grant
issuer.

Revoking the permission entry needs a grant issuer's own app-only token, the same
`IW_BOOTSTRAP_CLIENT_ID` and `IW_BOOTSTRAP_CLIENT_SECRET` a normal run needs. This is exactly why
"Retiring the grant issuer" above recommends keeping the grant issuer around rather than deleting
it right after onboarding: without it, this command cannot even look up the permission entry it
is trying to remove, let alone revoke it.

If the grant issuer is genuinely gone, pass `--force-orphan` to delete and purge the server
application anyway. It skips the permission listing entirely rather than guessing at what it
would have found, and says so plainly in its output: any permission entry this application held
may still remain on the site afterward, naming an identity that no longer exists and granting
access to nothing. Removing that residue later needs a grant issuer created with
`--create-bootstrap` and the entry identified by hand in the site's permissions. `--force-orphan`
is a deliberate escape hatch for a grant issuer that is already gone, not a routine option; the
posture in "Retiring the grant issuer" exists so that revoking a site's permission entry never has
to fall back to it.

If no application with the run's display name exists in the tenant, the command reports that as
the finished state rather than as a failure, and exits zero: the outcome you asked for is already
true. A permission entry granted to it may still sit on the site even so, because this command
cannot find one once the application it named is gone; clearing that needs the entry identified
by hand in the site's permissions.

If the delete succeeds but the purge that follows it fails, re-running this command will not
retry the purge: the application is now soft-deleted, and the lookup this command uses to find it
does not return a soft-deleted one, so a re-run reports it already absent instead. The failure
message names the manual purge call to make by hand. This is a known limitation, recorded in
`docs/OPEN-ITEMS.md`.

Deleting the server application invalidates the deployment's credentials immediately:
`AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` from the normal run now name an application that no
longer exists. Onboarding this site again needs a fresh application, which is what a plain normal
run, without `--delete-server-app`, produces.

## The device code sign-in and its client id

Signing in with a device code requires an Entra application to sign into, the same way any
interactive sign-in does, and all four modes use it. By default this command signs in as
`14d82eec-204b-4c2f-b7e8-296a70dab67e`, which is Microsoft's Graph Command Line Tools
application, the public client that Microsoft Graph PowerShell and the Graph CLI sign in as. It
exists in every tenant, so nobody has to register a public-client sign-in application of their
own before running this command for the first time. There is nothing else it does: it carries the sign-in, and the app
registrations this command creates afterward have no relationship to it.

It is not pre-consented, though. Graph Command Line Tools is consented per scope on first use,
so an administrator signing in for the first time may see a one-time consent prompt, and that
application's name is what appears in the tenant's sign-in logs afterward. If you would rather
not consent a Microsoft first-party application in your tenant, or if Conditional Access policy
blocks it, register a public-client sign-in application of your own, with public client flows
enabled, and pass its application id with `--client-id=<your-app-id>`. That app only needs to
exist and to be allowed to request the delegated permissions this command uses. It needs no
application permissions of its own, because it is used solely to obtain the signed-in
administrator's own token for the calls this command makes on their behalf.

This is not the bootstrap application, and the two are not interchangeable. The bootstrap
application is a confidential client holding `Sites.FullControl.All`, with no public client
flows, so passing `IW_BOOTSTRAP_CLIENT_ID` to `--client-id` fails the device-code sign-in for a
reason the error will not make obvious.

## Output

The normal run prints four values when it succeeds, and the same four when it finishes without
being able to confirm access:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `IW_SITE_ID`

Store them as deployment secrets, in Key Vault or the container app's secret store. Do not
paste them into a chat, a ticket, or this repository. The client secret in particular is
printed exactly once, by design, because Graph never returns it again after creation. The
bootstrap run's two values, described above, belong the same way: in the deployment's secret
store, read from the environment, never committed.

Writes stay disabled until `IW_ALLOW_WRITES=true` is set on the deployment, regardless of the
site permission granted here.

## What a failed run leaves behind

Nothing, if the rollback succeeds, with one deliberate exception described in the next
section: a run whose verification call is refused by a token that does carry the
`Sites.Selected` role keeps everything it made, because that combination means the
configuration is right and the directory has not caught up. That run prints its four values
and says plainly that an application and a grant are now live in the tenant.

Every other failure rolls back. A failed normal run that got as far as creating the app
registration deletes it again, along with the site permission if one was granted by then.
Deleting the registration also removes its service principal and the client secret held on it,
so a failed attempt does not leave a working credential in the tenant. A failed
`--create-bootstrap` run rolls back the same way: it deletes the application it created if a
later step fails, since that application never touched a site and has nothing else to undo.

If the rollback itself fails, the command says so and names the application id and object id to
delete by hand. That message is the one case where manual cleanup is required, and it is worth
acting on immediately, because the abandoned registration holds a client secret that was
printed nowhere.

## If verification fails

The normal run maps a failed verification call to a cause rather than passing the raw status
through, because the causes do not read the way you would expect.

A 403 has two possible causes and they need opposite fixes, so the command tells them apart by
reading the roles claim of the token it just used to verify.

A token that carries the `Sites.Selected` role and is still refused is the case the command
treats as a success it could not confirm. The role proves the application permission is in
effect, and the command issued the per-site grant itself moments earlier, so the configuration
is correct and the likeliest remaining explanation is that the grant has not propagated to this
site yet. Destroying a correct application and a correct grant over that is the wrong response,
so the command keeps both, prints the four values exactly as a confirmed run does, and says
that access could not be confirmed yet. Nothing needs creating again. Wait a short while and
try the app's own access again, and if it is still refused, check
`GET /sites/{site-id}/permissions` for an entry naming this app; if none is there an
administrator can issue one with `POST /sites/{site-id}/permissions` using the bootstrap
application's own token.

A token carrying no `Sites.Selected` role means the application permission is not in effect.
That run rolls back, so there is nothing left in the tenant to consent to afterward. The role
assignment the command makes is itself the consent, and reaching verification means that call
already succeeded, so the likeliest cause is that the assignment had not reached a newly issued
token yet. Wait a minute and run the command again. A second attempt that fails the same way
means the assignment is not taking effect, which needs a Privileged Role Administrator or
Global Administrator.

A token that could not be read leaves both causes open, and that run rolls back too.

A 401 means the credentials are wrong. A 404 means the site URL is wrong. Anything else is
printed with the full response body from Graph, since it does not match a cause this command
already recognizes.

Running the command again after a rollback is how you retry, since the rollback left nothing
behind. Running it again after a run that kept its application is not a repair: it would create
a second app registration with a second secret rather than fixing the first one.

## Library-only profiles

A document library with no tracking workbook can still be onboarded, for inventory, the
empty-folder question and plans an operator describes with `generate_custom_plan`. Its profile
names only the site and the library:

```json
{
  "kind": "library",
  "profileId": "shared-docs",
  "identity": {
    "siteUrl": "https://contoso.sharepoint.com/sites/Example",
    "library": "Shared Documents"
  }
}
```

A profile without `kind` is a compliance profile, as every profile before phase 6d was. A
library-only profile may not carry compliance fields; the server refuses one that does rather than
ignoring them. The tools that need a workbook refuse a library-only profile by name and say which
tools do work with it. `examples/profiles/library-example.json` is the committed example.

Any profile, of either kind, may be written with `sites` instead of `identity`. `sites` is a
non-empty list of entries with `siteUrl` and `library`, and optionally `searchRegion`, `clientId`
and `workbookPath`; `identity` is then the first entry. A compliance profile requires `workbookPath` on every site, and a library profile refuses it. This phase still checks every listed site
against the one granted site, `IW_SITE_URL`, so a profile naming a second site fails at startup.

## Running the server

`npm start` runs the MCP server itself, `dist/server/main.js`. It reads its own environment at
startup and fails before the port is bound rather than on the first tool call, because a
misconfigured deployment should refuse to come up rather than report itself healthy and then fail
the first request it receives.

**Build it with `npm run build:prod`, not `npm run build`, for anything an operator will keep.**
The two compiles differ on purpose and the difference is a security boundary. `npm run build` is
the development compile and emits `dist/setup/`, the per-tenant setup command, which issues site
permission grants through a separate application holding `Sites.FullControl.All`. That machinery
belongs on the workstation you are reading this on and nowhere near a running server, because it
widens what a compromise of that server reaches from "can read one granted site" to "contains the
means to grant access to others". `npm run build:prod` clears `dist` and compiles without
`src/setup`, so what `npm start` then runs carries none of it. Run the development build freely
while working; run the production build for the artifact you deploy, and note that running the
development build afterward puts the setup output back.

- `IW_PROFILE_DIR` is required. It names a directory, and every `*.json` file in it is read and
  validated once at startup, indexed by the `profileId` field inside the file rather than by the
  filename. A profile that fails validation, or two files claiming the same `profileId`, fails
  the deployment. Profiles are deployment configuration and are never committed, so there is no
  default to fall back to.
- `IW_TENANT_ID`, `IW_CLIENT_ID`, and `IW_CLIENT_SECRET` are required. These are the server
  application's own client-credentials identity, the same three values the normal setup run above
  prints as `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`, and the same three
  `npm run scan` already reads under their `IW_` names, described below.
- `IW_SITE_URL` is required. It is the same `--site` value you passed to the normal setup run
  above, not one of the four values that run prints, since a site URL is not a secret and setup
  already had it as an input rather than an output. The server checks every profile's
  `identity.siteUrl` against this value at startup and refuses to start if any profile names a
  different site, rather than letting that mismatch surface later as a 403 on the profile's first
  Graph call, a failure this server has already been corrected once for being misleading about.
  `describe_workbook` also reads it directly, since that tool runs before any profile exists and
  has no other way to know which site it may reach. Phase 5 hosting must set this in the
  deployment definition or the server will not start.
- `IW_TABLE_CONNECTION_STRING` is optional to the server and expected of any deployment. The
  server starts without it and falls back to an in-memory state store, the same fallback
  `npm run scan` uses: nothing persists across a restart, and every tool call that triggers a scan
  performs a full enumeration rather than an incremental one, since there is no `deltaLink` from
  an earlier run to resume from. That is a reasonable local run and a poor deployment, which is
  why the deployment contract below lists it as optional rather than required: the distinction is
  what the server enforces, not what an operator should do. The Azure Table state store creates
  four tables under this connection string, each on first use (`ensureTables` creates all four):
  `DeltaLinks`, one row per drive's persisted continuation link; `Inventory`, the repository
  snapshot each scan reconciles against; `Plans`, which holds generated rename plans and the
  reversal logs that undo them, both under the same entity shape; and `Journal`, the per-assessment
  journal that plan 9c's lifecycle tools append to.
- `PORT` defaults to 3000 if unset.
- `IW_ALLOW_WRITES` stays unset, and writes stay disabled, until an operator opts a deployment in
  by setting it to `true`, regardless of the site permission granted by the normal setup run.
- `IW_SHUTDOWN_DEADLINE_MS` defaults to 25000. It bounds how long the server keeps draining
  in-flight requests after SIGTERM before exiting anyway. See the deployment contract below.

Until phase 4a wired the first tool, none of this was read by the server itself: only
`npm run scan` read the Graph credentials and the store connection string, and nothing read
`IW_PROFILE_DIR` at all. As of this branch the server requires these variables at startup and
will not come up without them. See `src/server/config.ts` and `src/config.ts` for what is
actually checked.

### Ingress

Three ways to put the server in front of a caller such as Copilot Studio are designed. Dev tunnels
are the quick start for trying it from a workstation. Cloudflare Tunnel on a domain the operator
owns is the durable path that needs no Azure subscription. Azure Container Apps is the reference
cloud deployment. Plan 9d carries the full procedure for each; this phase builds the inbound key
all three rely on.

## Deployment configuration contract

Phase 5a made the server deployable. Phase 5b is what actually deploys it, into Container Apps
or anywhere else. This section exists so that phase does not have to reread `src/config.ts` and
`src/server/config.ts` to learn what a deployment must supply: a deployment that discovers a
required variable is missing at startup has already failed, so every variable the running server
reads belongs in one list rather than scattered across the sections above. Nothing here is new
behavior; it collects variables already documented individually under "Running the server" and
adds the one that phase 5a introduced.

**Required.**

- `IW_TENANT_ID`, `IW_CLIENT_ID`, `IW_CLIENT_SECRET`. The server application's own
  client-credentials identity, the same three values the normal setup run above prints as
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`.
- `IW_SITE_URL`. The site the server's `Sites.Selected` grant covers. It became required in
  phase 4c, and the profile registry checks every profile's `identity.siteUrl` against it at
  startup, refusing to start on a mismatch rather than letting it surface later as a 403 on a
  profile's first Graph call. A deployment definition that omits it does not produce a degraded
  server; the server does not start at all.
- `IW_PROFILE_DIR`. Names the directory holding this deployment's profile files, each validated
  once at startup. Profiles are deployment configuration and are never committed, so there is no
  default to fall back to.
- `IW_INBOUND_KEY`. The shared key every request except `/health` must carry. At least 16
  characters; required unless `IW_INBOUND_AUTH` is `none`.

Inbound authentication has three more variables, all optional.

- `IW_INBOUND_AUTH`. `apikey` (the default) reads the key from a header, `bearer` reads it from
  `Authorization: Bearer`, and `none` disables the check.
- `IW_INBOUND_KEY_HEADER`. The header that carries the key in `apikey` mode. Defaults to
  `x-api-key`.
- `IW_ALLOW_ANONYMOUS`. Must be `1` for `IW_INBOUND_AUTH=none` to start.

The server refuses to start without a key. `src/config.ts` names the missing variable and suggests
a generator: `node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"`.
Mode `none` is for loopback development only and needs `IW_ALLOW_ANONYMOUS=1` as a second,
deliberate confirmation. `/health` stays open and every other route is behind the check. The key
never appears in logs, and the startup line reports the auth mode and never the key.

**Optional.**

- `IW_TABLE_CONNECTION_STRING`. Its absence selects the in-memory state store rather than
  failing, so a local run needs no cloud account. Nothing persists across a restart under that
  fallback, and every scan is a full enumeration rather than an incremental one.
- `IW_ALLOW_WRITES`. Its absence leaves every write tool unpublished rather than merely refused:
  `selectTools` in `src/tools/registry.ts` filters out every tool of kind `write` when writes are
  disabled, so a caller never sees `execute_rename_plan`, `execute_move_plan` or
  `replicate_template` in the first place. Set to `true` to opt a deployment in, regardless of
  the site permission the normal setup run above granted.
- `IW_SHUTDOWN_DEADLINE_MS`. How long the server waits, once it receives SIGTERM, for in-flight
  requests to drain before exiting anyway. Defaults to 25000, chosen to sit under a platform's
  usual 30 second grace period so the process exits on its own terms rather than being killed
  silently once that period runs out. When the deadline wins it logs one line saying the deadline
  was reached with the drain incomplete, and no count: Node's only runtime source for open socket
  counts answers on a deferred callback, and an exiting process does not wait for it, so a number
  is not obtainable and is not claimed.
- `PORT`. Documented above under "Running the server"; defaults to 3000.

**The artifact is what `npm run build:prod` emits, and the development build is not a substitute.**
It clears `dist` and compiles without `src/setup`, so the deployed tree carries no copy of the
grant-issuing setup command. See "Running the server" above for why that is a boundary rather than
a size saving. The clean is part of the script because `tsc` does not prune its own output
directory: without it, a tree where `npm run build` had run kept `dist/setup/` through the
production compile, and the boundary held only on a freshly cleaned checkout.

**Profiles arrive as a directory the deployment supplies, never committed and never baked into an
artifact.** `IW_PROFILE_DIR` names a path the running process reads at startup, and phase 5a's
contract with phase 5b stops there: the path must exist and must hold valid profiles when the
process starts. How that path gets populated in Azure, a mounted volume, a sidecar, or something
else, is phase 5b's problem and is deliberately not decided here. Baking a customer's taxonomy,
library and client list into an image would put deployment configuration where the Decision
Record already refuses to let profiles live.

## Running a scan

`npm run scan` runs the server's own reconciliation scan by hand, against a real tenant, ahead
of any MCP tool being wired up to call it. It reads a profile, resolves the site and library the
profile names, enumerates the drive with delta, and prints what it found.

```bash
npm run scan -- --profile profiles/acme.json
```

Pass `--sub-path <library-relative path>` to scope the run to one folder, such as a single
client's own subtree, rather than the whole library.

The command reads three environment variables, all required:

- `IW_TENANT_ID`
- `IW_CLIENT_ID`
- `IW_CLIENT_SECRET`

These are the server application's own client-credentials identity: the same tenant, application,
and secret that the normal setup run above produced as `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and
`AZURE_CLIENT_SECRET`. Setup prints them under the `AZURE_` names because that is the convention
Azure deployment tooling expects for a container app's secrets; the scan command reads the same
values under its own `IW_` names, so set both pairs, or export one pair under both sets of
names, in whatever secret store or shell holds them. If any of the three is missing or empty, the
command refuses to make any Graph call at all and names every missing variable in one message.

`IW_TABLE_CONNECTION_STRING` is optional. When it is not set, the scan uses an in-memory state
store: nothing is persisted, so a local run needs no storage account, but every run is a full
enumeration, since there is no deltaLink from a previous run to resume from. Set it to point at
an Azure Table Storage account to keep the inventory and the deltaLink between runs, which is
what lets a later run be incremental instead of a full re-enumeration.

To run against a local emulator rather than a real storage account:

```bash
npx azurite
IW_TABLE_CONNECTION_STRING=UseDevelopmentStorage=true npm run scan -- --profile profiles/acme.json
```

The scan's own output says which store it used, and states the Graph request count and the delta
page count. It then says one of two things about the Microsoft Search cross-check, which phase 2c
made part of every scan: that the cross-check completed, or which of four reasons it did not,
each with what that leaves unseen. A completed cross-check is the normal case and not a defect to
investigate. It also names how many of the scanned files carry no ETag at all, since Graph does not
always report one and this phase's snapshot stores that absence as an empty string rather than
marking it explicitly, which a later rename or move plan will need to know before trusting an
ETag as a precondition.

## Seeding a synthetic library for a scan performance comparison

`npm run scan` reports its own Graph request count precisely, so the project's founding claim,
that delta query plus a persisted `deltaLink` replaces a recursive enumeration costing "hundreds
of operations" on a large inventory, can be checked against a real tenant. Against the small
synthetic library this document's own onboarding runbook describes, two client folders and a
handful of files, that check proves nothing: the recursive baseline and delta cost about the
same handful of requests either way. `scripts/seed-library.ts` builds a tree large enough for the
difference to be visible.

```bash
npm run seed-library -- --profile profiles/acme.json
```

It reads the same profile JSON `npm run scan` takes, and derives the tree it builds from that
profile's `taxonomy.segments` and `naming.template`, so the synthetic tree matches the taxonomy
the scan itself expects. By default it builds twelve clients across all twelve months of the
current year, plus a quarterly deliverable at the end of each quarter, which comes to 157 folders
and 192 files for a profile shaped like `examples/profiles/example.json`. Pass `--clients
<count>`, `--year <yyyy>`, or `--no-quarterly` to build something smaller. The quarterly
deliverable is always placed in the last month of each calendar quarter (months 3, 6, 9, and 12);
that is a hard-coded simplification in the script, not read from the profile's own `periodAnchor`,
and is close enough for a synthetic sizing tree without matching the reconciliation engine's exact
placement logic.

Dry run is the default, the same as every other write path in this project: without `--confirm`
it prints the folder and file counts and an estimate of the Graph requests creating that tree
would cost, and creates nothing. The estimate is derived from the same list the write path walks,
one request per folder plus one per file plus the two requests resolving the site and the drive
costs, so it cannot drift from what a confirmed run actually does; it is still an estimate, not a
measured cost, since it assumes nothing is retried. It does not assume nothing already exists, and
it does not get cheaper on a re-run: the execution layer issues one request per folder and one per
file unconditionally, whether or not that item is already there, so a re-run against a tree this
script already built costs the same number of Graph requests as building it fresh. What changes on
a re-run is the side effect at each already-existing path, not the request count.

It authenticates as the grant issuer, using `IW_TENANT_ID`, `IW_BOOTSTRAP_CLIENT_ID`, and
`IW_BOOTSTRAP_CLIENT_SECRET`, the same credentials `--create-bootstrap` above prints. That
application already holds tenant-wide `Sites.FullControl.All`, so it can write, which is what
keeps the server's own application read-only for the request count this script exists to let an
operator measure: a production scan never writes, so measuring it with a credential that can
would be the wrong yardstick.

Folder creation uses Graph's `fail` conflict behavior, Graph's own default, not `replace`. A
folder's content is its children, and Graph documents `replace` as overwriting the existing item;
for a folder the plausible reading of "overwrite" is delete-then-recreate, taking everything
nested under it along with it. That is exactly the scenario reconciliation testing depends on
surviving: adding files by hand under a seeded month folder to produce orphans and duplicates,
then re-running this script to top up a partial tree, revisits every one of those folders. `fail`
cannot destroy anything it did not itself just create; the script tolerates the 409
`nameAlreadyExists` a folder that is already there returns, by its exact error code, and lets
every other failure propagate. File creation still uses `replace`: a file has no children for
`replace` to take with it, and every file this script writes is the same placeholder content, so
overwriting an existing synthetic file with identical content loses nothing.

Both of this section's open questions have since been answered, and the numbers are in
`docs/OPEN-ITEMS.md` rather than restated here in full. The seeder first ran against a tenant on
2026-09-17, processing 121 folders and 143 files in 266 Graph requests and replacing the tracking
workbook in 2 more; see "The second live tenant sitting, 2026-09-17". The founding performance
claim was checked a day earlier, on 2026-09-16, against a tree this seeder built: a cold scan
enumerated 144 files and 122 folders in 4 Graph requests and an immediate re-scan in 3, where a
recursive walk of the same tree would have cost at least one request per folder, so at least 122.
See "The first live tenant sitting, 2026-09-16". Those figures are one tree of that size on one
tenant, not a general benchmark.
