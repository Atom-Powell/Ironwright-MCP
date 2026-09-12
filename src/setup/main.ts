import { DeviceCodeCredential } from "@azure/identity";
import { createFetchSetupGraph } from "./adapter.js";
import { runSetup, SetupFailedError } from "./run.js";

// The Azure CLI's own public client id. It is pre-consented in every tenant,
// which is what makes the zero-setup path possible: a user can sign in and
// create an app registration without anyone first creating a bootstrap app to
// sign in with. Documented as the default in docs/SETUP.md, including that
// some tenants block it with Conditional Access and that --client-id lets a
// caller substitute their own bootstrap app registration instead.
const DEFAULT_DEVICE_CODE_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";

function requireArg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (found === undefined) throw new Error(`missing required argument ${prefix}<value>`);
  return found.slice(prefix.length);
}

function optionalArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

async function main(): Promise<void> {
  const tenantId = requireArg("tenant");
  const siteUrl = requireArg("site");
  const displayName = process.argv.includes("--name")
    ? requireArg("name")
    : "Ironwright Repository Reconciliation";
  const write = process.argv.includes("--write");
  const clientId = optionalArg("client-id") ?? DEFAULT_DEVICE_CODE_CLIENT_ID;

  // Device code, because creating an app registration needs a human with
  // Application Administrator rights. The server's own credentials cannot
  // bootstrap the app that holds them.
  const credential = new DeviceCodeCredential({
    tenantId,
    clientId,
    userPromptCallback: (info) => {
      console.log(info.message);
    },
  });

  const adminToken = await credential.getToken("https://graph.microsoft.com/.default");

  const graph = createFetchSetupGraph(adminToken.token, async (appId, secret) => {
    const body = new URLSearchParams({
      client_id: appId,
      client_secret: secret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await response.json()) as { access_token?: string };
    if (json.access_token === undefined) throw new Error("client credentials flow returned no access token");
    return json.access_token;
  });

  try {
    const result = await runSetup(graph, { displayName, siteUrl, write });
    console.log("Setup complete. Store these as deployment secrets, not in the repository.");
    console.log(`  AZURE_TENANT_ID=${tenantId}`);
    console.log(`  AZURE_CLIENT_ID=${result.appId}`);
    console.log(`  AZURE_CLIENT_SECRET=${result.secret}`);
    console.log(`  IW_SITE_ID=${result.siteId}`);
  } catch (error) {
    if (error instanceof SetupFailedError) {
      console.error(`Setup failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

await main();
