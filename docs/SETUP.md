# Setup

One server instance serves one customer tenant. Run this once per tenant.

## What you need

- A user with Application Administrator or Cloud Application Administrator rights in the target tenant, to create the app registration and its service principal.
- A user with Privileged Role Administrator or Global Administrator rights, to grant admin consent for the `Sites.Selected` application permission. Application Administrator is not enough for this one step: that role can consent to every API except Microsoft Graph, and `Sites.Selected` is a Microsoft Graph permission. This is the one prerequisite no script can work around.
- A user with site owner rights on the target SharePoint site, to grant that app access to it. All three can be the same person.
- Node 22 or later.

## The permission model

`Sites.Selected` is two grants, not one, and the second is worthless without the first.

The first grant is the application permission itself. The app registration has to request Microsoft Graph's `Sites.Selected` app role, and an administrator has to consent to it in the tenant. Until that happens, tokens issued for the app carry no roles claim at all and Graph refuses everything the app asks for.

The second grant is per site. `POST /sites/{site-id}/permissions` names one app and one site, and it is what turns a consented `Sites.Selected` into read or write access to that one library. This is the least-privilege boundary the whole project rests on: the app can reach the sites it was granted and no others.

The command performs both, in that order, and then verifies. It resolves the site first, so a mistyped URL costs nothing. Then it creates the registration with the app role requested, creates the service principal for it, assigns the app role from that service principal to Microsoft Graph's service principal, which is the admin consent step, grants the per-site permission, and finally calls Graph as the new app to confirm the result.

The service principal matters more than it looks. `POST /applications` creates a registration, not an identity. Without an explicit `POST /servicePrincipals` there is nothing in the tenant for a role assignment to attach to and nothing for the token endpoint to resolve, and the first client credentials request fails with AADSTS700016 naming an application that plainly does exist.

## Run it

```bash
npm install
npm run setup -- --tenant=<tenant-id> --site=https://<tenant>.sharepoint.com/sites/<SiteName> --write
```

Omit `--write` to grant read only site access, which is the right choice for a deployment that will never run remediation.

Setup runs from a development install, which is what a plain `npm install` in a clone gives you. It is the only thing in this repository that needs `@azure/identity`, and that package pulls in an interactive authentication stack that has no business inside a container holding bulk write credentials, so it is a development dependency along with the TypeScript runner the command is launched with. A production install made with `--omit=dev` runs the server and not this command.

The command signs you in with a device code, then runs the sequence above under your own token. Verification is the part worth keeping. It uses a token minted for the new app rather than yours, because an administrator's token can read the site whether or not any of this worked, so verifying with your own credentials would report success against a server that cannot actually run.

## The device code sign in and its client id

Signing in with a device code requires an Entra application to sign into, the same way any interactive sign in does. By default this command signs in as `14d82eec-204b-4c2f-b7e8-296a70dab67e`, which is Microsoft's Graph Command Line Tools application, the public client that Microsoft Graph PowerShell and the Graph CLI sign in as. It exists in every tenant, so nobody has to register a bootstrap application before running this command. There is nothing else it does: it carries the sign in, and the app registration this command creates afterward is a separate application with no relationship to it.

It is not pre-consented, though. Graph Command Line Tools is consented per scope on first use, so an administrator signing in for the first time may see a one-time consent prompt, and that application's name is what appears in the tenant's sign in logs afterward. If you would rather not consent a Microsoft first party application in your tenant, or if Conditional Access policy blocks it, register a small app registration of your own with public client flows enabled and pass its application id with `--client-id=<your-app-id>`. That app only needs to exist and to be allowed to request the delegated permissions this command uses. It needs no application permissions of its own, because it is used solely to obtain the signed in administrator's own token for the calls this command makes on their behalf.

## Output

The command prints four values when it succeeds:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `IW_SITE_ID`

Store them as deployment secrets, in Key Vault or the container app's secret store. Do not paste them into a chat, a ticket, or this repository. The client secret in particular is printed exactly once, by design, because Graph never returns it again after creation.

Writes stay disabled until `IW_ALLOW_WRITES=true` is set on the deployment, regardless of the site permission granted here.

## What a failed run leaves behind

Nothing, if the rollback succeeds. A run that fails after creating the app registration deletes it again, along with the site permission if one was granted by then. Deleting the registration also removes its service principal and the client secret held on it, so a failed attempt does not leave a working credential in the tenant.

If the rollback itself fails, the command says so and names the application id and object id to delete by hand. That message is the one case where manual cleanup is required, and it is worth acting on immediately, because the abandoned registration holds a client secret that was printed nowhere.

## If verification fails

The command maps the failure to a cause rather than passing the raw status through, because the causes do not read the way you would expect.

A 403 has two possible causes and they need opposite fixes, so the command tells them apart by reading the roles claim of the token it just used. A token carrying no `Sites.Selected` role means the application permission was never admin-consented, which needs a Privileged Role Administrator or Global Administrator rather than another run of this command. A token that carries the role and is still refused means the per-site grant is what is missing, and `POST /sites/{site-id}/permissions` for the named app and site is the fix. Directory changes can also take a short time to reach a newly issued token, so a consent granted seconds earlier can still read as absent.

A 401 means the credentials are wrong. A 404 means the site URL is wrong. Anything else is printed with the full response body from Graph, since it does not match a cause this command already recognizes.

Re-running the command is not a repair. It creates a second app registration with a second secret rather than fixing the first one.
