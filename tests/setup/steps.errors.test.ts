import { describe, expect, it } from "vitest";
import { interpretVerification } from "../../src/setup/steps.js";

describe("interpretVerification failures", () => {
  it("names the per-site permission grant on 403", () => {
    const outcome = interpretVerification(403, '{"error":{"code":"accessDenied"}}');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("grant-missing");
    expect(outcome.message).toContain("/sites/{site-id}/permissions");
  });

  it("blames credentials rather than permissions on 401", () => {
    const outcome = interpretVerification(401, "");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("token");
    expect(outcome.message).toContain("client secret");
  });

  it("blames the site URL on 404", () => {
    const outcome = interpretVerification(404, "");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("not-found");
  });

  it("includes the raw body for an unrecognized status", () => {
    const outcome = interpretVerification(429, "throttled");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("unknown");
    expect(outcome.message).toContain("throttled");
  });

  it("names throttling as a transient, retry-worthy cause on 429", () => {
    const outcome = interpretVerification(429, "throttled");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("transient");
    expect(outcome.message).toContain("retry");
  });

  it("names a server-side status as transient and retry-worthy on 503", () => {
    const outcome = interpretVerification(503, '{"error":{"code":"serviceUnavailable"}}');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("unknown");
    expect(outcome.message).toContain("transient");
    expect(outcome.message).toContain("retry");
  });

  it("points at the error code in the body and asks for a report on an unrecognized non-transient status", () => {
    const outcome = interpretVerification(400, '{"error":{"code":"badRequest"}}');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("unknown");
    expect(outcome.message).toContain("error code");
    expect(outcome.message).toContain("report");
    expect(outcome.message).not.toContain("transient");
  });
});
