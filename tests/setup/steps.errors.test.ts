import { describe, expect, it } from "vitest";
import { appRoleIdByValue, appRolesFromAccessToken, interpretVerification } from "../../src/setup/steps.js";

const consented = { sitesSelectedRolePresent: true };
const notConsented = { sitesSelectedRolePresent: false };
const undeterminable = { sitesSelectedRolePresent: undefined };

describe("interpretVerification failures", () => {
  it("names the evidence, not a missing grant, on a 403 from a token that does carry the role", () => {
    const outcome = interpretVerification(403, '{"error":{"code":"accessDenied"}}', consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("role-present-refused");
    expect(outcome.message).toContain("propagat");
    expect(outcome.message).toMatch(/bootstrap/i);
  });

  it("names admin consent, not the per-site grant, on a 403 from a token carrying no role", () => {
    const outcome = interpretVerification(403, '{"error":{"code":"accessDenied"}}', notConsented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("permission-not-consented");
    expect(outcome.message).toContain("admin consent");
    expect(outcome.message).toContain("Privileged Role Administrator");
    expect(outcome.message).not.toContain("propagat");
  });

  it("keeps both causes open when the application token could not be read", () => {
    const outcome = interpretVerification(403, '{"error":{"code":"accessDenied"}}', undeterminable);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("cause-undetermined");
    expect(outcome.message).toContain("neither cause can be ruled out");
    expect(outcome.message).toContain("Privileged Role Administrator");
    // Nothing this run created still exists, so the remedy must not send the
    // operator to inspect a registration or a grant it deleted seconds ago.
    expect(outcome.message).not.toMatch(/GET \/sites/);
  });

  it("composes one non-contradictory story for a refused role-carrying token, pinned as a whole", () => {
    // Pinned as a full string, not a substring, because the lead-in sentence
    // and the remedy are written and edited separately and each reads fine in
    // isolation. A composed self-contradiction only shows up in the
    // concatenation, so only a whole-string assertion catches a future edit to
    // either half reintroducing one. What the run does with each outcome is
    // pinned separately, in tests/setup/run.errors.test.ts: a string that
    // reads well but describes the wrong rollback behavior is the defect these
    // pins alone could not catch.
    const outcome = interpretVerification(403, "{}", consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe(
      "The app was denied access even though its token carries the Sites.Selected role, so the application " +
        "permission is consented and the app's access could not be confirmed yet. The application and its " +
        "per-site grant were kept, not rolled back: the token shows the configuration is correct, so nothing " +
        "here needs creating again. This command issued the per-site grant moments ago, so the likeliest cause " +
        "is that the grant has not propagated to this site yet. Wait a short while and try the app's own access " +
        "again. If it is still refused, check GET /sites/{site-id}/permissions for an entry naming this app, and " +
        "if none is there an administrator can issue one with POST /sites/{site-id}/permissions using the " +
        "bootstrap application's own token.",
    );
  });

  it("composes one non-contradictory story for cause-undetermined, pinned as a whole", () => {
    const outcome = interpretVerification(403, "{}", undeterminable);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe(
      "The app was denied access and its token could not be read, so neither cause can be ruled out. This run " +
        "rolled back what it created; anything it could not remove is named in the notices above. Wait a minute " +
        "and run this command again, signed in as a Privileged Role Administrator or Global Administrator, since " +
        "the Application Administrator role cannot consent a Microsoft Graph application permission and a " +
        "directory change made moments earlier can also need a little time. An attempt whose token can be read " +
        "will name which of the two causes applies; if the token cannot be read then either, report that, " +
        "because an unreadable application token is a defect in this command rather than a tenant setting.",
    );
  });

  it("composes one non-contradictory story for an unconsented permission, pinned as a whole", () => {
    const outcome = interpretVerification(403, "{}", notConsented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe(
      "The app was denied access, and its token carries no Sites.Selected role, so the application permission is " +
        "not in effect in this tenant yet. This run rolled back what it created; anything it could not remove is " +
        "named in the notices above. The role assignment this run made is itself what grants that consent, so " +
        "the likeliest cause is that it had not reached a newly issued token yet; wait a minute and run this " +
        "command again. If a second attempt fails the same way, the assignment is not taking effect: granting " +
        "admin consent for a Microsoft Graph application permission needs Privileged Role Administrator or " +
        "Global Administrator, because the Application Administrator role can consent to every API except " +
        "Microsoft Graph.",
    );
  });

  it("gives the still-refused case an action, not just a diagnosis", () => {
    const outcome = interpretVerification(403, "{}", consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Waiting is the first action; GET .../permissions to check and POST
    // .../permissions to issue one directly are the actions for a refusal that
    // outlasts propagation.
    expect(outcome.message).toMatch(/wait a short while/i);
    expect(outcome.message).toContain("GET /sites/{site-id}/permissions");
    expect(outcome.message).toContain("POST /sites/{site-id}/permissions");
  });

  it("never tells the operator to re-run a command that would create a second registration", () => {
    for (const evidence of [consented, notConsented, undeterminable]) {
      const outcome = interpretVerification(403, "{}", evidence);
      if (outcome.ok) throw new Error("expected a failure outcome");
      expect(outcome.message, JSON.stringify(evidence)).not.toMatch(/re-?run/i);
    }
  });

  it("does not send the operator to check credentials this run is about to delete on 401", () => {
    // This status comes from verifyAppAccess's own call, made with a token
    // that was already minted successfully for the run's new application.
    // Telling the operator to check that application's tenant id, client id,
    // or secret would send them after an object this run rolls back, and
    // implies the token was never acquired at all, which by this point it was.
    const outcome = interpretVerification(401, "", undeterminable);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("token");
    expect(outcome.message).not.toContain("Could not acquire");
    expect(outcome.message).toMatch(/rolled back what it created/);
    expect(outcome.message).toMatch(/will not help/i);
  });

  it("does not blame the site URL on 404, since this run already resolved it", () => {
    // resolveSite already proved this exact URL correct with the operator's
    // own token earlier in the same run. A 404 here is from the new
    // application's token instead, so the site URL is not in question.
    const outcome = interpretVerification(404, "", consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("not-found");
    expect(outcome.message).not.toMatch(/check the site url/i);
    expect(outcome.message).toContain("already resolved this exact site");
    expect(outcome.message).toMatch(/rolled back what it created/);
  });

  it("includes the raw body for an unrecognized status", () => {
    const outcome = interpretVerification(429, "throttled", consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("unknown");
    expect(outcome.message).toContain("throttled");
  });

  it("names throttling as a transient, retry-worthy cause on 429", () => {
    const outcome = interpretVerification(429, "throttled", consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("transient");
    expect(outcome.message).toContain("retry");
  });

  it("names a server-side status as transient and retry-worthy on 503", () => {
    const outcome = interpretVerification(503, '{"error":{"code":"serviceUnavailable"}}', consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("unknown");
    expect(outcome.message).toContain("transient");
    expect(outcome.message).toContain("retry");
  });

  it("points at the error code in the body and asks for a report on an unrecognized non-transient status", () => {
    const outcome = interpretVerification(400, '{"error":{"code":"badRequest"}}', consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("unknown");
    expect(outcome.message).toContain("error code");
    expect(outcome.message).toContain("report");
    expect(outcome.message).not.toContain("transient");
  });
});

describe("appRoleIdByValue rejections", () => {
  it("names the missing role and does not return a guess", () => {
    expect(() => appRoleIdByValue([{ id: "a", value: "Sites.Selected" }], "Sites.FullControl.All")).toThrow(
      /Sites\.FullControl\.All/,
    );
  });

  it("rejects an empty role list rather than returning undefined", () => {
    expect(() => appRoleIdByValue([], "Sites.Selected")).toThrow();
  });
});

describe("appRolesFromAccessToken failures", () => {
  it("reports an undecodable token as unknown rather than as an absent role", () => {
    expect(appRolesFromAccessToken("not-a-jwt")).toBeUndefined();
    expect(appRolesFromAccessToken("header.bm90LWpzb24.signature")).toBeUndefined();
  });

  it("ignores non-string entries in a roles claim", () => {
    const encoded = Buffer.from(JSON.stringify({ roles: ["Sites.Selected", 7] }), "utf8").toString("base64url");
    expect(appRolesFromAccessToken(`header.${encoded}.signature`)).toEqual(["Sites.Selected"]);
  });
});
