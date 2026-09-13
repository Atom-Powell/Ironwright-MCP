import { describe, expect, it } from "vitest";
import { acquireTokenWithRetry, describeSetupFailure, extractAccessToken, parseArgs } from "../../src/setup/cli.js";
import { GraphRequestError } from "../../src/graph/errors.js";
// Imported from errors.js, not run.js: run.js drags the adapter and its fetch
// calls into this module graph, which is exactly what extracting the error
// type was meant to prevent.
import { SetupFailedError } from "../../src/setup/errors.js";

const baseArgv = ["node", "main.js", "--tenant=tenant-1", "--site=https://contoso.sharepoint.com/sites/Example"];

describe("parseArgs failures", () => {
  it("rejects a missing --tenant", () => {
    const argv = baseArgv.filter((arg) => !arg.startsWith("--tenant="));
    expect(() => parseArgs(argv)).toThrow(/missing required argument --tenant=<value>/);
  });

  it("rejects a missing --site", () => {
    const argv = baseArgv.filter((arg) => !arg.startsWith("--site="));
    expect(() => parseArgs(argv)).toThrow(/missing required argument --site=<value>/);
  });

  it("rejects an empty --tenant= with the same message as a missing one", () => {
    const argv = ["node", "main.js", "--tenant=", "--site=https://contoso.sharepoint.com/sites/Example"];
    expect(() => parseArgs(argv)).toThrow(/missing required argument --tenant=<value>/);
  });

  it("rejects an empty --site= with the same message as a missing one", () => {
    const argv = ["node", "main.js", "--tenant=tenant-1", "--site="];
    expect(() => parseArgs(argv)).toThrow(/missing required argument --site=<value>/);
  });
});

describe("extractAccessToken failures", () => {
  it("surfaces error_description when Entra returns one", () => {
    const body = JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret." });
    expect(() => extractAccessToken(401, body)).toThrow(/AADSTS7000215: Invalid client secret\./);
  });

  it("keeps the raw response text available when there is no error_description", () => {
    expect(() => extractAccessToken(400, "not json")).toThrow(/not json/);
  });

  it("fails rather than returning undefined when the response has no access_token", () => {
    expect(() => extractAccessToken(200, JSON.stringify({}))).toThrow(/200/);
  });
});

describe("acquireTokenWithRetry failures", () => {
  it("does not retry a failure that is not a propagation delay", async () => {
    let attempts = 0;

    await expect(
      acquireTokenWithRetry(
        async () => {
          attempts += 1;
          throw new Error("client credentials request failed with 400: AADSTS90002: Tenant not found.");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/AADSTS90002/);

    expect(attempts).toBe(1);
  });

  it("gives up rather than retrying a genuinely wrong secret forever", async () => {
    let attempts = 0;

    await expect(
      acquireTokenWithRetry(
        async () => {
          attempts += 1;
          throw new Error("AADSTS7000215: Invalid client secret.");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/AADSTS7000215/);

    expect(attempts).toBe(3);
  });
});

describe("describeSetupFailure", () => {
  it("reports a verification failure as the setup failing, with its own message", () => {
    const message = describeSetupFailure(
      new SetupFailedError({
        ok: false,
        reason: "permission-not-consented",
        message: "the application permission is not in effect",
      }),
    );

    expect(message).toContain("Setup failed");
    expect(message).toContain("the application permission is not in effect");
  });

  it("names the directory role behind a refused app registration", () => {
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "POST",
        path: "/applications",
        status: 403,
        body: '{"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges."}}',
      }),
    );

    expect(message).toContain("403");
    expect(message).toContain("Authorization_RequestDenied");
    expect(message).toContain("Application Administrator");
  });

  it("names the different directory role behind a refused admin consent", () => {
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "POST",
        path: "/servicePrincipals/graph-sp-1/appRoleAssignedTo",
        status: 403,
        body: '{"error":{"code":"Authorization_RequestDenied"}}',
      }),
    );

    expect(message).toContain("Privileged Role Administrator");
    expect(message).toContain("admin consent");
  });

  it("does not blame site ownership for a refused app registration or service principal call", () => {
    // Pins the generic 403 branch's exact wording so a future edit cannot
    // silently reintroduce the site-owner claim this replaced: that call
    // never reaches /sites/{id}/permissions, which is the only endpoint site
    // ownership was ever relevant to, and even there it stopped being
    // relevant once the grant moved to the bootstrap application's token.
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "POST",
        path: "/servicePrincipals",
        status: 403,
        body: '{"error":{"code":"Authorization_RequestDenied"}}',
      }),
    );

    expect(message).toContain(
      "The signed-in user is not allowed to do this. Creating the app registration and its service principal needs " +
        "Application Administrator or Cloud Application Administrator.",
    );
    expect(message).not.toContain("site owner");
  });

  it("blames the bootstrap application, not site ownership, for a refused per-site grant", () => {
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "POST",
        path: "/sites/site-1/permissions",
        status: 403,
        body: '{"error":{"code":"accessDenied"}}',
      }),
    );

    expect(message).toContain(
      "This call runs on the bootstrap application's own token, not the signed-in user's, so it is not about the " +
        "signed-in user's directory roles or about site ownership. The likely cause is that the bootstrap " +
        "application's Sites.FullControl.All permission is not admin-consented in this tenant, or that consent " +
        "granted moments earlier by --create-bootstrap has not yet reached a freshly issued token. Confirm " +
        "IW_BOOTSTRAP_CLIENT_ID and IW_BOOTSTRAP_CLIENT_SECRET name a bootstrap application created with " +
        "--create-bootstrap, and if the permission is already consented, wait a short while and try again.",
    );
    // The exact-string assertion above already pins the whole message. This
    // one checks the specific false claim this replaced is gone, not merely
    // that no substring collides with "site ownership", which the message
    // legitimately says above while explaining that site ownership is not
    // the cause.
    expect(message).not.toContain("needs site owner rights");
  });

  it("blames the bootstrap application for a refused rollback delete of the per-site grant too", () => {
    // The rollback DELETE shares the same path family with a permission id
    // appended, and has to be told apart from the generic 403 branch the same
    // way the grant itself is.
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "DELETE",
        path: "/sites/site-1/permissions/permission-1",
        status: 403,
        body: '{"error":{"code":"accessDenied"}}',
      }),
    );

    expect(message).toContain("This call runs on the bootstrap application's own token");
    expect(message).not.toContain("needs site owner rights");
  });

  it("blames the bootstrap application's credentials, not sign-in, for a 401 on the per-site grant", () => {
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "POST",
        path: "/sites/site-1/permissions",
        status: 401,
        body: '{"error":{"code":"InvalidAuthenticationToken"}}',
      }),
    );

    expect(message).toContain(
      "The bootstrap application's token was rejected. Check that IW_BOOTSTRAP_CLIENT_ID and " +
        "IW_BOOTSTRAP_CLIENT_SECRET are correct and belong to a bootstrap application created with --create-bootstrap.",
    );
    expect(message).not.toContain("Sign in again");
  });

  it("still tells the signed-in operator to sign in again for a 401 elsewhere", () => {
    const message = describeSetupFailure(
      new GraphRequestError({ method: "POST", path: "/applications", status: 401, body: "unauthorized" }),
    );

    expect(message).toContain("The signed-in token was rejected. Sign in again.");
  });

  it("does not blame the site URL for a 404 on the per-site grant, since this run already resolved it", () => {
    // resolveSite already proved this exact site URL correct with the
    // signed-in operator's own token, earlier in the same run, before
    // grantSitePermission ever ran on the bootstrap application's token. The
    // generic 404 branch below names a cause this run has already disproved;
    // this path family needs the same isSitePermissionsPath treatment the 403
    // and 401 branches above already get.
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "POST",
        path: "/sites/site-1/permissions",
        status: 404,
        body: '{"error":{"code":"itemNotFound"}}',
      }),
    );

    expect(message).not.toContain("Check the site URL");
    expect(message).toContain("this run already resolved this exact site");
    expect(message).toContain("Sites.FullControl.All");
  });

  it("does not call a refused application deletion a refused creation", () => {
    // DELETE /applications/{id} is issued by --delete-bootstrap and by every
    // rollback, never by a create step, so the generic 403 branch's "Creating
    // the app registration and its service principal needs..." named the
    // wrong verb here even though the role it names is coincidentally right.
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "DELETE",
        path: "/applications/object-1",
        status: 403,
        body: '{"error":{"code":"Authorization_RequestDenied"}}',
      }),
      "delete-bootstrap",
    );

    expect(message).toMatch(/delete this application registration/i);
    expect(message).not.toMatch(/Creating the app registration/i);
  });

  it("says deletion needs only Application Administrator, not a more senior consent-granting role", () => {
    // Deleting an application registration involves no admin consent, unlike
    // creating one and consenting its permissions, so it needs only
    // Application Administrator, not Privileged Role Administrator or Global
    // Administrator; docs/SETUP.md's prerequisites section makes the same
    // distinction.
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "DELETE",
        path: "/applications/object-1",
        status: 403,
        body: '{"error":{"code":"Authorization_RequestDenied"}}',
      }),
      "delete-bootstrap",
    );

    expect(message).toContain("Application Administrator");
    expect(message).toMatch(/Privileged Role Administrator or Global Administrator is not required/);
  });

  it("does not blame the site URL for a 404 on an application delete, which names no site at all", () => {
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "DELETE",
        path: "/applications/object-1",
        status: 404,
        body: '{"error":{"code":"Request_ResourceNotFound"}}',
      }),
      "delete-bootstrap",
    );

    expect(message).not.toMatch(/site URL/i);
    expect(message).toMatch(/already have been deleted|object id/i);
  });

  it("still blames the site URL for a 404 that is not on the per-site grant path", () => {
    const message = describeSetupFailure(
      new GraphRequestError({ method: "GET", path: "/sites/contoso.sharepoint.com:/sites/Example", status: 404, body: "itemNotFound" }),
    );

    expect(message).toContain("Check the site URL, including its /sites/ segment.");
  });

  it("names throttling as worth retrying", () => {
    const message = describeSetupFailure(
      new GraphRequestError({ method: "POST", path: "/applications", status: 429, body: "throttled" }),
    );

    expect(message).toContain("retry");
  });

  it("still reports a failure that is not a Graph call at all", () => {
    const message = describeSetupFailure(new Error("missing required argument --tenant=<value>"));

    expect(message).toContain("Setup failed");
    expect(message).toContain("missing required argument --tenant=<value>");
  });

  it("never carries a stack trace into its output", () => {
    const error = new Error("something broke");
    const message = describeSetupFailure(error);

    expect(error.stack).toBeDefined();
    expect(message).not.toMatch(/\bat\s+\S+\s+\(.*:\d+:\d+\)/);
    expect(message).not.toContain("node_modules");
  });

  it("prefixes a normal run's failure as a setup failure by default", () => {
    const message = describeSetupFailure(new Error("missing required argument --tenant=<value>"));

    expect(message).toMatch(/^Setup failed:/);
  });

  it("prefixes a --delete-bootstrap failure as a deletion failure, not a setup failure", () => {
    // A teardown refusal reading "Setup failed: No application named ...
    // exists ... so there is nothing to delete" implies a setup attempt was
    // made and failed, when nothing was being set up: this mode only deletes.
    const message = describeSetupFailure(
      new Error('No application named "Ironwright Grant Issuer" exists in this tenant, so there is nothing to delete.'),
      "delete-bootstrap",
    );

    expect(message).toMatch(/^Bootstrap deletion failed:/);
    expect(message).not.toMatch(/^Setup failed:/);
  });

  it("prefixes a --create-bootstrap failure as a creation failure, not a setup failure", () => {
    const message = describeSetupFailure(
      new Error('An application named "Ironwright Grant Issuer" already exists in this tenant.'),
      "create-bootstrap",
    );

    expect(message).toMatch(/^Bootstrap creation failed:/);
    expect(message).not.toMatch(/^Setup failed:/);
  });

  it("applies the mode-specific prefix to a GraphRequestError too, not just a plain Error", () => {
    const message = describeSetupFailure(
      new GraphRequestError({
        method: "DELETE",
        path: "/applications/object-1",
        status: 403,
        body: '{"error":{"code":"Authorization_RequestDenied"}}',
      }),
      "delete-bootstrap",
    );

    expect(message).toMatch(/^Bootstrap deletion failed:/);
  });
});
