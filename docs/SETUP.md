# Setup

One server instance serves one customer tenant. Setup is two commands rather than one. The
first, `--create-bootstrap`, runs once per tenant and creates a small, long-lived application
whose only job is issuing site permission grants. The second, the normal run, creates the
server's own application and grants it access to one SharePoint site, using the bootstrap
application's credentials for the one call that a signed-in person's token cannot make. Read
this whole document before running either command: the bootstrap application holds a
permission broad enough that you should decide you are comfortable with the design before you
create it, not after.

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
and which holds `Sites.FullControl.All` permanently rather than transiently. Isolating the
privilege this way costs a second application to track, but it means the server's own
application never holds more than `Sites.Selected`, including transiently, and the one
credential that can touch every site in the tenant is small, named for what it does, and easy
to audit or revoke on its own. `--create-bootstrap` creates that application. Decide whether
that tradeoff, a permanently privileged application in exchange for the server's own identity
never being broadly privileged even for an instant, is the one you want before you run it.

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
npm run setup -- --tenant=<tenant-id> --create-bootstrap --name="Ironwright Grant Issuer"
```

This takes no `--site`: the bootstrap application never touches a site, so there is nothing to
resolve. `--name` is optional and defaults to the same display name the normal run uses, which
is confusing side by side in the tenant's app list, so pass something that names what this
application is for.

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
exists in every tenant, so nobody has to register a bootstrap application before running this
command for the first time. There is nothing else it does: it carries the sign-in, and the app
registrations this command creates afterward have no relationship to it.

It is not pre-consented, though. Graph Command Line Tools is consented per scope on first use,
so an administrator signing in for the first time may see a one-time consent prompt, and that
application's name is what appears in the tenant's sign-in logs afterward. If you would rather
not consent a Microsoft first-party application in your tenant, or if Conditional Access policy
blocks it, register a small app registration of your own with public client flows enabled and
pass its application id with `--client-id=<your-app-id>`. That app only needs to exist and to
be allowed to request the delegated permissions this command uses. It needs no application
permissions of its own, because it is used solely to obtain the signed-in administrator's own
token for the calls this command makes on their behalf.

## Output

The normal run prints four values when it succeeds:

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

Nothing, if the rollback succeeds. A failed normal run that got as far as creating the app
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
reading the roles claim of the token it just used to verify. A token carrying no
`Sites.Selected` role means the application permission was never admin-consented, which needs a
Privileged Role Administrator or Global Administrator rather than another run of this command.
A token that carries the role and is still refused does not mean the per-site grant is absent:
this command already issued that grant moments earlier using the bootstrap application's token,
so the likelier explanation is that the grant has not propagated to this site yet. Wait and
check again before assuming anything failed. If it is still refused afterward, confirm with
`GET /sites/{site-id}/permissions` whether an entry for this app exists on this site at all;
if it does not, or names a different site, an administrator has to issue it directly with
`POST /sites/{site-id}/permissions` using the bootstrap application's own token.

A 401 means the credentials are wrong. A 404 means the site URL is wrong. Anything else is
printed with the full response body from Graph, since it does not match a cause this command
already recognizes.

Re-running the command is not a repair. It creates a second app registration with a second
secret rather than fixing the first one.
