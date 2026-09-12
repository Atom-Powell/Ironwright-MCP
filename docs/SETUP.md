# Setup

One server instance serves one customer tenant. Run this once per tenant.

## What you need

- A user with Application Administrator (or Cloud Application Administrator) rights in the target tenant, to create the app registration.
- A user with site owner rights on the target SharePoint site, to grant that app access to it. This can be the same person.
- Node 22 or later.

## Run it

```bash
npm install
npm run setup -- --tenant=<tenant-id> --site=https://<tenant>.sharepoint.com/sites/<SiteName> --write
```

Omit `--write` to grant read only site access, which is the right choice for a deployment that will never run remediation.

The command signs you in with a device code, creates a single tenant confidential client, adds a client secret, resolves the site, grants that one app access to that one site, and then verifies the grant using a token minted for the new app rather than your own.

That last step matters. `Sites.Selected` does nothing until a per site grant is issued, and an administrator's own token can read the site whether or not the grant exists, so verifying with your own credentials would report success against a server that cannot actually work.

## The device code sign in and its client id

Signing in with a device code requires an Entra application to sign into, the same way any interactive sign in does. By default this command signs in as the Azure CLI's own public client application. That application is pre-consented in every tenant, so a new customer can run this command and sign in without first creating any application of their own. There is nothing else it does: it exists only to carry the device code sign in, and the app registration this command creates afterward is a separate application with no relationship to it.

Some tenants block that client with Conditional Access policy, because it is a well known, widely used public client id and some administrators restrict sign in to applications they have registered themselves. If your sign in fails for that reason, register a small app registration in your tenant with public client flows enabled, and pass its application id with `--client-id=<your-app-id>`. That app only needs to exist. It does not need any API permissions, because it is used solely to obtain the signed in administrator's own token for the calls this command makes on their behalf.

## Output

The command prints four values when it succeeds:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `IW_SITE_ID`

Store them as deployment secrets, in Key Vault or the container app's secret store. Do not paste them into a chat, a ticket, or this repository. The client secret in particular is printed exactly once, by design, because Graph never returns it again after creation.

Writes stay disabled until `IW_ALLOW_WRITES=true` is set on the deployment, regardless of the site permission granted here.

## If verification fails

The command maps the failure to a cause rather than passing the raw status through, because the causes do not read the way you would expect. A 403 means the per site grant is missing, which is by far the most common outcome and looks nothing like its cause: it looks like a broken app registration, when the registration is almost always fine. A 401 means the credentials are wrong. A 404 means the site URL is wrong. Anything else is printed with the full response body from Graph, since it does not match a cause this command already recognizes.
