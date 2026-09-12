import { DeviceCodeCredential } from "@azure/identity";
import { createFetchSetupGraph } from "./adapter.js";
import {
  acquireTokenWithRetry,
  describeSetupFailure,
  describeSignInFailure,
  extractAccessToken,
  parseArgs,
} from "./cli.js";
import { runSetup } from "./run.js";

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

  // Kept in its own try/catch, separate from the top-level handler, because a
  // failed or cancelled sign-in is a different kind of failure with a different,
  // specific next step: the --client-id escape hatch.
  let adminToken;
  try {
    adminToken = await credential.getToken("https://graph.microsoft.com/.default");
  } catch (error) {
    console.error(describeSignInFailure(error));
    process.exitCode = 1;
    return;
  }

  const graph = createFetchSetupGraph(adminToken.token, async (appId, secret) => {
    // Retried, because this exchange runs seconds after the secret and the
    // service principal were created and Entra replication is not instant.
    // Without the retry a correct setup intermittently reports an invalid client
    // secret and sends the operator after a problem that does not exist.
    return acquireTokenWithRetry(async () => {
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
  });

  const result = await runSetup(
    graph,
    { displayName, siteUrl, write },
    // Rollback notices go to stderr as they happen, ahead of the failure itself,
    // so an operator reading a failed run sees whether a credentialed
    // registration was cleaned up before they see why the run failed.
    { onNotice: (message) => console.error(message) },
  );

  console.log("Setup complete. Store these as deployment secrets, not in the repository.");
  console.log(`  AZURE_TENANT_ID=${tenantId}`);
  console.log(`  AZURE_CLIENT_ID=${result.appId}`);
  console.log(`  AZURE_CLIENT_SECRET=${result.secret}`);
  console.log(`  IW_SITE_ID=${result.siteId}`);
}

// Every failure lands here, not just a verification failure. A 403 from POST
// /applications is the likeliest failure of all, and reaching the top-level
// await unhandled would print a raw stack trace for a prerequisite the setup
// document already states.
try {
  await main();
} catch (error) {
  console.error(describeSetupFailure(error));
  process.exitCode = 1;
}
