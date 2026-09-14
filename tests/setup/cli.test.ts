import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_CODE_CLIENT_ID,
  acquireTokenWithRetry,
  describeBootstrapSuccess,
  describeDeleteBootstrapSuccess,
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
// duplicating cases here.
describe("describeDeleteBootstrapSuccess (deleted branch)", () => {
  it("names the application that was deleted", () => {
    const message = describeDeleteBootstrapSuccess({ kind: "deleted", appId: "app-1", objectId: "obj-1" });

    expect(message).toContain("app-1");
  });

  it("states the standing permission is what deletion removed", () => {
    const message = describeDeleteBootstrapSuccess({ kind: "deleted", appId: "app-1", objectId: "obj-1" });

    expect(message).toMatch(/standing/i);
    expect(message).toMatch(/Sites\.FullControl\.All/);
  });

  it("does not let deletion read as equivalent to the secret's own expiry", () => {
    // The secret's seven-day expiry only disables one credential; the
    // application keeps its admin-consented role assignment until it is
    // actually deleted. A message that did not draw this line would let an
    // operator believe waiting out the week did the same job.
    const message = describeDeleteBootstrapSuccess({ kind: "deleted", appId: "app-1", objectId: "obj-1" });

    expect(message).toMatch(/not just its secret/i);
    expect(message).toMatch(/expired secret/i);
  });

  it("notes the 30-day soft-delete recovery window and the permanent purge available for it", () => {
    // DELETE /applications is a soft delete: the application is restorable
    // for 30 days by the same Application Administrator role this command
    // itself needed. This paragraph is framed as the answer to a client
    // security review, and a restore window is exactly what that review
    // would ask about, so overstating deletion as final here is the risk.
    const message = describeDeleteBootstrapSuccess({ kind: "deleted", appId: "app-1", objectId: "obj-1" });

    expect(message).toMatch(/30.day/i);
    expect(message).toMatch(/recoverable|restore/i);
    expect(message).toMatch(/purge/i);
  });

  it("tells the operator to remove the now-dead bootstrap credentials from wherever they were stored", () => {
    // Left in the environment or secret store, IW_BOOTSTRAP_CLIENT_ID and
    // IW_BOOTSTRAP_CLIENT_SECRET now name a deleted application. A later
    // normal run that still reads them fails at its preflight with a
    // rejected-credentials message that reads like a wrong secret, not a
    // deleted application, which is the opposite of the real cause.
    const message = describeDeleteBootstrapSuccess({ kind: "deleted", appId: "app-1", objectId: "obj-1" });

    expect(message).toContain("IW_BOOTSTRAP_CLIENT_ID");
    expect(message).toContain("IW_BOOTSTRAP_CLIENT_SECRET");
    expect(message).toMatch(/remove/i);
  });
});

describe("describeGrantIssuerTeardownNote", () => {
  it("states the grant issuer is not needed for this site only when access is confirmed", () => {
    // The unconfirmed arm cannot make this claim: that arm exists precisely
    // because the run could not prove the new application can reach the
    // site, so "not needed for this site any longer" is not yet observed.
    expect(describeGrantIssuerTeardownNote(true)).toMatch(/not needed for this site/i);
    expect(describeGrantIssuerTeardownNote(false)).not.toMatch(/not needed for this site/i);
  });

  it("tells the unconfirmed arm to wait for confirmation before deleting", () => {
    const message = describeGrantIssuerTeardownNote(false);

    expect(message).toMatch(/not (?:been )?confirmed/i);
    expect(message).toMatch(/wait until/i);
    expect(message).toMatch(/only credential that can reissue the per-site grant/i);
  });

  it("names the delete command on both arms", () => {
    expect(describeGrantIssuerTeardownNote(true)).toContain("--delete-bootstrap");
    expect(describeGrantIssuerTeardownNote(false)).toContain("--delete-bootstrap");
  });

  it("names the recreate command for onboarding another site later, on both arms", () => {
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
    const sharedTail = "Only deleting it removes that standing permission";
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

    expect(confirmedMessage).toMatch(/not needed for this site any longer/i);
    expect(unconfirmedMessage).not.toMatch(/not needed for this site any longer/i);
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
    const message = describeDeleteBootstrapSuccess({ kind: "deleted", appId: "app-1", objectId: "obj-1" });

    expect(message).not.toMatch(/not needed for this site/i);
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
