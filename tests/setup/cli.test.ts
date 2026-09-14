import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_CODE_CLIENT_ID,
  acquireTokenWithRetry,
  describeBootstrapSuccess,
  describeDeleteBootstrapSuccess,
  describeDeleteServerAppOutcome,
  describeGrantIssuerTeardownNote,
  describeSetupSuccess,
  describeSignInFailure,
  extractAccessToken,
  once,
  parseArgs,
} from "../../src/setup/cli.js";
import { BOOTSTRAP_SECRET_LIFETIME_DAYS } from "../../src/setup/steps.js";

const baseArgv = ["node", "main.js", "--tenant=tenant-1", "--site=https://contoso.sharepoint.com/sites/Example"];

describe("parseArgs", () => {
  it("uses the default display name when --name is absent", () => {
    expect(parseArgs(baseArgv).displayName).toBe("Ironwright Repository Reconciliation");
  });

  it("uses a custom display name when --name=<value> is provided", () => {
    const argv = [...baseArgv, "--name=Custom Name"];
    expect(parseArgs(argv).displayName).toBe("Custom Name");
  });

  it("uses Microsoft's Graph Command Line Tools application id by default", () => {
    // Pinned as a literal: this is the Graph Command Line Tools id, not the
    // Azure CLI's, and the two were confused here once already.
    expect(DEFAULT_DEVICE_CODE_CLIENT_ID).toBe("14d82eec-204b-4c2f-b7e8-296a70dab67e");
    expect(parseArgs(baseArgv).clientId).toBe(DEFAULT_DEVICE_CODE_CLIENT_ID);
  });

  it("uses a custom client id when --client-id=<value> is provided", () => {
    const argv = [...baseArgv, "--client-id=my-bootstrap-app"];
    expect(parseArgs(argv).clientId).toBe("my-bootstrap-app");
  });

  it("defaults write to false", () => {
    expect(parseArgs(baseArgv).write).toBe(false);
  });

  it("sets write to true when --write is present", () => {
    expect(parseArgs([...baseArgv, "--write"]).write).toBe(true);
  });

  it("parses the required tenant and site values", () => {
    const parsed = parseArgs(baseArgv);
    expect(parsed.tenantId).toBe("tenant-1");
    expect(parsed.siteUrl).toBe("https://contoso.sharepoint.com/sites/Example");
  });

  it("parses the server-app teardown mode, defaulting the name to the normal run's default", () => {
    const parsed = parseArgs([
      "node",
      "main.js",
      "--tenant=contoso.onmicrosoft.com",
      "--site=https://contoso.sharepoint.com/sites/Example",
      "--delete-server-app",
    ]);

    expect(parsed.deleteServerApp).toBe(true);
    expect(parsed.confirm).toBe(false);
    expect(parsed.forceOrphan).toBe(false);
    expect(parsed.displayName).toBe("Ironwright Repository Reconciliation");
  });

  it("reads the confirm and force-orphan flags", () => {
    const parsed = parseArgs([
      "node",
      "main.js",
      "--tenant=contoso.onmicrosoft.com",
      "--site=https://contoso.sharepoint.com/sites/Example",
      "--delete-server-app",
      "--confirm",
      "--force-orphan",
    ]);

    expect(parsed.confirm).toBe(true);
    expect(parsed.forceOrphan).toBe(true);
  });
});

describe("extractAccessToken", () => {
  it("returns the access token on a successful response", () => {
    expect(extractAccessToken(200, JSON.stringify({ access_token: "token-1" }))).toBe("token-1");
  });
});

describe("describeSignInFailure", () => {
  it("points at the --client-id escape hatch without misnaming the default application", () => {
    const message = describeSignInFailure(new Error("Conditional Access blocked this client"));

    expect(message).toContain("--client-id");
    expect(message).toContain("Conditional Access blocked this client");
    expect(message).toContain("Graph Command Line Tools");
    expect(message).not.toContain("Azure CLI");
  });

  it("does not call the sign-in application a bootstrap application", () => {
    // "Bootstrap application" names the grant issuer, a confidential client
    // with no public client flows. An operator who read this message as being
    // about that application would pass IW_BOOTSTRAP_CLIENT_ID to --client-id
    // and get a device-code failure with no obvious cause.
    const message = describeSignInFailure(new Error("Conditional Access blocked this client"));

    expect(message).not.toMatch(/register a bootstrap/i);
    expect(message).toContain("public-client sign-in application");
    expect(message).toContain("not the bootstrap application");
  });
});

describe("describeBootstrapSuccess", () => {
  it("prints both credentials", () => {
    const message = describeBootstrapSuccess({ appId: "app-1", secret: "secret-1" });

    expect(message).toContain("IW_BOOTSTRAP_CLIENT_ID=app-1");
    expect(message).toContain("IW_BOOTSTRAP_CLIENT_SECRET=secret-1");
  });

  it("states the secret's expiry in the one place the secret itself is ever shown", () => {
    // Someone who copies IW_BOOTSTRAP_CLIENT_SECRET straight from this
    // output, without separately reading docs/SETUP.md, has to learn its
    // lifetime here or not at all.
    const message = describeBootstrapSuccess({ appId: "app-1", secret: "secret-1" });

    expect(message).toMatch(new RegExp(`expires in ${BOOTSTRAP_SECRET_LIFETIME_DAYS} days`));
  });

  it("does not claim a separate consent step is still needed", () => {
    const message = describeBootstrapSuccess({ appId: "app-1", secret: "secret-1" });

    expect(message).toContain("already admin-consented");
    expect(message).not.toMatch(/needs? (to be )?consent/i);
  });
});

// Covers the "deleted" branch only. The "already-absent" branch's own tests
// live in delete-bootstrap.test.ts, next to runDeleteBootstrap's own
// already-absent outcome test, so the outcome and both of its renderings
// stay together; see task-1-report.md for why that split was chosen over
// duplicating cases here. The "planned" branch's tests sit in their own
// describe block below, next to describeDeleteServerAppOutcome's planned
// coverage, since both dry-run renderings make the same claims.
describe("describeDeleteBootstrapSuccess (deleted branch)", () => {
  const confirmedPurge = {
    kind: "deleted",
    appId: "app-1",
    objectId: "obj-1",
    applicationDeleted: true,
    purgeConfirmed: true,
    purgeRetried: false,
  } as const;

  it("names the application that was deleted", () => {
    const message = describeDeleteBootstrapSuccess(confirmedPurge);

    expect(message).toContain("app-1");
  });

  it("states the standing permission is what deletion removed", () => {
    const message = describeDeleteBootstrapSuccess(confirmedPurge);

    expect(message).toMatch(/standing/i);
    expect(message).toMatch(/Sites\.FullControl\.All/);
  });

  it("does not let deletion read as equivalent to the secret's own expiry", () => {
    // The secret's seven-day expiry only disables one credential; the
    // application keeps its admin-consented role assignment until it is
    // actually deleted. A message that did not draw this line would let an
    // operator believe waiting out the week did the same job.
    const message = describeDeleteBootstrapSuccess(confirmedPurge);

    expect(message).toMatch(/not just its secret/i);
    expect(message).toMatch(/expired secret/i);
  });

  it("notes the 30-day soft-delete recovery window and confirms the purge that already ran", () => {
    // DELETE /applications is a soft delete: the application is restorable
    // for 30 days by the same Application Administrator role this command
    // itself needed. Unlike the old text this replaces, the command now
    // performs the purge itself rather than sending the operator to do it by
    // hand, so the message reports what the purge observed instead of
    // advising a manual one.
    const message = describeDeleteBootstrapSuccess(confirmedPurge);

    expect(message).toMatch(/30.day/i);
    expect(message).toMatch(/recoverable|restore/i);
    expect(message).toMatch(/purge/i);
    expect(message).not.toMatch(/purge it permanently.*Entra admin portal/i);
  });

  it("says the credential is not recoverable only when the purge actually confirmed", () => {
    const message = describeDeleteBootstrapSuccess(confirmedPurge);

    expect(message).toMatch(/not recoverable/i);
  });

  it("does not claim the credential is unrecoverable when the purge returned not found", () => {
    // The same finding delete-server-app.errors.test.ts pins for
    // describeDeleteServerAppOutcome: a purge 404 fires milliseconds after a
    // delete that just succeeded in the same run, so the likelier reading is
    // that the object has not yet surfaced in deleted items, where it stays
    // restorable with its credentials. Saying it is not recoverable there
    // would be the opposite of the truth.
    const message = describeDeleteBootstrapSuccess({
      kind: "deleted",
      appId: "app-1",
      objectId: "obj-1",
      applicationDeleted: true,
      purgeConfirmed: false,
      purgeRetried: false,
    });

    expect(message).toMatch(/purge returned not found/i);
    expect(message).toMatch(/could not confirm the purge/i);
    expect(message).not.toMatch(/not recoverable/i);
    expect(message).not.toMatch(/even after retrying/i);
  });

  it("names the application to check for in deleted items, not just the whole view", () => {
    // That portal view is tenant-wide and can legitimately hold other
    // deleted objects, including the sibling mode's own application. "is
    // empty" would send an operator after the wrong evidence.
    const message = describeDeleteBootstrapSuccess({
      kind: "deleted",
      appId: "app-1",
      objectId: "obj-1",
      applicationDeleted: true,
      purgeConfirmed: false,
      purgeRetried: false,
    });

    expect(message).toMatch(/does not list app-1/i);
    expect(message).not.toMatch(/is empty/i);
  });

  it("names the replication-lag retry only when the ladder actually ran", () => {
    const retried = describeDeleteBootstrapSuccess({
      kind: "deleted",
      appId: "app-1",
      objectId: "obj-1",
      applicationDeleted: true,
      purgeConfirmed: false,
      purgeRetried: true,
    });
    const notRetried = describeDeleteBootstrapSuccess({
      kind: "deleted",
      appId: "app-1",
      objectId: "obj-1",
      applicationDeleted: true,
      purgeConfirmed: false,
      purgeRetried: false,
    });

    expect(retried).toMatch(/even after retrying for the directory replication lag/i);
    expect(notRetried).not.toMatch(/even after retrying/i);
  });

  it("does not claim this run deleted an application that was already gone", () => {
    // Mirrors describeDeleteServerAppOutcome's own applicationDeleted clause:
    // a delete-404 is tolerated by runDeleteBootstrap, not thrown, so the
    // message must not say "Deleted application X" for a run that observed
    // no such thing, even though the application is in fact gone and the
    // purge that follows still ran.
    const message = describeDeleteBootstrapSuccess({
      kind: "deleted",
      appId: "app-1",
      objectId: "obj-1",
      applicationDeleted: false,
      purgeConfirmed: true,
      purgeRetried: false,
    });

    expect(message).toMatch(/already gone when this run tried to delete it/i);
    expect(message).toMatch(/this run did not delete it/i);
    expect(message).not.toMatch(/^Deleted application app-1/);
    // The standing-permission claim still holds: the application is gone
    // from the tenant either way, which is what actually ends the
    // permission, regardless of which run performed the delete.
    expect(message).toMatch(/Sites\.FullControl\.All/);
    expect(message).toMatch(/not recoverable/i);
  });

  it("tells the operator to remove the now-dead bootstrap credentials from wherever they were stored", () => {
    // Left in the environment or secret store, IW_BOOTSTRAP_CLIENT_ID and
    // IW_BOOTSTRAP_CLIENT_SECRET now name a deleted application. A later
    // normal run that still reads them fails at its preflight with a
    // rejected-credentials message that reads like a wrong secret, not a
    // deleted application, which is the opposite of the real cause.
    const message = describeDeleteBootstrapSuccess(confirmedPurge);

    expect(message).toContain("IW_BOOTSTRAP_CLIENT_ID");
    expect(message).toContain("IW_BOOTSTRAP_CLIENT_SECRET");
    expect(message).toMatch(/remove/i);
  });
});

describe("describeDeleteBootstrapSuccess (planned branch)", () => {
  it("previews what would be removed without claiming it removed anything", () => {
    const message = describeDeleteBootstrapSuccess({ kind: "planned", appId: "app-1", objectId: "obj-1" });

    expect(message).toMatch(/would/i);
    expect(message).toMatch(/--confirm/);
    expect(message).toMatch(/app-1/);
    expect(message).not.toMatch(/Deleted|Purged/);
  });

  it("names the purge as part of what confirming would do, since this mode now purges automatically", () => {
    const message = describeDeleteBootstrapSuccess({ kind: "planned", appId: "app-1", objectId: "obj-1" });

    expect(message).toMatch(/purge/i);
    expect(message).toMatch(/30.day/i);
  });

  it("does not carry a dangling 'then' with nothing before it to chain off of", () => {
    // "It would then delete..." was lifted from describeDeleteServerAppOutcome's
    // planned branch, where a revoke clause sits before it. This branch has
    // nothing preceding it, so the same word dangled.
    const message = describeDeleteBootstrapSuccess({ kind: "planned", appId: "app-1", objectId: "obj-1" });

    expect(message).not.toMatch(/would then/i);
  });
});

describe("describeGrantIssuerTeardownNote", () => {
  it("states the grant issuer has finished this run's work only when access is confirmed", () => {
    // The unconfirmed arm cannot make this claim: that arm exists precisely
    // because the run could not prove the new application can reach the
    // site. Its own opening clause names a nearer-term reason to keep the
    // grant issuer instead (it may be needed again immediately to reissue or
    // diagnose the grant), not this one.
    expect(describeGrantIssuerTeardownNote(true)).toMatch(/finished the work this run needed it for/i);
    expect(describeGrantIssuerTeardownNote(false)).not.toMatch(/finished the work this run needed it for/i);
  });

  it("does not let the opening clause contradict the tail's keep-it-until-decommissioned advice", () => {
    // The two halves of this message disagreed once: the opening said the grant
    // issuer was no longer needed for this site, and the tail said to keep it
    // because this site would need it. Pinned as an assembled string for that
    // reason.
    const note = describeGrantIssuerTeardownNote(true);
    expect(note).not.toMatch(/not needed for this site any longer/i);
    expect(note).toMatch(/keep it until this site is decommissioned/i);
  });

  it("tells the unconfirmed arm to wait for confirmation before deleting", () => {
    const message = describeGrantIssuerTeardownNote(false);

    expect(message).toMatch(/not (?:been )?confirmed/i);
    expect(message).toMatch(/wait until/i);
    expect(message).toMatch(/only credential that can reissue the per-site grant/i);
  });

  it("names the delete command for eventual decommissioning, on both arms", () => {
    expect(describeGrantIssuerTeardownNote(true)).toContain("--delete-bootstrap");
    expect(describeGrantIssuerTeardownNote(false)).toContain("--delete-bootstrap");
  });

  it("names --confirm alongside --delete-bootstrap, since that mode now defaults to a dry run", () => {
    // Without --confirm, --delete-bootstrap now previews rather than acting.
    // Telling an operator to run it with no --confirm, at the one moment
    // they are told to act, would send them to a command that does nothing.
    expect(describeGrantIssuerTeardownNote(true)).toMatch(/--delete-bootstrap --confirm/);
    expect(describeGrantIssuerTeardownNote(false)).toMatch(/--delete-bootstrap --confirm/);
  });

  it("names the recreate command needed if the grant issuer is deleted too early, on both arms", () => {
    expect(describeGrantIssuerTeardownNote(true)).toContain("--create-bootstrap");
    expect(describeGrantIssuerTeardownNote(false)).toContain("--create-bootstrap");
  });

  it("does not assert the application is already gone, on either arm", () => {
    // At the moment this note prints, the grant issuer certainly still
    // exists: this path is the normal run's own success path, not
    // --delete-bootstrap's.
    for (const confirmed of [true, false]) {
      const message = describeGrantIssuerTeardownNote(confirmed);
      expect(message).toMatch(/still exists/i);
      expect(message).not.toMatch(/\bdeleted\b/i);
    }
  });

  it("does not let the secret's own expiry read as equivalent to deletion, on either arm", () => {
    for (const confirmed of [true, false]) {
      const message = describeGrantIssuerTeardownNote(confirmed);
      expect(message).toMatch(/expire/i);
      expect(message).toMatch(/disables a credential/i);
    }
  });

  it("carries identical wording after the opening clause on both arms", () => {
    // Only the opening clause's claim about whether the site still needs the
    // grant issuer is unobserved on the unconfirmed arm; every claim after it
    // (that the application still exists and still holds Sites.FullControl.All,
    // and the delete/recreate instructions) is true regardless of confirmation
    // and must read identically either way.
    const sharedTail = "Keep it until this site is decommissioned";
    const confirmedMessage = describeGrantIssuerTeardownNote(true);
    const unconfirmedMessage = describeGrantIssuerTeardownNote(false);

    expect(confirmedMessage).toContain(sharedTail);
    expect(unconfirmedMessage).toContain(sharedTail);
    expect(confirmedMessage.slice(confirmedMessage.indexOf(sharedTail))).toBe(
      unconfirmedMessage.slice(unconfirmedMessage.indexOf(sharedTail)),
    );
  });
});

describe("describeSetupSuccess", () => {
  const base = { tenantId: "tenant-1", appId: "app-1", secret: "secret-1", siteId: "site-1" };

  it("prints the four deployment values on the confirmed path", () => {
    const message = describeSetupSuccess({ ...base, confirmed: true });

    expect(message).toContain("AZURE_TENANT_ID=tenant-1");
    expect(message).toContain("AZURE_CLIENT_ID=app-1");
    expect(message).toContain("AZURE_CLIENT_SECRET=secret-1");
    expect(message).toContain("IW_SITE_ID=site-1");
  });

  it("prints the verification message and the four values on the unconfirmed path", () => {
    const message = describeSetupSuccess({
      ...base,
      confirmed: false,
      verificationMessage: "the grant may not have propagated to this site yet",
    });

    expect(message).toContain("the grant may not have propagated to this site yet");
    expect(message).toContain("IW_SITE_ID=site-1");
    expect(message).toMatch(/finished without confirming access/i);
  });

  it("places the teardown note after the line naming IW_SITE_ID, on both arms", () => {
    for (const confirmed of [true, false]) {
      const message = describeSetupSuccess({
        ...base,
        confirmed,
        verificationMessage: confirmed ? undefined : "not confirmed yet",
      });
      const lines = message.split("\n");
      const siteIdLineIndex = lines.findIndex((line) => line.includes("IW_SITE_ID="));
      const teardownLineIndex = lines.findIndex((line) => /grant issuer/i.test(line));

      expect(siteIdLineIndex).toBeGreaterThanOrEqual(0);
      expect(teardownLineIndex).toBeGreaterThan(siteIdLineIndex);
    }
  });

  it("carries the teardown note's per-arm wording through to the full success block", () => {
    const confirmedMessage = describeSetupSuccess({ ...base, confirmed: true });
    const unconfirmedMessage = describeSetupSuccess({
      ...base,
      confirmed: false,
      verificationMessage: "not confirmed yet",
    });

    expect(confirmedMessage).toMatch(/finished the work this run needed it for/i);
    expect(unconfirmedMessage).not.toMatch(/finished the work this run needed it for/i);
    expect(unconfirmedMessage).toMatch(/wait until/i);
  });
});

// main.ts has no test seam, so wiring itself (describeSetupSuccess is the only
// builder the normal run's two success paths ever print, and the two bootstrap
// modes print only their own builders below) cannot be exercised end to end
// here. What is pinned, in the two describe blocks above and this one
// together, is every property that mattered: the note appears on both arms of
// describeSetupSuccess, sits after IW_SITE_ID, differs correctly by arm, and
// is never produced by either bootstrap builder.
describe("grant issuer teardown note is confined to the normal run's success builder", () => {
  it("is absent from the create-bootstrap success message", () => {
    const message = describeBootstrapSuccess({ appId: "app-1", secret: "secret-1" });

    expect(message).not.toContain("--delete-bootstrap");
    expect(message).not.toMatch(/not needed for this site/i);
  });

  it("is absent from the delete-bootstrap success message", () => {
    const message = describeDeleteBootstrapSuccess({
      kind: "deleted",
      appId: "app-1",
      objectId: "obj-1",
      applicationDeleted: true,
      purgeConfirmed: true,
      purgeRetried: false,
    });

    expect(message).not.toMatch(/not needed for this site/i);
  });
});

describe("describeDeleteServerAppOutcome", () => {
  it("previews what it would remove without claiming it removed anything", () => {
    const message = describeDeleteServerAppOutcome(
      { kind: "planned", appId: "app-1", objectId: "obj-1", permissionId: "perm-1", permissionsInspected: true },
      "https://contoso.sharepoint.com/sites/Example",
    );

    expect(message).toMatch(/would/i);
    expect(message).toMatch(/--confirm/);
    expect(message).toMatch(/app-1/);
    expect(message).toMatch(/perm-1/);
    expect(message).not.toMatch(/Deleted|Purged|Revoked/);
  });

  it("says the permission entry is not there when the listing ran and matched nothing", () => {
    const message = describeDeleteServerAppOutcome(
      { kind: "planned", appId: "app-1", objectId: "obj-1", permissionId: undefined, permissionsInspected: true },
      "https://contoso.sharepoint.com/sites/Example",
    );

    expect(message).toMatch(/no permission entry/i);
  });

  it("says the permissions were not inspected when --force-orphan skipped the listing", () => {
    const message = describeDeleteServerAppOutcome(
      { kind: "planned", appId: "app-1", objectId: "obj-1", permissionId: undefined, permissionsInspected: false },
      "https://contoso.sharepoint.com/sites/Example",
    );

    // The distinction this test exists for: an uninspected site must not be
    // reported as an empty one.
    expect(message).toMatch(/not inspected/i);
    expect(message).not.toMatch(/no permission entry/i);
  });

  it("reports a completed teardown and says the credential is no longer recoverable", () => {
    const message = describeDeleteServerAppOutcome(
      {
        kind: "torn-down",
        appId: "app-1",
        objectId: "obj-1",
        permissionRevoked: true,
        orphanedPermission: false,
        applicationDeleted: true,
        purgeConfirmed: true,
        purgeRetried: false,
      },
      "https://contoso.sharepoint.com/sites/Example",
    );

    expect(message).toMatch(/revoked/i);
    expect(message).toMatch(/purged/i);
    expect(message).toMatch(/not recoverable/i);
    // Pins the specific revoked-clause wording, not just the loose /revoked/i
    // match above, so a regression that swapped in the orphaned branch's
    // "Nothing was revoked" wording on a non-orphaned outcome would fail here.
    expect(message).toMatch(/Revoked its permission entry/);
    expect(message).not.toMatch(/Nothing was revoked/i);
  });

  it("names the replication-lag retry only when the ladder actually ran", () => {
    // purgeRetried is the field this test exists for: a 404 that never matched
    // Request_ResourceNotFound gives up after zero sleeps, so the message must
    // not claim a retry ruled out replication lag when nothing was retried.
    const message = describeDeleteServerAppOutcome(
      {
        kind: "torn-down",
        appId: "app-1",
        objectId: "obj-1",
        permissionRevoked: true,
        orphanedPermission: false,
        applicationDeleted: true,
        purgeConfirmed: false,
        purgeRetried: false,
      },
      "https://contoso.sharepoint.com/sites/Example",
    );

    expect(message).toMatch(/purge returned not found/i);
    expect(message).not.toMatch(/even after retrying/i);
  });

  it("names the replication-lag retry when the ladder genuinely ran and still gave up", () => {
    const message = describeDeleteServerAppOutcome(
      {
        kind: "torn-down",
        appId: "app-1",
        objectId: "obj-1",
        permissionRevoked: true,
        orphanedPermission: false,
        applicationDeleted: true,
        purgeConfirmed: false,
        purgeRetried: true,
      },
      "https://contoso.sharepoint.com/sites/Example",
    );

    expect(message).toMatch(/purge returned not found/i);
    expect(message).toMatch(/even after retrying for the directory replication lag/i);
  });

  it("names the residue exactly when the permission entry was left behind", () => {
    const message = describeDeleteServerAppOutcome(
      {
        kind: "torn-down",
        appId: "app-1",
        objectId: "obj-1",
        permissionRevoked: false,
        orphanedPermission: true,
        applicationDeleted: true,
        purgeConfirmed: true,
        purgeRetried: false,
      },
      "https://contoso.sharepoint.com/sites/Example",
    );

    // "may still remain", not "remains": with --force-orphan the site's
    // permissions were never listed, so the code cannot observe whether there
    // was an entry, and asserting one would claim something it did not see.
    expect(message).toMatch(/may still remain/i);
    expect(message).toMatch(/grants access to nothing/i);
    expect(message).toMatch(/--create-bootstrap/);
    expect(message).not.toMatch(/entry remains on/i);
    // Pins the gated revoked clause itself, not just the residue clause: an
    // orphaned outcome must say nobody looked, not that nothing was granted.
    expect(message).toMatch(/nothing was revoked/i);
    // The clause this test exists to guard: an uninspected site must not be
    // reported as an empty one, in this sentence or any other.
    expect(message).not.toMatch(/no permission entry on .* was granted to it/i);
  });

  it("says nothing was deleted when the application was already gone", () => {
    const message = describeDeleteServerAppOutcome(
      { kind: "already-absent", displayName: "Ironwright Repository Reconciliation" },
      "https://contoso.sharepoint.com/sites/Example",
    );

    expect(message).toMatch(/nothing to do/i);
    expect(message).not.toMatch(/Deleted application/);
    // Same residue and the same command as the orphaned torn-down branch, so
    // the advice has to name the grant issuer too. This branch used to name
    // only the manual identification, leaving the harder half to be discovered.
    expect(message).toMatch(/--create-bootstrap/);
    expect(message).toMatch(/identified by hand/);
  });
});

describe("acquireTokenWithRetry", () => {
  it("returns the token on the first attempt when nothing is wrong", async () => {
    let attempts = 0;
    const slept: number[] = [];

    const token = await acquireTokenWithRetry(
      async () => {
        attempts += 1;
        return "token-1";
      },
      { sleep: async (ms) => void slept.push(ms) },
    );

    expect(token).toBe("token-1");
    expect(attempts).toBe(1);
    expect(slept).toEqual([]);
  });

  it("retries a secret that has not propagated yet and returns the token", async () => {
    let attempts = 0;
    const slept: number[] = [];

    const token = await acquireTokenWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("client credentials request failed with 401: AADSTS7000215: Invalid client secret.");
        return "token-1";
      },
      { sleep: async (ms) => void slept.push(ms) },
    );

    expect(token).toBe("token-1");
    expect(attempts).toBe(3);
    expect(slept).toEqual([3000, 6000]);
  });

  it("retries a service principal that has not propagated yet", async () => {
    let attempts = 0;

    const token = await acquireTokenWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("AADSTS700016: Application with identifier was not found.");
        return "token-1";
      },
      { sleep: async () => {} },
    );

    expect(token).toBe("token-1");
    expect(attempts).toBe(2);
  });

  it("spends about ten seconds at most on propagation, across three attempts", async () => {
    const slept: number[] = [];

    await expect(
      acquireTokenWithRetry(
        async () => {
          throw new Error("AADSTS7000215: Invalid client secret.");
        },
        { sleep: async (ms) => void slept.push(ms) },
      ),
    ).rejects.toThrow(/AADSTS7000215/);

    expect(slept).toHaveLength(2);
    expect(slept.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(10_000);
  });
});

describe("once", () => {
  it("acquires a value one time and reuses it for every later caller", async () => {
    let acquisitions = 0;
    const acquire = once(async () => {
      acquisitions += 1;
      return `token-${acquisitions}`;
    });

    expect(await acquire()).toBe("token-1");
    expect(await acquire()).toBe("token-1");
    expect(acquisitions).toBe(1);
  });

  it("shares one acquisition between callers that overlap", async () => {
    let acquisitions = 0;
    const acquire = once(async () => {
      acquisitions += 1;
      return "token-1";
    });

    const [first, second] = await Promise.all([acquire(), acquire()]);

    expect(first).toBe("token-1");
    expect(second).toBe("token-1");
    expect(acquisitions).toBe(1);
  });
});
