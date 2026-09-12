import { describe, expect, it } from "vitest";
import { appRoleIdByValue, appRolesFromAccessToken, interpretVerification } from "../../src/setup/steps.js";

const consented = { sitesSelectedRolePresent: true };
const notConsented = { sitesSelectedRolePresent: false };
const undeterminable = { sitesSelectedRolePresent: undefined };

describe("interpretVerification failures", () => {
  it("names the per-site permission grant on a 403 from a token that does carry the role", () => {
    const outcome = interpretVerification(403, '{"error":{"code":"accessDenied"}}', consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("grant-missing");
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

  it("names both causes when the application token could not be read", () => {
    const outcome = interpretVerification(403, '{"error":{"code":"accessDenied"}}', undeterminable);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("cause-undetermined");
    expect(outcome.message).toContain("admin consent");
    expect(outcome.message).toContain("propagat");
  });

  it("composes one non-contradictory story for grant-missing, pinned as a whole", () => {
    // Pinned as a full string, not a substring, because the lead-in sentence
    // and GRANT_REMEDY are written and edited separately and each reads fine
    // in isolation. A composed self-contradiction (lead-in: "the grant is
    // missing"; remedy: "the grant was already issued, it is just
    // propagating") only shows up in the concatenation, so only a whole-string
    // assertion catches a future edit to either half reintroducing one.
    const outcome = interpretVerification(403, "{}", consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe(
      "The app was denied access even though its token carries the Sites.Selected role, so the application " +
        "permission is consented and the per-site grant has not taken effect on this site yet. This command " +
        "already issued the per-site grant moments ago, so a 403 here has one of two causes. The likelier one is " +
        "that the grant has not propagated to this site yet: wait a short while and check access again before " +
        "assuming anything failed. If it is still refused afterward, confirm with GET " +
        "/sites/{site-id}/permissions whether an entry for this app actually exists on this site; if it does not, " +
        "or names a different site, an administrator has to issue it directly with POST " +
        "/sites/{site-id}/permissions using the bootstrap application's own token, naming the app id reported " +
        "above. Running this command again will not fix either cause: it creates a second, separate application " +
        "registration instead of repairing this one.",
    );
  });

  it("composes one non-contradictory story for cause-undetermined, pinned as a whole", () => {
    const outcome = interpretVerification(403, "{}", undeterminable);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe(
      "The app was denied access and its token could not be read, so both causes are still open. Check the " +
        "application permission first: Grant admin consent for Microsoft Graph's Sites.Selected application " +
        "permission to this app registration. A Privileged Role Administrator or Global Administrator has to do " +
        "that, because the Application Administrator role can consent to every API except Microsoft Graph. An " +
        "assignment made moments ago can also take a short time to appear in a newly issued token. If the role is " +
        "present, an unpropagated or misdirected per-site grant is the remaining cause, not an absent one. This " +
        "command already issued the per-site grant moments ago, so a 403 here has one of two causes. The likelier " +
        "one is that the grant has not propagated to this site yet: wait a short while and check access again " +
        "before assuming anything failed. If it is still refused afterward, confirm with GET " +
        "/sites/{site-id}/permissions whether an entry for this app actually exists on this site; if it does not, " +
        "or names a different site, an administrator has to issue it directly with POST " +
        "/sites/{site-id}/permissions using the bootstrap application's own token, naming the app id reported " +
        "above. Running this command again will not fix either cause: it creates a second, separate application " +
        "registration instead of repairing this one.",
    );
  });

  it("gives the second cause in GRANT_REMEDY an action, not just a diagnosis", () => {
    const outcome = interpretVerification(403, "{}", consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // "wrong site" is diagnosed; GET .../permissions to check, and POST
    // .../permissions to fix it directly, are the actions for it.
    expect(outcome.message).toMatch(/different site/i);
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

  it("blames credentials rather than permissions on 401", () => {
    const outcome = interpretVerification(401, "", undeterminable);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("token");
    expect(outcome.message).toContain("client secret");
  });

  it("blames the site URL on 404", () => {
    const outcome = interpretVerification(404, "", consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("not-found");
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
