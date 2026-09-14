import { DeviceCodeCredential } from "@azure/identity";
import { createFetchSetupGraph } from "./adapter.js";
import {
  acquireTokenWithRetry,
  describeBootstrapSuccess,
  describeDeleteBootstrapSuccess,
  describeDeleteServerAppOutcome,
  describeSetupFailure,
  describeSetupSuccess,
  describeSignInFailure,
  extractAccessToken,
  once,
  parseArgs,
  type SetupMode,
} from "./cli.js";
import { runCreateBootstrap, runDeleteBootstrap, runDeleteServerApp, runSetup } from "./run.js";
import { assertBootstrapToken } from "./steps.js";

/**
 * The one client-credentials exchange this command needs, shared by the new
 * application's own token and the bootstrap application's token. Two copies of
 * this would be how one of them silently loses the propagation retry below.
 *
 * `label` names which application's credentials are being exchanged, because
 * both call sites otherwise report an identical "client credentials request
 * failed" message: an operator with a mistyped IW_BOOTSTRAP_CLIENT_SECRET would
 * have no way to tell that failure apart from a bad secret on the application
 * this command just created, and would go inspect the wrong one.
 */
function acquireAppOnlyToken(tenantId: string, clientId: string, secret: string, label: string): Promise<string> {
  // Retried for the new application's own credentials, which are seconds old
  // when this runs and which Entra has not always finished replicating; without
  // the retry a correct setup intermittently reports an invalid client secret
  // and sends the operator after a problem that does not exist. The bootstrap
  // application's secret is not new, so replication is not a plausible cause
  // there and the retry buys it nothing: a mistyped bootstrap secret returns
  // AADSTS7000215 too and costs about nine seconds before it is reported. That
  // is the accepted price of one shared implementation rather than two.
  return acquireTokenWithRetry(async () => {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    try {
      return extractAccessToken(response.status, await response.text());
    } catch (error) {
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

// Read by the top-level catch below, which is outside main() and so cannot
// see `parsed` directly. Defaults to the normal run because parseArgs itself
// can throw before any mode is known, and a malformed invocation is a setup
// failure in the ordinary sense, not a teardown or a bootstrap-creation one.
let mode: SetupMode = "setup";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  mode = parsed.deleteServerApp
    ? "delete-server-app"
    : parsed.deleteBootstrap
      ? "delete-bootstrap"
      : parsed.createBootstrap
        ? "create-bootstrap"
        : "setup";
  const { tenantId, siteUrl, displayName, write, clientId } = parsed;

  // Minted at most once per run. The preflight below needs this token only to
  // read its roles claim, and the per-site grant and that grant's rollback
  // delete both need one too, so without this a normal run would issue three
  // separate tenant-wide-privileged tokens where one does the whole job.
  const acquireBootstrapToken = once(async (): Promise<string> => {
    if (parsed.bootstrap === undefined) {
      throw new Error(
        "No bootstrap credentials. Set IW_BOOTSTRAP_CLIENT_ID and IW_BOOTSTRAP_CLIENT_SECRET, or run this command once with --create-bootstrap to create the grant-issuing application. See docs/SETUP.md.",
      );
    }
    return acquireAppOnlyToken(
      tenantId,
      parsed.bootstrap.clientId,
      parsed.bootstrap.clientSecret,
      "The bootstrap application's credentials were rejected",
    );
  });

  // Checked before the interactive device-code sign-in below, not merely before
  // runSetup, so a forgotten or mistyped bootstrap credential fails in about a
  // second. Without this, an operator would complete sign-in, and this command
  // would create an application, a secret, a service principal, and an
  // admin-consented role assignment before discovering the bootstrap credentials
  // do not work, followed by a rollback that deletes everything it just made.
  // Creating the bootstrap application is what --create-bootstrap is for, so
  // that mode is exempt. Deleting it is exempt for the opposite reason: this
  // mode exists for a grant issuer whose secret was lost or has already
  // expired, and requiring exactly that secret here would make it unusable in
  // the one situation it was built for. --delete-server-app is exempt too, but
  // not because this preflight is meaningless for it: unlike the two bootstrap
  // modes, this teardown can genuinely need the bootstrap token, to revoke the
  // permission entry it grants. That need depends on whether bootstrap
  // credentials actually resolved, which the delete-server-app arm below
  // checks for itself before acquiring anything, so folding it into this
  // shared, unconditional check would run the exchange even under
  // --force-orphan, where the whole point is to skip it.
  if (!parsed.createBootstrap && !parsed.deleteBootstrap && !parsed.deleteServerApp) {
    assertBootstrapToken(await acquireBootstrapToken());
  }

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

  const graph = createFetchSetupGraph({
    adminToken: adminToken.token,
    acquireAppToken: (appId, secret) =>
      acquireAppOnlyToken(tenantId, appId, secret, "The new application's credentials were rejected"),
    acquireBootstrapToken,
  });

  // Checked before --create-bootstrap below: parseArgs already refuses the two
  // together, so at most one of these branches is ever reachable in a given
  // run, and this one needs only the delegated sign-in above, not the
  // bootstrap-credential preflight this command otherwise requires.
  if (parsed.deleteBootstrap) {
    const result = await runDeleteBootstrap(
      graph,
      { displayName },
      { onNotice: (message) => console.error(message) },
    );

    console.log(describeDeleteBootstrapSuccess(result));
    return;
  }

  // A separate mode rather than a branch inside runSetup: it touches no site
  // (no resolveSite, no grantSitePermission, no verifyAppAccess), and printing
  // its output alongside runSetup's would risk conflating the two credential
  // pairs this command can produce.
  if (parsed.createBootstrap) {
    const result = await runCreateBootstrap(
      graph,
      { displayName },
      { onNotice: (message) => console.error(message) },
    );

    console.log(describeBootstrapSuccess(result));
    return;
  }

  // A separate mode, like the two bootstrap ones above: it tears down the
  // application a normal run creates, not the grant issuer, and printing its
  // output alongside runSetup's would risk conflating the two applications
  // this command can act on.
  if (parsed.deleteServerApp) {
    // hasGrantIssuer reflects whether bootstrap credentials actually
    // resolved, not whether --bootstrap-client-id or the environment
    // variables were merely typed. parsed.bootstrap is already that
    // resolution, done once by parseArgs; re-deriving it from raw argv or env
    // here would risk a second, possibly different, answer.
    const hasGrantIssuer = parsed.bootstrap !== undefined;

    // Acquired only when there is something to acquire, and validated the
    // same way the normal run's preflight above validates it. With
    // --force-orphan and no bootstrap credentials, runDeleteServerApp is
    // designed to skip the permission listing entirely and proceed as a
    // deliberate orphan, so attempting this exchange here would fail on
    // credentials that do not exist before that design ever gets to run.
    if (hasGrantIssuer) {
      assertBootstrapToken(await acquireBootstrapToken());
    }

    const result = await runDeleteServerApp(
      graph,
      { siteUrl, displayName, confirm: parsed.confirm, forceOrphan: parsed.forceOrphan, hasGrantIssuer },
      { onNotice: (message) => console.error(message) },
    );

    console.log(describeDeleteServerAppOutcome(result, siteUrl));
    return;
  }

  const result = await runSetup(
    graph,
    { displayName, siteUrl, write },
    // Rollback notices go to stderr as they happen, ahead of the failure itself,
    // so an operator reading a failed run sees whether a credentialed
    // registration was cleaned up before they see why the run failed.
    { onNotice: (message) => console.error(message) },
  );

  // An unconfirmed verification prints the credentials exactly as a success
  // does, because the application and its grant are live either way and the
  // secret is shown once. What changes is that the operator has to be told a
  // run that could not confirm access still left both behind, since
  // docs/SETUP.md's older promise was that a run either succeeds or leaves
  // nothing. The exit code stays zero for the same reason the credentials are
  // printed: something real exists now and a wrapper that discards the output
  // of a failed run would throw away the only copy of the secret.
  //
  // The whole block, values and teardown note together, comes from one pure
  // builder rather than a sequence of console.log calls here, so its wording
  // and the note's position after the four values can be pinned by a test
  // without running main.ts itself. The three other modes above all return
  // before reaching here, so none of them ever prints this block.
  console.log(
    describeSetupSuccess({
      confirmed: result.verification.confirmed,
      verificationMessage: result.verification.confirmed ? undefined : result.verification.message,
      tenantId,
      appId: result.appId,
      secret: result.secret,
      siteId: result.siteId,
    }),
  );
}

// Every failure lands here, not just a verification failure. A 403 from POST
// /applications is the likeliest failure of all, and reaching the top-level
// await unhandled would print a raw stack trace for a prerequisite the setup
// document already states.
try {
  await main();
} catch (error) {
  console.error(describeSetupFailure(error, mode));
  process.exitCode = 1;
}
