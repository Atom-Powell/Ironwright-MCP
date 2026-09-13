import { describe, expect, it } from "vitest";
import { defaultRetryPolicy, withRetry } from "../../src/graph/retry.js";

describe("withRetry when attempts are exhausted", () => {
  it("returns the last value rather than throwing, so the caller can name the request", async () => {
    let attempts = 0;
    const policy = defaultRetryPolicy({ maxAttempts: 3, sleep: async () => {}, now: () => 0 });

    const value = await withRetry(
      policy,
      async () => { attempts += 1; return { status: 429, attempts }; },
      () => ({ retriable: true, retryAfter: "0" }),
    );

    expect(attempts).toBe(3);
    expect(value.status).toBe(429);
  });

  it("caps a long Retry-After at maxDelayMs so a scan cannot hang for an hour", async () => {
    const slept: number[] = [];
    const policy = defaultRetryPolicy({
      maxAttempts: 2,
      maxDelayMs: 30_000,
      sleep: async (ms) => { slept.push(ms); },
      now: () => 0,
    });

    await withRetry(policy, async () => ({ status: 429 }), () => ({ retriable: true, retryAfter: "3600" }));

    expect(slept).toEqual([30_000]);
  });
});
