import { describe, expect, it } from "vitest";
import { defaultRetryPolicy, isRetriableStatus, retryAfterDelayMs, withRetry } from "../../src/graph/retry.js";

const NOW = Date.parse("2026-09-13T12:00:00Z");

describe("retryAfterDelayMs", () => {
  it("reads delta-seconds", () => {
    expect(retryAfterDelayMs("12", NOW)).toBe(12_000);
  });

  it("reads an HTTP date as the distance from now", () => {
    expect(retryAfterDelayMs("Sun, 13 Sep 2026 12:00:30 GMT", NOW)).toBe(30_000);
  });

  it("floors an HTTP date already in the past at zero", () => {
    expect(retryAfterDelayMs("Sun, 13 Sep 2026 11:59:00 GMT", NOW)).toBe(0);
  });

  it("returns undefined for an absent or unparseable header", () => {
    expect(retryAfterDelayMs(null, NOW)).toBeUndefined();
    expect(retryAfterDelayMs("soon", NOW)).toBeUndefined();
  });
});

describe("isRetriableStatus", () => {
  it.each([429, 502, 503, 504])("treats %i as retriable", (status) => {
    expect(isRetriableStatus(status)).toBe(true);
  });

  it.each([200, 400, 403, 404, 410, 412])("treats %i as final", (status) => {
    expect(isRetriableStatus(status)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the first non-retriable value without sleeping", async () => {
    const slept: number[] = [];
    const policy = defaultRetryPolicy({ sleep: async (ms) => { slept.push(ms); }, now: () => NOW });

    const value = await withRetry(policy, async () => ({ status: 200 }), (v) => ({
      retriable: isRetriableStatus(v.status),
      retryAfter: null,
    }));

    expect(value.status).toBe(200);
    expect(slept).toEqual([]);
  });

  it("honors Retry-After over its own backoff", async () => {
    const slept: number[] = [];
    const policy = defaultRetryPolicy({ sleep: async (ms) => { slept.push(ms); }, now: () => NOW });
    const statuses = [429, 200];

    await withRetry(
      policy,
      async (attempt) => ({ status: statuses[attempt - 1] ?? 200 }),
      (v) => ({ retriable: isRetriableStatus(v.status), retryAfter: v.status === 429 ? "7" : null }),
    );

    expect(slept).toEqual([7_000]);
  });

  it("backs off exponentially when no Retry-After is sent", async () => {
    const slept: number[] = [];
    const policy = defaultRetryPolicy({
      maxAttempts: 4,
      baseDelayMs: 100,
      sleep: async (ms) => { slept.push(ms); },
      now: () => NOW,
    });

    await withRetry(policy, async () => ({ status: 503 }), () => ({ retriable: true, retryAfter: null }));

    expect(slept).toEqual([100, 200, 400]);
  });
});
