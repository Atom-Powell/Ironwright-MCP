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

describe("withRetry given a thrown-error classifier", () => {
  it("retries a rejection the classifier marks retriable, and returns the value that then succeeds", async () => {
    const slept: number[] = [];
    const policy = defaultRetryPolicy({
      maxAttempts: 3,
      baseDelayMs: 10,
      sleep: async (ms) => { slept.push(ms); },
      now: () => 0,
    });
    let attempts = 0;

    const value = await withRetry(
      policy,
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("socket hang up");
        return { status: 200 };
      },
      () => ({ retriable: false, retryAfter: null }),
      () => true,
    );

    expect(value.status).toBe(200);
    expect(attempts).toBe(2);
    expect(slept).toEqual([10]);
  });

  it("surfaces the original rejection, not a wrapped one, once attempts are exhausted", async () => {
    const policy = defaultRetryPolicy({ maxAttempts: 2, sleep: async () => {}, now: () => 0 });
    const original = new Error("socket hang up");

    await expect(
      withRetry(
        policy,
        async () => {
          throw original;
        },
        () => ({ retriable: false, retryAfter: null }),
        () => true,
      ),
    ).rejects.toBe(original);
  });

  it("defaults to not retrying a rejection when no thrown-error classifier is given", async () => {
    // Every existing caller before this classifier existed relied on this: the
    // first rejection from run() propagates immediately.
    const policy = defaultRetryPolicy({ maxAttempts: 3, sleep: async () => {}, now: () => 0 });
    let attempts = 0;

    await expect(
      withRetry(
        policy,
        async () => {
          attempts += 1;
          throw new Error("boom");
        },
        () => ({ retriable: false, retryAfter: null }),
      ),
    ).rejects.toThrow("boom");
    expect(attempts).toBe(1);
  });
});
