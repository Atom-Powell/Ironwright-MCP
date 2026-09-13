/**
 * No jitter. Graph sends `Retry-After` on every 429 it issues, so the
 * exponential schedule below governs only the rarer 5xx cases, where a handful
 * of clients colliding is not the failure mode jitter exists to prevent. A
 * fixed schedule is also reproducible in a test, which a jittered one is not.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function defaultRetryPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    maxAttempts: 5,
    baseDelayMs: 500,
    maxDelayMs: 60_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    ...overrides,
  };
}

/**
 * `Retry-After` is defined in two forms and Graph has been observed sending
 * both. Reading only the integer form turns a date-form header into no delay at
 * all, which retries immediately into the same throttle.
 */
export function retryAfterDelayMs(header: string | null | undefined, nowMs: number): number | undefined {
  if (header === null || header === undefined) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;

  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

export function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export interface RetryVerdict {
  retriable: boolean;
  retryAfter: string | null;
}

/**
 * Returns the last value rather than throwing when attempts run out. Only the
 * caller knows which request this was and which credential made it, so only the
 * caller can produce an error an operator can act on.
 */
export async function withRetry<T>(
  policy: RetryPolicy,
  run: (attempt: number) => Promise<T>,
  classify: (value: T) => RetryVerdict,
): Promise<T> {
  let value = await run(1);

  for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
    const verdict = classify(value);
    if (!verdict.retriable) return value;

    const fromHeader = retryAfterDelayMs(verdict.retryAfter, policy.now());
    const backoff = policy.baseDelayMs * 2 ** (attempt - 1);
    await policy.sleep(Math.min(fromHeader ?? backoff, policy.maxDelayMs));

    value = await run(attempt + 1);
  }

  return value;
}
