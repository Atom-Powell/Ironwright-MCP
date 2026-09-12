# Setup

One server instance serves one customer tenant. Setup is two commands rather than one. The
first, `--create-bootstrap`, runs once per tenant and creates a small application whose only
job is issuing site permission grants. The second, the normal run, creates the
server's own application and grants it access to one SharePoint site, using the bootstrap
application's credentials for the one call that a signed-in person's token cannot make. Read
this whole document before running either command: the bootstrap application holds a
permission broad enough that you should decide you are comfortable with the design before you
create it, not after, and it is meant to be deleted again once setup is done.

## Why there are two commands

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
application. Its secret is issued with a seven-day expiry and the application itself is meant
to be deleted once setup is done, so the broad privilege exists during onboarding rather than
forever; see "Retiring the grant issuer after setup" below.

## What you need

- A user with Application Administrator or Cloud Application Administrator rights in the
  target tenant, to create an app registration and its service principal. Both commands create
  one, so both need this.
- A user with Privileged Role Administrator or Global Administrator rights, to grant admin
  consent for a Microsoft Graph application permission. This is required for both commands too,
  and it is worth stating plainly because it is easy to assume Application Administrator
  covers it: that role can consent to every API except Microsoft Graph, and both
  `Sites.FullControl.All` and `Sites.Selected` are Microsoft Graph permissions. This is the one
  prerequisite no script can work around. The two roles above can be the same person, and in
  practice usually are, since a Global Administrator satisfies both.
- Site owner rights are not required for either command. The per-site grant is issued by the
  bootstrap application's own token, not by the signed-in operator's, so nobody running these
  commands needs any standing permission on the SharePoint site itself.
- Node 22 or later.

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
delete that application and run this again.

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

## Retiring the grant issuer after setup

The recommended posture is to delete the grant-issuing application once setup is done, and to
recreate it with `--create-bootstrap` when the next site is onboarded. Its only job is issuing
per-site grants, which happens during a normal run and never afterward, so the running server
does not need it and neither does anything else. Deleting it shrinks the window in which a
tenant-wide SharePoint credential exists at all, from a week down to the minutes the setup
takes, and removes the standing application that holds `Sites.FullControl.All` along with it.

The secret expires on its own either way. `--create-bootstrap` sets an explicit seven-day
expiry rather than accepting Graph's two-year default, so a grant issuer that nobody remembers
to delete stops being a usable credential within the week. Recreating it later costs one
command and produces a fresh secret, so there is no rotation procedure to maintain and nothing
to renew.

Keep it only if you are onboarding sites often enough that recreating it each time is real
friction, and if you do, treat it as a privileged credential with an expiry date rather than
as permanent infrastructure.

## Running the normal setup

```bash
npm run setup -- --tenant=<tenant-id> --site=https://<tenant>.sharepoint.com/sites/<SiteName> --write
```

Omit `--write` to grant read-only site access, which is the right choice for a deployment that
will never run remediation.

Before this command does anything else, it checks that `IW_BOOTSTRAP_CLIENT_ID` and
`IW_BOOTSTRAP_CLIENT_SECRET` are set and that the token they produce carries
`Sites.FullControl.All`. If either check fails, it refuses to create anything and says which
credential is missing or which permission is absent, rather than signing you in, creating an
application, a secret, a service principal, and a consented role assignment, and only then
failing at the per-site grant with a rollback that deletes everything it just made. Run
`--create-bootstrap` first if you see this.

## The permission model

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

## The device code sign-in and its client id

Signing in with a device code requires an Entra application to sign into, the same way any
interactive sign-in does, and both commands use it. By default this command signs in as
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
