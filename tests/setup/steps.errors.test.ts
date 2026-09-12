import { describe, expect, it } from "vitest";
import { appRolesFromAccessToken, interpretVerification } from "../../src/setup/steps.js";

const consented = { sitesSelectedRolePresent: true };
const notConsented = { sitesSelectedRolePresent: false };
const undeterminable = { sitesSelectedRolePresent: undefined };

describe("interpretVerification failures", () => {
  it("names the per-site permission grant on a 403 from a token that does carry the role", () => {
    const outcome = interpretVerification(403, '{"error":{"code":"accessDenied"}}', consented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("grant-missing");
    expect(outcome.message).toContain("/sites/{site-id}/permissions");
  });

  it("names admin consent, not the per-site grant, on a 403 from a token carrying no role", () => {
    const outcome = interpretVerification(403, '{"error":{"code":"accessDenied"}}', notConsented);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("permission-not-consented");
    expect(outcome.message).toContain("admin consent");
    expect(outcome.message).toContain("Privileged Role Administrator");
    expect(outcome.message).not.toContain("/sites/{site-id}/permissions");
  });

  it("names both causes when the application token could not be read", () => {
    const outcome = interpretVerification(403, '{"error":{"code":"accessDenied"}}', undeterminable);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("grant-missing");
    expect(outcome.message).toContain("admin consent");
    expect(outcome.message).toContain("/sites/{site-id}/permissions");
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
