import { DeviceCodeCredential } from "@azure/identity";
import { createFetchSetupGraph } from "./adapter.js";
import { describeSignInFailure, extractAccessToken, parseArgs } from "./cli.js";
import { runSetup, SetupFailedError } from "./run.js";

async function main(): Promise<void> {
  const { tenantId, siteUrl, displayName, write, clientId } = parseArgs(process.argv);

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

  // Kept in its own try/catch, separate from the one around runSetup below,
  // because a failed or cancelled sign-in is a different kind of failure with
  // a different, specific next step: the --client-id escape hatch. Letting it
  // propagate to the default handler would print a raw stack trace for the
  // one failure mode docs/SETUP.md already anticipates by name.
  let adminToken;
  try {
    adminToken = await credential.getToken("https://graph.microsoft.com/.default");
  } catch (error) {
    console.error(describeSignInFailure(error));
    process.exitCode = 1;
    return;
  }

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
    return extractAccessToken(response.status, await response.text());
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
