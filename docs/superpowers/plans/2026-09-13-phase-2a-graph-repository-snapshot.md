# Phase 2a: Graph Layer and Repository Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a real, persisted `RepositorySnapshot` for a configured profile from a live SharePoint document library, so that the finished reconciliation engine has half of its input.

**Architecture:** Three new module groups behind one composition root. `src/graph/` is a domain-free Graph access layer over plain `fetch`: token provider, `Retry-After`-aware backoff, path addressing, drive resolution, and a delta pager. `src/store/` is the state index behind a `StateStore` interface with an in-memory and an Azure Table implementation. `src/scan/` composes them into a snapshot and exposes a scripted `scan` command. The domain layer imports none of them; the arrow points one way and the existing purity lint rule enforces it.

**Tech Stack:** TypeScript, Node 22+, ESM with NodeNext resolution, vitest, `@azure/data-tables`, plain `fetch`. No Microsoft Graph JS SDK (see Task 1).

**Spec:** `docs/superpowers/specs/2026-09-13-graph-repository-snapshot-design.md`. It is binding where this plan and it disagree.

## Global Constraints

Every task's requirements implicitly include all of these.

- **No emojis or icons anywhere**, including logs, comments, and docs. **US English throughout.**
- **Comments explain why, not what**, especially around Graph quirks where the reason for a workaround will not be obvious six months from now.
- **A function that cannot observe an outcome must not assert it.** Before finishing any task that changes operator-facing text, enumerate every string that code path can print, reconstruct each composed string from its parts, and confirm that every object it names still exists at that moment and every action it suggests is possible with the credential the operator holds then.
- **The domain layer stays pure.** Nothing in `src/domain/` may import anything added by this plan. Lint enforces it; do not weaken the rule.
- **Imports carry the `.js` extension** (NodeNext), and `verbatimModuleSyntax` is on, so type-only imports must be written `import type`.
- **`noUncheckedIndexedAccess` is on.** An indexed read is `T | undefined` and must be narrowed.
- **Tests live in `tests/`, mirroring `src/`.** Error-path tests go in files ending `.errors.test.ts`, which the `test:errors` script gates separately in CI.
- **Conventional commits**, direct to a feature branch for this phase. Every commit message ends with the two attribution lines this session was given:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ds8MKaFZcayf4Ug91RCLo9
  ```
- **Verification before completion.** `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` must all pass before a task is called done. Run them; do not assume them.
- **No writes to SharePoint of any kind** in this phase. No `If-Match` application, no `conflictBehavior`, no plan tables.

## File Structure

| File | Responsibility |
|---|---|
| `src/graph/errors.ts` | `GraphRequestError` and `graphErrorCodeFromBody`, moved from `src/setup/` now that a second caller exists |
| `src/graph/retry.ts` | Backoff policy: bounded attempts, `Retry-After` in both forms, injected `sleep` |
| `src/graph/token.ts` | `TokenProvider` interface and a caching client-credentials implementation |
| `src/graph/client.ts` | `GraphClient` over `fetch`: bearer token, backoff, typed errors, request counting |
| `src/graph/paths.ts` | Path addressing both directions, and nothing else |
| `src/graph/drive.ts` | Site URL to site id to the named library's drive id |
| `src/graph/delta.ts` | Delta paging, `@odata.nextLink` following, resync detection |
| `src/store/types.ts` | `StateStore` interface and its record types |
| `src/store/memory.ts` | In-memory implementation for tests and local runs |
| `src/store/keys.ts` | Table key composition and encoding, and chunking. Pure, so it is unit-testable without a store |
| `src/store/table.ts` | `@azure/data-tables` implementation behind a narrow injectable client interface |
| `src/config.ts` | Shared environment configuration: Graph credentials and the store connection |
| `src/scan/changes.ts` | Delta items to inventory changes |
| `src/scan/snapshot.ts` | Inventory records to a `RepositorySnapshot` |
| `src/scan/run.ts` | The scan itself: resolve, page, apply, resync, assemble |
| `src/scan/cli.ts` | Argument parsing and operator-facing output. No I/O beyond returning strings |
| `src/scan/main.ts` | The entry point that wires config, store, client and `runScan` |

---

### Task 1: Amend the Decision Record and the parent spec

The two corrections this phase rests on are currently written only in the new design document. Until the binding documents agree, an implementer reading `CLAUDE.md` will reach for the Graph JS SDK and a path-hashed inventory table.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-11-repository-reconciliation-mcp-design.md`
- Modify: `docs/OPEN-ITEMS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing in code. Every later task depends on these documents being true.

- [ ] **Step 1: Amend the stack line in `CLAUDE.md`**

In the Decision Record's "Stack and transport" paragraph, replace the Graph JS SDK claim. The paragraph currently reads "TypeScript and Node with the official MCP SDK and the Microsoft Graph JS SDK." Replace that sentence with:

```markdown
**Stack and transport.** TypeScript and Node with the official MCP SDK, and plain `fetch` for
Microsoft Graph rather than the Graph JS SDK. The SDK's value is middleware -- retry, redirect
handling, and a batch helper -- and those are exactly the behaviors this project builds
deliberately and tests as units, so a dependency that hides them under inherited defaults is a
poor trade for typed models. Amended 2026-09-13; phase 1 had already gone this way without
recording it.
```

- [ ] **Step 2: Amend the Graph-access priority list in `CLAUDE.md`**

Leave the priority order alone. Append one sentence to the "Graph access, in priority order" paragraph:

```markdown
`$batch` and the Microsoft Search cross-check are built in phase 2b, with the callers that
exercise them, rather than ahead of any consumer.
```

- [ ] **Step 3: Amend the parent spec's architecture and state store**

In `docs/superpowers/specs/2026-09-11-repository-reconciliation-mcp-design.md`, in the `graph-lib` paragraph, change "Auth arrives through a token-provider interface so tests inject a fake" to keep that sentence and add before it:

```markdown
Every call goes through plain `fetch`; see `2026-09-13-graph-repository-snapshot-design.md` for
why the Graph JS SDK was declined.
```

In the State store table, change the `Inventory` row key from `path hash` to `driveItem id` and add below the table:

```markdown
The inventory is keyed by item id rather than by a path hash because delta cannot maintain a
path-keyed table: a deleted item arrives as an id and a `deleted` facet carrying no path at all,
and a moved item arrives under the same id with a new path, so a path-keyed table has nothing to
hash on a delete and leaves a ghost row behind on every move. Corrected 2026-09-13.
```

- [ ] **Step 4: Split phase 2 in the parent spec's phase list**

Replace the phase 2 entry with:

```markdown
2. **Graph layer and store.** Split in two on 2026-09-13, because the original entry was seven
   units and contained work with no caller until phase 6. **2a:** token provider, backoff, path
   addressing, ETag capture, delta, both `StateStore` implementations, and a scripted `scan`
   command that produces a persisted `RepositorySnapshot`. **2b:** `$batch`, the Microsoft Search
   cross-check, Excel sessions, and the `WorkbookSnapshot`. `conflictBehavior` moves to phase 6,
   where a write tool first reads it.
```

- [ ] **Step 5: Record the remaining open decision in `docs/OPEN-ITEMS.md`**

Under the "Decisions required before the first live setup run" section, append:

```markdown
**Status at the start of phase 2a, 2026-09-13.** Of the three decisions the design spec required
before phase 2, two are settled and recorded above: the per-site grant does not accept a
delegated token, and the MCP endpoint authenticates through Container Apps built-in Entra auth.
The third, which delegated scopes the setup sign-in must request, is still open. It governs the
setup command's device-code flow and not the server's app-only Graph access, so it does not block
phase 2a and phase 2a does not close it.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-11-repository-reconciliation-mcp-design.md docs/OPEN-ITEMS.md
git commit -m "docs: amend the Decision Record for plain fetch and an id-keyed inventory"
```

---

### Task 2: Move the Graph error type to a shared home

`GraphRequestError` was written for the setup command and lives in `src/setup/`. The Graph client needs it, and a Graph layer importing from `src/setup/` would invert the dependency.

**Files:**
- Create: `src/graph/errors.ts`
- Delete: `src/setup/graph-error.ts`
- Modify: `src/setup/adapter.ts`, `src/setup/cli.ts`, `src/setup/run.ts`, `src/setup/steps.ts` (whichever import it; find them first)
- Modify: existing tests that import it

**Interfaces:**
- Consumes: nothing.
- Produces: `GraphRequestError` (class, constructor takes `{ method: string; path: string; status: number; body: string }`, exposes `method`, `path`, `status`, `code: string | undefined`, `body`) and `graphErrorCodeFromBody(body: string): string | undefined`, both from `src/graph/errors.ts`.

- [ ] **Step 1: Find every importer**

```bash
grep -rn "graph-error" src tests
```

- [ ] **Step 2: Move the file verbatim**

```bash
git mv src/setup/graph-error.ts src/graph/errors.ts
```

Do not change its contents. Its doc comment describes Graph's error shape, which has not changed.

- [ ] **Step 3: Update every import path**

Each importer changes from `./graph-error.js` or `../setup/graph-error.js` to the correct relative path to `src/graph/errors.js`.

- [ ] **Step 4: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS, with the same test count as before the move.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move GraphRequestError to a shared graph module"
```

---

### Task 3: The retry policy

**Files:**
- Create: `src/graph/retry.ts`
- Test: `tests/graph/retry.test.ts`, `tests/graph/retry.errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface RetryPolicy {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  }
  export function defaultRetryPolicy(overrides?: Partial<RetryPolicy>): RetryPolicy;
  export function retryAfterDelayMs(header: string | null | undefined, nowMs: number): number | undefined;
  export function isRetriableStatus(status: number): boolean;
  export interface RetryVerdict { retriable: boolean; retryAfter: string | null }
  export async function withRetry<T>(
    policy: RetryPolicy,
    run: (attempt: number) => Promise<T>,
    classify: (value: T) => RetryVerdict,
  ): Promise<T>;
  ```
  `withRetry` returns the last value when attempts are exhausted; it does not throw. The caller decides what a final retriable status means, because only the caller knows which request it was.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/graph/retry.test.ts
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
```

```ts
// tests/graph/retry.errors.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/graph/retry.test.ts tests/graph/retry.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/graph/retry.js`.

- [ ] **Step 3: Implement**

```ts
// src/graph/retry.ts

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/graph/retry.test.ts tests/graph/retry.errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph/retry.ts tests/graph/retry.test.ts tests/graph/retry.errors.test.ts
git commit -m "feat: add a Retry-After-aware backoff policy for Graph calls"
```

---

### Task 4: The token provider

**Files:**
- Create: `src/graph/token.ts`
- Test: `tests/graph/token.test.ts`, `tests/graph/token.errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface TokenProvider { getToken(): Promise<string> }
  export interface ClientCredentials { tenantId: string; clientId: string; clientSecret: string }
  export interface TokenProviderOptions {
    fetchImpl?: typeof fetch;
    now?: () => number;
    skewSeconds?: number;
  }
  export class TokenRequestError extends Error { readonly status: number; readonly body: string }
  export function clientCredentialsTokenProvider(
    credentials: ClientCredentials,
    options?: TokenProviderOptions,
  ): TokenProvider;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/graph/token.test.ts
import { describe, expect, it } from "vitest";
import { clientCredentialsTokenProvider } from "../../src/graph/token.js";

const CREDENTIALS = { tenantId: "tenant-1", clientId: "client-1", clientSecret: "secret-1" };

function fakeFetch(tokens: string[], seen: Request[] = []): typeof fetch {
  let index = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input as string, init));
    const token = tokens[index] ?? tokens[tokens.length - 1] ?? "t";
    index += 1;
    return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;
}

describe("clientCredentialsTokenProvider", () => {
  it("requests the Graph .default scope against the tenant's token endpoint", async () => {
    const seen: Request[] = [];
    const provider = clientCredentialsTokenProvider(CREDENTIALS, { fetchImpl: fakeFetch(["first"], seen) });

    expect(await provider.getToken()).toBe("first");
    expect(seen[0]?.url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    expect(await seen[0]?.text()).toContain("scope=https%3A%2F%2Fgraph.microsoft.com%2F.default");
  });

  it("caches until the token is within the skew margin of expiry", async () => {
    const seen: Request[] = [];
    let clock = 0;
    const provider = clientCredentialsTokenProvider(CREDENTIALS, {
      fetchImpl: fakeFetch(["first", "second"], seen),
      now: () => clock,
      skewSeconds: 120,
    });

    expect(await provider.getToken()).toBe("first");
    clock = 3_000_000; // 3000s in: still outside the 3600 - 120 boundary
    expect(await provider.getToken()).toBe("first");
    clock = 3_500_000;
    expect(await provider.getToken()).toBe("second");
    expect(seen).toHaveLength(2);
  });

  it("collapses concurrent cold-start callers into one request", async () => {
    const seen: Request[] = [];
    const provider = clientCredentialsTokenProvider(CREDENTIALS, { fetchImpl: fakeFetch(["only"], seen) });

    const tokens = await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);

    expect(tokens).toEqual(["only", "only", "only"]);
    expect(seen).toHaveLength(1);
  });
});
```

```ts
// tests/graph/token.errors.test.ts
import { describe, expect, it } from "vitest";
import { clientCredentialsTokenProvider, TokenRequestError } from "../../src/graph/token.js";

const CREDENTIALS = { tenantId: "tenant-1", clientId: "client-1", clientSecret: "secret-1" };

describe("clientCredentialsTokenProvider failures", () => {
  it("names the credential rather than the site, and never echoes the secret", async () => {
    const body = JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000215" });
    const provider = clientCredentialsTokenProvider(CREDENTIALS, {
      fetchImpl: (async () => new Response(body, { status: 401 })) as typeof fetch,
    });

    await expect(provider.getToken()).rejects.toThrow(TokenRequestError);
    await expect(provider.getToken()).rejects.toThrow(/client id and secret/i);
    await expect(provider.getToken()).rejects.not.toThrow(/secret-1/);
  });

  it("does not cache a failure, so a transient outage does not poison the process", async () => {
    let calls = 0;
    const provider = clientCredentialsTokenProvider(CREDENTIALS, {
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1
          ? new Response("{}", { status: 503 })
          : new Response(JSON.stringify({ access_token: "later", expires_in: 3600 }), { status: 200 });
      }) as typeof fetch,
    });

    await expect(provider.getToken()).rejects.toThrow(TokenRequestError);
    expect(await provider.getToken()).toBe("later");
  });

  it("refuses a 200 whose body carries no access token", async () => {
    const provider = clientCredentialsTokenProvider(CREDENTIALS, {
      fetchImpl: (async () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 })) as typeof fetch,
    });

    await expect(provider.getToken()).rejects.toThrow(/no access_token/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/graph/token.test.ts tests/graph/token.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/graph/token.js`.

- [ ] **Step 3: Implement**

```ts
// src/graph/token.ts

export interface TokenProvider {
  getToken(): Promise<string>;
}

export interface ClientCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface TokenProviderOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Refresh this far before the stated expiry, so a token cannot expire in flight. */
  skewSeconds?: number;
}

/**
 * The body is carried but the credential never is. An operator pasting a failure
 * into a ticket must not paste the client secret with it, and the token endpoint
 * echoes enough in `error_description` to diagnose without it.
 */
export class TokenRequestError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(args: { status: number; body: string }) {
    super(
      `Acquiring a Microsoft Graph token failed with ${args.status}. ` +
        "This is about the server application's own client id and secret, not about the site " +
        `or the signed-in operator. Response: ${args.body}`,
    );
    this.name = "TokenRequestError";
    this.status = args.status;
    this.body = args.body;
  }
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export function clientCredentialsTokenProvider(
  credentials: ClientCredentials,
  options: TokenProviderOptions = {},
): TokenProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const skewMs = (options.skewSeconds ?? 120) * 1000;
  const endpoint = `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`;

  let cached: CachedToken | undefined;
  // A cold start fans out: the drive resolution and the first delta page can ask
  // at the same moment. Without this they mint two tokens and the second
  // overwrites the first for no benefit.
  let inFlight: Promise<CachedToken> | undefined;

  async function request(): Promise<CachedToken> {
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    });

    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    const text = await response.text();
    if (!response.ok) throw new TokenRequestError({ status: response.status, body: text });

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `The token endpoint returned ${response.status} with a body that is not JSON. ` +
          "Something other than Entra answered this request.",
      );
    }

    const token = (parsed as { access_token?: unknown }).access_token;
    const expiresIn = (parsed as { expires_in?: unknown }).expires_in;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(`The token endpoint returned ${response.status} with no access_token.`);
    }

    // An absent expires_in is treated as the shortest lifetime Entra issues
    // rather than as forever, because caching a token past its life produces a
    // 401 on a call that has nothing to do with authentication.
    const lifetimeSeconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 600;
    return { token, expiresAtMs: now() + lifetimeSeconds * 1000 };
  }

  return {
    async getToken(): Promise<string> {
      if (cached !== undefined && now() < cached.expiresAtMs - skewMs) return cached.token;

      inFlight ??= request();
      try {
        cached = await inFlight;
        return cached.token;
      } finally {
        // Cleared on both paths: a cached rejection would make one outage
        // permanent for the life of the process.
        inFlight = undefined;
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/graph/token.test.ts tests/graph/token.errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph/token.ts tests/graph/token.test.ts tests/graph/token.errors.test.ts
git commit -m "feat: add a caching client-credentials token provider"
```

---

### Task 5: The Graph client

**Files:**
- Create: `src/graph/client.ts`
- Test: `tests/graph/client.test.ts`, `tests/graph/client.errors.test.ts`

**Interfaces:**
- Consumes: `GraphRequestError` from `src/graph/errors.js` (Task 2); `RetryPolicy`, `defaultRetryPolicy`, `isRetriableStatus`, `withRetry` from `src/graph/retry.js` (Task 3); `TokenProvider` from `src/graph/token.js` (Task 4).
- Produces:
  ```ts
  export interface GraphClient {
    get<T>(pathOrUrl: string): Promise<T>;
    /** Requests issued since creation, including retries. The scan reports this. */
    readonly requests: () => number;
  }
  export interface GraphClientOptions {
    tokenProvider: TokenProvider;
    retry?: RetryPolicy;
    fetchImpl?: typeof fetch;
  }
  export function createGraphClient(options: GraphClientOptions): GraphClient;
  export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
  ```
  A `pathOrUrl` beginning with `https://` is used as given, which is how a `@odata.nextLink` or a stored `deltaLink` is followed. Anything else is appended to `GRAPH_BASE`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/graph/client.test.ts
import { describe, expect, it } from "vitest";
import { createGraphClient } from "../../src/graph/client.js";
import { defaultRetryPolicy } from "../../src/graph/retry.js";

const TOKEN = { getToken: async () => "token-1" };

describe("createGraphClient", () => {
  it("prefixes a relative path with the v1.0 base and sends the bearer token", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Request(input as string, init));
        return new Response(JSON.stringify({ id: "d1" }), { status: 200 });
      }) as typeof fetch,
    });

    const value = await client.get<{ id: string }>("/drives/d1");

    expect(value.id).toBe("d1");
    expect(seen[0]?.url).toBe("https://graph.microsoft.com/v1.0/drives/d1");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer token-1");
  });

  it("uses an absolute URL as given, which is how a deltaLink is followed", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Request(input as string, init));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await client.get("https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=abc");

    expect(seen[0]?.url).toBe("https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=abc");
  });

  it("retries a 429 and counts every request it made", async () => {
    const statuses = [429, 200];
    let call = 0;
    const client = createGraphClient({
      tokenProvider: TOKEN,
      retry: defaultRetryPolicy({ sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => {
        const status = statuses[call] ?? 200;
        call += 1;
        return new Response("{}", { status, headers: status === 429 ? { "retry-after": "1" } : {} });
      }) as typeof fetch,
    });

    await client.get("/drives/d1");

    expect(client.requests()).toBe(2);
  });
});
```

```ts
// tests/graph/client.errors.test.ts
import { describe, expect, it } from "vitest";
import { createGraphClient } from "../../src/graph/client.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { defaultRetryPolicy } from "../../src/graph/retry.js";

const TOKEN = { getToken: async () => "token-1" };

describe("createGraphClient failures", () => {
  it("throws a GraphRequestError carrying Graph's own code", async () => {
    const body = JSON.stringify({ error: { code: "resyncRequired", message: "gone" } });
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => new Response(body, { status: 410 })) as typeof fetch,
    });

    await expect(client.get("/drives/d1/root/delta")).rejects.toMatchObject({
      name: "GraphRequestError",
      status: 410,
      code: "resyncRequired",
    });
  });

  it("throws after exhausting retries rather than returning a throttled body", async () => {
    const client = createGraphClient({
      tokenProvider: TOKEN,
      retry: defaultRetryPolicy({ maxAttempts: 3, sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => new Response("{}", { status: 429, headers: { "retry-after": "0" } })) as typeof fetch,
    });

    await expect(client.get("/drives/d1")).rejects.toThrow(GraphRequestError);
    expect(client.requests()).toBe(3);
  });

  it("refuses a 2xx body that is not JSON, because a proxy answered rather than Graph", async () => {
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => new Response("<html>sign in</html>", { status: 200 })) as typeof fetch,
    });

    await expect(client.get("/drives/d1")).rejects.toThrow(/not JSON/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/graph/client.test.ts tests/graph/client.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/graph/client.js`.

- [ ] **Step 3: Implement**

```ts
// src/graph/client.ts
import { GraphRequestError } from "./errors.js";
import { defaultRetryPolicy, isRetriableStatus, withRetry, type RetryPolicy } from "./retry.js";
import type { TokenProvider } from "./token.js";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface GraphClient {
  get<T>(pathOrUrl: string): Promise<T>;
  /** Requests issued since creation, retries included. This is the number the scan reports. */
  requests(): number;
}

export interface GraphClientOptions {
  tokenProvider: TokenProvider;
  retry?: RetryPolicy;
  fetchImpl?: typeof fetch;
}

interface RawResponse {
  status: number;
  retryAfter: string | null;
  body: string;
}

export function createGraphClient(options: GraphClientOptions): GraphClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retry = options.retry ?? defaultRetryPolicy();
  let requests = 0;

  async function send(url: string): Promise<RawResponse> {
    // Fetched per attempt rather than per call: a retry that spans a token's
    // expiry would otherwise replay a dead bearer and turn a throttle into a 401.
    const token = await options.tokenProvider.getToken();
    requests += 1;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body: await response.text(),
    };
  }

  return {
    requests: () => requests,

    async get<T>(pathOrUrl: string): Promise<T> {
      const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
      // The path is what an operator recognizes in an error; the absolute URL of
      // a deltaLink is opaque and carries an encoded continuation token.
      const label = pathOrUrl.startsWith("https://") ? url.slice(GRAPH_BASE.length) : pathOrUrl;

      const result = await withRetry(
        retry,
        () => send(url),
        (value) => ({ retriable: isRetriableStatus(value.status), retryAfter: value.retryAfter }),
      );

      if (result.status < 200 || result.status >= 300) {
        throw new GraphRequestError({ method: "GET", path: label, status: result.status, body: result.body });
      }

      if (result.body.length === 0) return undefined as T;

      try {
        return JSON.parse(result.body) as T;
      } catch {
        throw new Error(
          `Graph GET ${label} returned ${result.status} with a body that is not JSON. ` +
            "Something other than Graph answered this request, most often a proxy.",
        );
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/graph/client.test.ts tests/graph/client.errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph/client.ts tests/graph/client.test.ts tests/graph/client.errors.test.ts
git commit -m "feat: add a retrying, request-counting Graph client over fetch"
```

---

### Task 6: Path addressing

This is the module most likely to be subtly wrong, and a wrong library-relative path becomes a file the reconciliation engine reports as missing. It gets the densest tests in the slice.

**Files:**
- Create: `src/graph/paths.ts`
- Test: `tests/graph/paths.test.ts`, `tests/graph/paths.errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export function driveItemPath(driveId: string, libraryRelativePath: string): string;
  export function libraryRelativePath(parentReferencePath: string, name: string): string;
  export class ParentPathError extends Error { readonly parentReferencePath: string }
  ```
  `driveItemPath("d1", "2026/CLIENT A/report.xlsx")` yields `/drives/d1/root:/2026/CLIENT%20A/report.xlsx:`. `driveItemPath("d1", "")` yields `/drives/d1/root`, because the root has no colon form.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/graph/paths.test.ts
import { describe, expect, it } from "vitest";
import { driveItemPath, libraryRelativePath } from "../../src/graph/paths.js";

describe("driveItemPath", () => {
  it("builds the colon form and encodes each segment", () => {
    expect(driveItemPath("d1", "2026/CLIENT A/report.xlsx")).toBe("/drives/d1/root:/2026/CLIENT%20A/report.xlsx:");
  });

  it("encodes a hash and a question mark, which would otherwise truncate the URL", () => {
    expect(driveItemPath("d1", "Q1 #2/what?.xlsx")).toBe("/drives/d1/root:/Q1%20%232/what%3F.xlsx:");
  });

  it("addresses the root without a colon form", () => {
    expect(driveItemPath("d1", "")).toBe("/drives/d1/root");
  });

  it("tolerates a leading slash rather than producing an empty first segment", () => {
    expect(driveItemPath("d1", "/2026/a.xlsx")).toBe("/drives/d1/root:/2026/a.xlsx:");
  });
});

describe("libraryRelativePath", () => {
  it("strips the drive prefix and returns a library-relative path with no leading slash", () => {
    expect(libraryRelativePath("/drives/d1/root:/2026/CLIENTA", "report.xlsx")).toBe("2026/CLIENTA/report.xlsx");
  });

  it("returns a bare name for an item sitting in the library root", () => {
    expect(libraryRelativePath("/drives/d1/root:", "report.xlsx")).toBe("report.xlsx");
  });

  it("decodes percent-encoded segments, since Graph returns the path encoded", () => {
    expect(libraryRelativePath("/drives/d1/root:/2026/CLIENT%20A", "a%20b.xlsx")).toBe("2026/CLIENT A/a%20b.xlsx");
  });

  it("accepts the singular drive form some responses use", () => {
    expect(libraryRelativePath("/drive/root:/2026", "a.xlsx")).toBe("2026/a.xlsx");
  });
});
```

Note on the third case: `name` is returned by Graph unencoded, so it is used verbatim. Only the parent path is decoded. The assertion above is deliberate and documents that asymmetry.

```ts
// tests/graph/paths.errors.test.ts
import { describe, expect, it } from "vitest";
import { libraryRelativePath, ParentPathError } from "../../src/graph/paths.js";

describe("libraryRelativePath failures", () => {
  it("refuses a parent path with no root marker, naming the value it was given", () => {
    expect(() => libraryRelativePath("/sites/s1/lists/l1", "a.xlsx")).toThrow(ParentPathError);
    expect(() => libraryRelativePath("/sites/s1/lists/l1", "a.xlsx")).toThrow(/\/sites\/s1\/lists\/l1/);
  });

  it("refuses an empty parent path rather than returning a bare name", () => {
    expect(() => libraryRelativePath("", "a.xlsx")).toThrow(ParentPathError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/graph/paths.test.ts tests/graph/paths.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/graph/paths.js`.

- [ ] **Step 3: Implement**

```ts
// src/graph/paths.ts

/**
 * Path addressing is the default mode for a reason: a driveItem id is stable
 * only until someone moves the file, and an id-navigating tool fails on exactly
 * the repositories that need reconciling most.
 */

const ROOT_MARKER = "root:";

export class ParentPathError extends Error {
  readonly parentReferencePath: string;

  constructor(parentReferencePath: string) {
    super(
      "A driveItem's parentReference.path did not contain the expected \"root:\" marker, so its " +
        `library-relative path cannot be derived. Received: "${parentReferencePath}". ` +
        "Refused rather than guessed, because a wrong path becomes a file the reconciliation " +
        "engine reports as missing.",
    );
    this.name = "ParentPathError";
    this.parentReferencePath = parentReferencePath;
  }
}

/**
 * `encodeURIComponent` per segment rather than `encodeURI` over the whole path.
 * `encodeURI` leaves `#` and `?` alone, and either one in a SharePoint file name
 * truncates the request URL at that character and addresses the wrong item.
 */
export function driveItemPath(driveId: string, libraryRelativePath: string): string {
  const trimmed = libraryRelativePath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return `/drives/${driveId}/root`;

  const encoded = trimmed.split("/").map(encodeURIComponent).join("/");
  return `/drives/${driveId}/root:/${encoded}:`;
}

/**
 * Graph returns `parentReference.path` percent-encoded and `name` unencoded, so
 * only the parent half is decoded here. Decoding the name as well would turn a
 * file genuinely called "a%20b.xlsx" into "a b.xlsx" and the engine would then
 * report the real file as missing and the decoded one as an orphan.
 */
export function libraryRelativePath(parentReferencePath: string, name: string): string {
  const marker = parentReferencePath.indexOf(ROOT_MARKER);
  if (marker === -1) throw new ParentPathError(parentReferencePath);

  const afterRoot = parentReferencePath.slice(marker + ROOT_MARKER.length);
  const segments = afterRoot
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent);

  return [...segments, name].join("/");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/graph/paths.test.ts tests/graph/paths.errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph/paths.ts tests/graph/paths.test.ts tests/graph/paths.errors.test.ts
git commit -m "feat: add path addressing in both directions"
```

---

### Task 7: Drive resolution

**Files:**
- Create: `src/graph/drive.ts`
- Test: `tests/graph/drive.test.ts`, `tests/graph/drive.errors.test.ts`

**Interfaces:**
- Consumes: `GraphClient` from `src/graph/client.js` (Task 5).
- Produces:
  ```ts
  export interface DriveLocation { siteId: string; driveId: string }
  export class LibraryNotFoundError extends Error {
    readonly library: string;
    readonly available: string[];
  }
  export function siteLookupPath(siteUrl: string): string;
  export async function resolveDrive(client: GraphClient, siteUrl: string, library: string): Promise<DriveLocation>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/graph/drive.test.ts
import { describe, expect, it } from "vitest";
import { resolveDrive, siteLookupPath } from "../../src/graph/drive.js";
import type { GraphClient } from "../../src/graph/client.js";

function fakeClient(responses: Record<string, unknown>): GraphClient {
  return {
    requests: () => 0,
    get: async <T,>(path: string): Promise<T> => {
      if (!(path in responses)) throw new Error(`unexpected path ${path}`);
      return responses[path] as T;
    },
  };
}

describe("siteLookupPath", () => {
  it("turns a site URL into the hostname-and-server-relative-path form", () => {
    expect(siteLookupPath("https://contoso.sharepoint.com/sites/Example")).toBe(
      "/sites/contoso.sharepoint.com:/sites/Example",
    );
  });

  it("addresses the root site when the URL has no path", () => {
    expect(siteLookupPath("https://contoso.sharepoint.com")).toBe("/sites/contoso.sharepoint.com");
  });
});

describe("resolveDrive", () => {
  it("resolves the site then the named library", async () => {
    const client = fakeClient({
      "/sites/contoso.sharepoint.com:/sites/Example": { id: "site-1" },
      "/sites/site-1/drives?$select=id,name": {
        value: [
          { id: "drive-a", name: "Documents" },
          { id: "drive-b", name: "Compliance Reports" },
        ],
      },
    });

    await expect(resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Compliance Reports")).resolves.toEqual({
      siteId: "site-1",
      driveId: "drive-b",
    });
  });

  it("matches a library name case-insensitively when nothing matches exactly", async () => {
    const client = fakeClient({
      "/sites/contoso.sharepoint.com:/sites/Example": { id: "site-1" },
      "/sites/site-1/drives?$select=id,name": { value: [{ id: "drive-b", name: "Compliance Reports" }] },
    });

    await expect(resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "compliance reports")).resolves.toEqual({
      siteId: "site-1",
      driveId: "drive-b",
    });
  });
});
```

```ts
// tests/graph/drive.errors.test.ts
import { describe, expect, it } from "vitest";
import { LibraryNotFoundError, resolveDrive } from "../../src/graph/drive.js";
import type { GraphClient } from "../../src/graph/client.js";

function fakeClient(responses: Record<string, unknown>): GraphClient {
  return {
    requests: () => 0,
    get: async <T,>(path: string): Promise<T> => responses[path] as T,
  };
}

describe("resolveDrive failures", () => {
  it("lists the libraries that do exist, because a bare not-found sends an operator to the wrong place", async () => {
    const client = fakeClient({
      "/sites/contoso.sharepoint.com:/sites/Example": { id: "site-1" },
      "/sites/site-1/drives?$select=id,name": {
        value: [
          { id: "drive-a", name: "Documents" },
          { id: "drive-c", name: "Archive" },
        ],
      },
    });

    const failure = resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Compliance Reports");

    await expect(failure).rejects.toThrow(LibraryNotFoundError);
    await expect(failure).rejects.toThrow(/"Archive", "Documents"/);
  });

  it("says the site has no libraries at all rather than printing an empty list", async () => {
    const client = fakeClient({
      "/sites/contoso.sharepoint.com:/sites/Example": { id: "site-1" },
      "/sites/site-1/drives?$select=id,name": { value: [] },
    });

    await expect(
      resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Compliance Reports"),
    ).rejects.toThrow(/no document libraries/i);
  });

  it("refuses a site response with no id rather than addressing /sites/undefined/drives", async () => {
    const client = fakeClient({ "/sites/contoso.sharepoint.com:/sites/Example": {} });

    await expect(
      resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Compliance Reports"),
    ).rejects.toThrow(/no id/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/graph/drive.test.ts tests/graph/drive.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/graph/drive.js`.

- [ ] **Step 3: Implement**

```ts
// src/graph/drive.ts
import type { GraphClient } from "./client.js";

export interface DriveLocation {
  siteId: string;
  driveId: string;
}

export class LibraryNotFoundError extends Error {
  readonly library: string;
  readonly available: string[];

  constructor(library: string, available: string[]) {
    const tail =
      available.length === 0
        ? "That site has no document libraries at all, which usually means the site URL in the profile names the wrong site."
        : `The libraries on that site are: ${available.map((name) => `"${name}"`).join(", ")}.`;
    super(`No document library named "${library}" was found. ${tail}`);
    this.name = "LibraryNotFoundError";
    this.library = library;
    this.available = available;
  }
}

/**
 * Graph addresses a site by hostname and server-relative path rather than by the
 * URL as typed. A root site has no path segment and takes the short form; giving
 * it the colon form yields a 400 rather than the site.
 */
export function siteLookupPath(siteUrl: string): string {
  const url = new URL(siteUrl);
  const serverRelative = url.pathname.replace(/\/+$/, "");
  if (serverRelative.length === 0 || serverRelative === "/") return `/sites/${url.hostname}`;
  return `/sites/${url.hostname}:${serverRelative}`;
}

interface DriveListing {
  value?: Array<{ id?: unknown; name?: unknown }>;
}

export async function resolveDrive(
  client: GraphClient,
  siteUrl: string,
  library: string,
): Promise<DriveLocation> {
  const site = await client.get<{ id?: unknown }>(siteLookupPath(siteUrl));
  if (typeof site.id !== "string" || site.id.length === 0) {
    // Without this the site id interpolates as the literal text "undefined" into
    // the next path and the failure surfaces one call away from its cause.
    throw new Error(`Resolving the site "${siteUrl}" returned a response with no id.`);
  }

  const listing = await client.get<DriveListing>(`/sites/${site.id}/drives?$select=id,name`);
  const drives = (listing.value ?? []).flatMap((drive) =>
    typeof drive.id === "string" && typeof drive.name === "string" ? [{ id: drive.id, name: drive.name }] : [],
  );

  // Exact first. SharePoint permits two libraries whose names differ only in
  // case, so falling straight to a case-insensitive match could pick the wrong one.
  const exact = drives.find((drive) => drive.name === library);
  const insensitive = drives.find((drive) => drive.name.toLowerCase() === library.toLowerCase());
  const matched = exact ?? insensitive;

  if (matched === undefined) {
    throw new LibraryNotFoundError(
      library,
      drives.map((drive) => drive.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }

  return { siteId: site.id, driveId: matched.id };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/graph/drive.test.ts tests/graph/drive.errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph/drive.ts tests/graph/drive.test.ts tests/graph/drive.errors.test.ts
git commit -m "feat: resolve a site URL and library name to a drive id"
```

---

### Task 8: The delta pager

**Files:**
- Create: `src/graph/delta.ts`
- Test: `tests/graph/delta.test.ts`, `tests/graph/delta.errors.test.ts`

**Interfaces:**
- Consumes: `GraphClient` (Task 5), `GraphRequestError` (Task 2).
- Produces:
  ```ts
  export interface DeltaItem {
    id?: string;
    name?: string;
    size?: number;
    lastModifiedDateTime?: string;
    eTag?: string;
    parentReference?: { path?: string; driveId?: string };
    folder?: Record<string, unknown>;
    file?: Record<string, unknown>;
    root?: Record<string, unknown>;
    deleted?: { state?: string };
  }
  export interface DeltaPage { items: DeltaItem[]; deltaLink?: string }
  export class DeltaResyncRequiredError extends Error {}
  export function deltaPages(
    client: GraphClient,
    driveId: string,
    storedDeltaLink?: string,
  ): AsyncGenerator<DeltaPage, void, undefined>;
  ```
  Each yielded page carries `deltaLink` only on the final page, which is how the caller knows the enumeration finished.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/graph/delta.test.ts
import { describe, expect, it } from "vitest";
import { deltaPages } from "../../src/graph/delta.js";
import type { GraphClient } from "../../src/graph/client.js";

function fakeClient(responses: Record<string, unknown>, seen: string[] = []): GraphClient {
  return {
    requests: () => seen.length,
    get: async <T,>(path: string): Promise<T> => {
      seen.push(path);
      if (!(path in responses)) throw new Error(`unexpected path ${path}`);
      return responses[path] as T;
    },
  };
}

describe("deltaPages", () => {
  it("starts at the drive root when there is no stored link, and follows nextLink to the end", async () => {
    const seen: string[] = [];
    const client = fakeClient(
      {
        "/drives/d1/root/delta": {
          value: [{ id: "1" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=p2",
        },
        "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=p2": {
          value: [{ id: "2" }],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=final",
        },
      },
      seen,
    );

    const pages = [];
    for await (const page of deltaPages(client, "d1")) pages.push(page);

    expect(pages.map((page) => page.items.map((item) => item.id))).toEqual([["1"], ["2"]]);
    expect(pages[0]?.deltaLink).toBeUndefined();
    expect(pages[1]?.deltaLink).toBe("https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=final");
    expect(seen).toHaveLength(2);
  });

  it("starts at a stored deltaLink when one is given", async () => {
    const seen: string[] = [];
    const client = fakeClient(
      {
        "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=stored": {
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=next",
        },
      },
      seen,
    );

    const pages = [];
    for await (const page of deltaPages(client, "d1", "https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=stored")) {
      pages.push(page);
    }

    expect(seen).toEqual(["https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=stored"]);
    expect(pages[0]?.items).toEqual([]);
  });
});
```

```ts
// tests/graph/delta.errors.test.ts
import { describe, expect, it } from "vitest";
import { DeltaResyncRequiredError, deltaPages } from "../../src/graph/delta.js";
import type { GraphClient } from "../../src/graph/client.js";
import { GraphRequestError } from "../../src/graph/errors.js";

function throwingClient(error: unknown): GraphClient {
  return { requests: () => 1, get: async () => { throw error; } };
}

const RESYNC = new GraphRequestError({
  method: "GET",
  path: "/drives/d1/root/delta",
  status: 410,
  body: JSON.stringify({ error: { code: "resyncRequired", message: "gone" } }),
});

describe("deltaPages failures", () => {
  it("turns a 410 resyncRequired on a stored link into DeltaResyncRequiredError", async () => {
    const iterator = deltaPages(throwingClient(RESYNC), "d1", "https://graph.microsoft.com/v1.0/stored");
    await expect(iterator.next()).rejects.toThrow(DeltaResyncRequiredError);
  });

  it("leaves a 410 on a fresh enumeration as the Graph error it is, since there is nothing to resync from", async () => {
    const iterator = deltaPages(throwingClient(RESYNC), "d1");
    await expect(iterator.next()).rejects.toThrow(GraphRequestError);
  });

  it("refuses a page carrying neither a nextLink nor a deltaLink, rather than looping or stopping silently", async () => {
    const client: GraphClient = { requests: () => 1, get: async () => ({ value: [] }) as never };
    const iterator = deltaPages(client, "d1");
    await expect(iterator.next()).rejects.toThrow(/neither @odata.nextLink nor @odata.deltaLink/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/graph/delta.test.ts tests/graph/delta.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/graph/delta.js`.

- [ ] **Step 3: Implement**

```ts
// src/graph/delta.ts
import type { GraphClient } from "./client.js";
import { GraphRequestError } from "./errors.js";

export interface DeltaItem {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  eTag?: string;
  parentReference?: { path?: string; driveId?: string };
  folder?: Record<string, unknown>;
  file?: Record<string, unknown>;
  root?: Record<string, unknown>;
  deleted?: { state?: string };
}

export interface DeltaPage {
  items: DeltaItem[];
  /** Present only on the final page. Its arrival is how the caller knows the enumeration finished. */
  deltaLink?: string;
}

/**
 * A stored `deltaLink` can age out of the service's change log. Graph answers
 * 410 with `resyncRequired`, and the only correct response is to discard what is
 * stored and enumerate again, which the caller does because only the caller owns
 * the inventory.
 */
export class DeltaResyncRequiredError extends Error {
  constructor(driveId: string) {
    super(
      `The stored deltaLink for drive ${driveId} is no longer valid and Graph asked for a resync. ` +
        "The stored inventory for that drive must be discarded and the drive enumerated from scratch.",
    );
    this.name = "DeltaResyncRequiredError";
  }
}

interface DeltaResponse {
  value?: DeltaItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export async function* deltaPages(
  client: GraphClient,
  driveId: string,
  storedDeltaLink?: string,
): AsyncGenerator<DeltaPage, void, undefined> {
  let url = storedDeltaLink ?? `/drives/${driveId}/root/delta`;

  for (;;) {
    let response: DeltaResponse;
    try {
      response = await client.get<DeltaResponse>(url);
    } catch (error) {
      // Only a stored link can be resynced from. A 410 on a fresh enumeration
      // means something else entirely, and relabeling it would send the caller
      // to clear an inventory that was never the problem.
      if (storedDeltaLink !== undefined && error instanceof GraphRequestError && error.status === 410) {
        throw new DeltaResyncRequiredError(driveId);
      }
      throw error;
    }

    const next = response["@odata.nextLink"];
    const final = response["@odata.deltaLink"];

    if (next === undefined && final === undefined) {
      throw new Error(
        `A delta response for drive ${driveId} carried neither @odata.nextLink nor @odata.deltaLink. ` +
          "Continuing would either loop on the same page or stop with an inventory that is silently incomplete.",
      );
    }

    yield { items: response.value ?? [], ...(final === undefined ? {} : { deltaLink: final }) };

    if (final !== undefined) return;
    url = next as string;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/graph/delta.test.ts tests/graph/delta.errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph/delta.ts tests/graph/delta.test.ts tests/graph/delta.errors.test.ts
git commit -m "feat: page a drive's delta feed and detect a required resync"
```

---

### Task 9: The StateStore interface and the in-memory implementation

**Files:**
- Create: `src/store/types.ts`, `src/store/keys.ts`, `src/store/memory.ts`
- Test: `tests/store/keys.test.ts`, `tests/store/conformance.ts` (a shared suite, not a test file), `tests/store/memory.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/store/types.ts
  export interface InventoryRecord {
    itemId: string;
    path: string;
    name: string;
    isFolder: boolean;
    size: number;
    modified: string;
    etag: string;
  }
  export type InventoryChange =
    | { kind: "upsert"; record: InventoryRecord }
    | { kind: "delete"; itemId: string };
  export interface ApplyResult { changesApplied: number; batches: number }
  export interface StateStore {
    getDeltaLink(profileId: string, driveId: string): Promise<string | undefined>;
    setDeltaLink(profileId: string, driveId: string, deltaLink: string, lastScanAt: string): Promise<void>;
    clearInventory(profileId: string, driveId: string): Promise<void>;
    applyInventoryChanges(profileId: string, driveId: string, changes: InventoryChange[]): Promise<ApplyResult>;
    listInventory(profileId: string, driveId: string): Promise<InventoryRecord[]>;
  }

  // src/store/keys.ts
  export const MAX_TRANSACTION_SIZE = 100;
  export function inventoryPartitionKey(profileId: string, driveId: string): string;
  export function encodeRowKey(itemId: string): string;
  export function decodeRowKey(rowKey: string): string;
  export function chunk<T>(items: readonly T[], size: number): T[][];
  export class UnsafeKeyError extends Error {}

  // src/store/memory.ts
  export function createMemoryStateStore(): StateStore;
  ```
  `batches` counts write operations issued to the backing store. Both implementations chunk at `MAX_TRANSACTION_SIZE`, so the number means the same thing in either and the scan can report it without qualification.

- [ ] **Step 1: Write the failing key tests**

```ts
// tests/store/keys.test.ts
import { describe, expect, it } from "vitest";
import { chunk, decodeRowKey, encodeRowKey, inventoryPartitionKey, UnsafeKeyError } from "../../src/store/keys.js";

describe("encodeRowKey", () => {
  it.each([
    "01ABCDEF",
    "b!x-y_z",
    "has/slash",
    "has\\backslash",
    "has#hash",
    "has?question",
    "spaces and Ünicode",
  ])("round-trips %s through an alphabet Azure Table accepts", (itemId) => {
    const encoded = encodeRowKey(itemId);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRowKey(encoded)).toBe(itemId);
  });
});

describe("inventoryPartitionKey", () => {
  it("joins the profile id and drive id unambiguously", () => {
    expect(inventoryPartitionKey("example", "b!abc")).toBe("example|b!abc");
  });

  it("refuses a drive id carrying a character Azure Table forbids in a key", () => {
    expect(() => inventoryPartitionKey("example", "b!a/c")).toThrow(UnsafeKeyError);
  });
});

describe("chunk", () => {
  it("splits into full groups and a remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no groups for an empty list, so a no-op scan writes nothing", () => {
    expect(chunk([], 100)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/store/keys.test.ts`
Expected: FAIL, cannot resolve `../../src/store/keys.js`.

- [ ] **Step 3: Implement the types and keys**

```ts
// src/store/types.ts

export interface InventoryRecord {
  itemId: string;
  /** Library-relative, no leading slash. */
  path: string;
  name: string;
  isFolder: boolean;
  size: number;
  modified: string;
  /** Captured now because a later rename or move plan needs it as an If-Match precondition. */
  etag: string;
}

export type InventoryChange =
  | { kind: "upsert"; record: InventoryRecord }
  | { kind: "delete"; itemId: string };

export interface ApplyResult {
  changesApplied: number;
  /** Write operations issued to the backing store. The scan reports this number. */
  batches: number;
}

export interface StateStore {
  getDeltaLink(profileId: string, driveId: string): Promise<string | undefined>;
  setDeltaLink(profileId: string, driveId: string, deltaLink: string, lastScanAt: string): Promise<void>;
  clearInventory(profileId: string, driveId: string): Promise<void>;
  applyInventoryChanges(profileId: string, driveId: string, changes: InventoryChange[]): Promise<ApplyResult>;
  listInventory(profileId: string, driveId: string): Promise<InventoryRecord[]>;
}
```

```ts
// src/store/keys.ts

/** Azure Table caps a transaction at 100 entities sharing one partition. */
export const MAX_TRANSACTION_SIZE = 100;

// Azure Table rejects these in a PartitionKey or RowKey. Control characters are
// rejected too and are covered by the same test.
const FORBIDDEN = /[/\\#?\u0000-\u001F\u007F-\u009F]/;

export class UnsafeKeyError extends Error {
  constructor(part: string, value: string) {
    super(
      `The ${part} "${value}" contains a character Azure Table forbids in a key (/, \\, #, ? or a ` +
        "control character). Refused rather than sanitized, because a sanitized key silently " +
        "collides with a different item's row.",
    );
    this.name = "UnsafeKeyError";
  }
}

/**
 * The profile id is already restricted to lowercase letters, digits and hyphens
 * by the profile schema, so a pipe cannot occur in it and the join is
 * unambiguous. The drive id is checked rather than encoded, because a readable
 * partition key is worth keeping when someone is looking at the table in a
 * portal, and a drive id containing a forbidden character would be a Graph
 * change worth failing loudly on.
 */
export function inventoryPartitionKey(profileId: string, driveId: string): string {
  if (FORBIDDEN.test(profileId)) throw new UnsafeKeyError("profile id", profileId);
  if (FORBIDDEN.test(driveId)) throw new UnsafeKeyError("drive id", driveId);
  return `${profileId}|${driveId}`;
}

/**
 * A driveItem id is an opaque string whose alphabet we do not control, so it is
 * encoded rather than checked. base64url keeps the result inside the characters
 * a key accepts and stays reversible, which a hash would not.
 */
export function encodeRowKey(itemId: string): string {
  return Buffer.from(itemId, "utf8").toString("base64url");
}

export function decodeRowKey(rowKey: string): string {
  return Buffer.from(rowKey, "base64url").toString("utf8");
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}
```

- [ ] **Step 4: Run to verify the key tests pass**

Run: `npx vitest run tests/store/keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the shared conformance suite and the in-memory test**

```ts
// tests/store/conformance.ts
import { expect, it } from "vitest";
import type { InventoryRecord, StateStore } from "../../src/store/types.js";

export function record(overrides: Partial<InventoryRecord> = {}): InventoryRecord {
  return {
    itemId: "item-1",
    path: "2026/CLIENTA/report.xlsx",
    name: "report.xlsx",
    isFolder: false,
    size: 1024,
    modified: "2026-09-01T00:00:00Z",
    etag: "etag-1",
    ...overrides,
  };
}

/**
 * One set of expectations for every StateStore implementation, so the in-memory
 * store used in tests and the Table store used in production cannot drift into
 * answering the same question differently.
 */
export function stateStoreConformance(create: () => StateStore): void {
  it("returns no deltaLink before one is stored", async () => {
    await expect(create().getDeltaLink("example", "d1")).resolves.toBeUndefined();
  });

  it("round-trips a deltaLink per profile and drive", async () => {
    const store = create();
    await store.setDeltaLink("example", "d1", "link-1", "2026-09-13T00:00:00Z");
    await store.setDeltaLink("example", "d2", "link-2", "2026-09-13T00:00:00Z");

    await expect(store.getDeltaLink("example", "d1")).resolves.toBe("link-1");
    await expect(store.getDeltaLink("other", "d1")).resolves.toBeUndefined();
  });

  it("upserts by item id, so a moved item replaces its row rather than adding one", async () => {
    const store = create();
    await store.applyInventoryChanges("example", "d1", [
      { kind: "upsert", record: record({ path: "2026/CLIENTA/report.xlsx" }) },
    ]);
    await store.applyInventoryChanges("example", "d1", [
      { kind: "upsert", record: record({ path: "2026/CLIENTB/report.xlsx" }) },
    ]);

    const listed = await store.listInventory("example", "d1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.path).toBe("2026/CLIENTB/report.xlsx");
  });

  it("deletes by item id", async () => {
    const store = create();
    await store.applyInventoryChanges("example", "d1", [{ kind: "upsert", record: record() }]);
    await store.applyInventoryChanges("example", "d1", [{ kind: "delete", itemId: "item-1" }]);

    await expect(store.listInventory("example", "d1")).resolves.toEqual([]);
  });

  it("tolerates deleting an item it never held", async () => {
    const store = create();
    await expect(
      store.applyInventoryChanges("example", "d1", [{ kind: "delete", itemId: "never-seen" }]),
    ).resolves.toMatchObject({ changesApplied: 1 });
  });

  it("keeps one drive's inventory out of another's", async () => {
    const store = create();
    await store.applyInventoryChanges("example", "d1", [{ kind: "upsert", record: record() }]);
    await expect(store.listInventory("example", "d2")).resolves.toEqual([]);
  });

  it("clears one drive's inventory and leaves the other alone", async () => {
    const store = create();
    await store.applyInventoryChanges("example", "d1", [{ kind: "upsert", record: record() }]);
    await store.applyInventoryChanges("example", "d2", [{ kind: "upsert", record: record({ itemId: "item-2" }) }]);

    await store.clearInventory("example", "d1");

    await expect(store.listInventory("example", "d1")).resolves.toEqual([]);
    await expect(store.listInventory("example", "d2")).resolves.toHaveLength(1);
  });

  it("reports batches in units of 100 upserts", async () => {
    const store = create();
    const changes = Array.from({ length: 250 }, (_, index) => ({
      kind: "upsert" as const,
      record: record({ itemId: `item-${index}` }),
    }));

    await expect(store.applyInventoryChanges("example", "d1", changes)).resolves.toEqual({
      changesApplied: 250,
      batches: 3,
    });
  });

  it("writes nothing for an empty change list", async () => {
    await expect(create().applyInventoryChanges("example", "d1", [])).resolves.toEqual({
      changesApplied: 0,
      batches: 0,
    });
  });
}
```

```ts
// tests/store/memory.test.ts
import { describe } from "vitest";
import { createMemoryStateStore } from "../../src/store/memory.js";
import { stateStoreConformance } from "./conformance.js";

describe("in-memory state store", () => {
  stateStoreConformance(() => createMemoryStateStore());
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run tests/store/memory.test.ts`
Expected: FAIL, cannot resolve `../../src/store/memory.js`.

- [ ] **Step 7: Implement the in-memory store**

```ts
// src/store/memory.ts
import { chunk, inventoryPartitionKey, MAX_TRANSACTION_SIZE } from "./keys.js";
import type { ApplyResult, InventoryChange, InventoryRecord, StateStore } from "./types.js";

/**
 * For tests and for a local run with no storage account. It chunks the same way
 * the Table implementation does, not because memory needs it, but so that
 * `batches` counts the same thing in both and the scan can print the number
 * without qualifying which store produced it.
 */
export function createMemoryStateStore(): StateStore {
  const deltaLinks = new Map<string, string>();
  const inventories = new Map<string, Map<string, InventoryRecord>>();

  function inventoryFor(profileId: string, driveId: string): Map<string, InventoryRecord> {
    const key = inventoryPartitionKey(profileId, driveId);
    let inventory = inventories.get(key);
    if (inventory === undefined) {
      inventory = new Map();
      inventories.set(key, inventory);
    }
    return inventory;
  }

  return {
    async getDeltaLink(profileId, driveId) {
      return deltaLinks.get(inventoryPartitionKey(profileId, driveId));
    },

    async setDeltaLink(profileId, driveId, deltaLink) {
      deltaLinks.set(inventoryPartitionKey(profileId, driveId), deltaLink);
    },

    async clearInventory(profileId, driveId) {
      inventories.delete(inventoryPartitionKey(profileId, driveId));
    },

    async applyInventoryChanges(profileId, driveId, changes): Promise<ApplyResult> {
      const inventory = inventoryFor(profileId, driveId);
      const upserts = changes.filter((change): change is Extract<InventoryChange, { kind: "upsert" }> =>
        change.kind === "upsert",
      );
      const deletes = changes.filter((change): change is Extract<InventoryChange, { kind: "delete" }> =>
        change.kind === "delete",
      );

      for (const change of upserts) inventory.set(change.record.itemId, change.record);
      for (const change of deletes) inventory.delete(change.itemId);

      return {
        changesApplied: changes.length,
        batches: chunk(upserts, MAX_TRANSACTION_SIZE).length + deletes.length,
      };
    },

    async listInventory(profileId, driveId) {
      return [...inventoryFor(profileId, driveId).values()];
    },
  };
}
```

- [ ] **Step 8: Run the store tests**

Run: `npx vitest run tests/store/`
Expected: PASS. If the `batches` case fails, note that the conformance case uses upserts only, so the expected count is `ceil(250 / 100) = 3`.

- [ ] **Step 9: Commit**

```bash
git add src/store tests/store
git commit -m "feat: add the StateStore interface, its key rules, and an in-memory implementation"
```

---

### Task 10: The Azure Table state store

**Files:**
- Create: `src/store/table.ts`
- Create: `tests/store/fake-table-client.ts` (a helper, not a test file, so vitest does not collect it)
- Test: `tests/store/table.test.ts`, `tests/store/table.errors.test.ts`
- Modify: `package.json` (add `@azure/data-tables` to `dependencies`)

**Interfaces:**
- Consumes: `StateStore`, `InventoryChange`, `InventoryRecord`, `ApplyResult` (Task 9); `chunk`, `encodeRowKey`, `decodeRowKey`, `inventoryPartitionKey`, `MAX_TRANSACTION_SIZE` (Task 9).
- Produces:
  ```ts
  export interface TableEntityLike { partitionKey: string; rowKey: string; [key: string]: unknown }
  export interface TableClientLike {
    createTable(): Promise<unknown>;
    getEntity(partitionKey: string, rowKey: string): Promise<TableEntityLike>;
    upsertEntity(entity: TableEntityLike, mode: "Replace"): Promise<unknown>;
    deleteEntity(partitionKey: string, rowKey: string): Promise<unknown>;
    listEntities(options?: { queryOptions?: { filter?: string } }): AsyncIterable<TableEntityLike>;
    submitTransaction(actions: Array<["upsert", TableEntityLike, "Replace"] | ["delete", TableEntityLike]>): Promise<unknown>;
  }
  export interface TableStateStoreClients { deltaLinks: TableClientLike; inventory: TableClientLike }
  export function createTableStateStore(clients: TableStateStoreClients): StateStore;
  export async function ensureTables(clients: TableStateStoreClients): Promise<void>;
  export function tableStateStoreFromConnectionString(
    connectionString: string,
  ): { store: StateStore; clients: TableStateStoreClients };
  ```
  The connection-string factory returns the clients alongside the store so the entry point can call `ensureTables` on the same pair rather than constructing a second one.
  The narrow `TableClientLike` interface exists so the transaction chunking and the delete-tolerance are testable against a fake, with no emulator and no account. `@azure/data-tables`'s real `TableClient` satisfies it structurally.

  Note added during execution: Task 9's review found `lastScanAt` accepted but unobservable, so `StateStore` gained `getLastScanAt(profileId, driveId): Promise<string | undefined>`. The Table implementation below carries it, and the conformance suite pins it, so this implementation cannot pass while discarding the value.

- [ ] **Step 1: Install the dependency**

```bash
npm install @azure/data-tables
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/store/fake-table-client.ts
import type { TableClientLike, TableEntityLike } from "../../src/store/table.js";

/**
 * Lives in its own module rather than in a test file. A helper exported from a
 * `.test.ts` re-registers that file's suites in every file that imports it, so
 * the conformance suite would run twice under the errors file's name.
 */
export class FakeTableClient implements TableClientLike {
  readonly rows = new Map<string, TableEntityLike>();
  transactions = 0;
  individualDeletes = 0;

  async createTable(): Promise<void> {}

  async getEntity(partitionKey: string, rowKey: string): Promise<TableEntityLike> {
    const entity = this.rows.get(`${partitionKey}/${rowKey}`);
    if (entity === undefined) {
      const error: Error & { statusCode?: number } = new Error("not found");
      error.statusCode = 404;
      throw error;
    }
    return entity;
  }

  async upsertEntity(entity: TableEntityLike): Promise<void> {
    this.rows.set(`${entity.partitionKey}/${entity.rowKey}`, entity);
  }

  async deleteEntity(partitionKey: string, rowKey: string): Promise<void> {
    this.individualDeletes += 1;
    if (!this.rows.delete(`${partitionKey}/${rowKey}`)) {
      const error: Error & { statusCode?: number } = new Error("not found");
      error.statusCode = 404;
      throw error;
    }
  }

  async *listEntities(options?: { queryOptions?: { filter?: string } }): AsyncIterable<TableEntityLike> {
    const match = /PartitionKey eq '(.*)'/.exec(options?.queryOptions?.filter ?? "");
    for (const entity of this.rows.values()) {
      if (match === null || entity.partitionKey === match[1]) yield entity;
    }
  }

  async submitTransaction(actions: Array<["upsert", TableEntityLike, "Replace"] | ["delete", TableEntityLike]>): Promise<void> {
    this.transactions += 1;
    if (actions.length > 100) throw new Error("a transaction may not exceed 100 entities");
    for (const action of actions) {
      if (action[0] === "upsert") {
        await this.upsertEntity(action[1]);
      } else {
        // Removed from the map directly rather than through deleteEntity, so that
        // clearInventory's transactional deletes do not inflate the individual-delete
        // count the write-shape test asserts on.
        this.rows.delete(`${action[1].partitionKey}/${action[1].rowKey}`);
      }
    }
  }
}
```

```ts
// tests/store/table.test.ts
import { describe, expect, it } from "vitest";
import { createTableStateStore } from "../../src/store/table.js";
import { FakeTableClient } from "./fake-table-client.js";
import { stateStoreConformance } from "./conformance.js";

describe("Azure Table state store", () => {
  stateStoreConformance(() => createTableStateStore({ deltaLinks: new FakeTableClient(), inventory: new FakeTableClient() }));
});

describe("Azure Table state store write shape", () => {
  it("chunks upserts into transactions of at most 100 and issues deletes individually", async () => {
    const inventory = new FakeTableClient();
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory });

    await store.applyInventoryChanges("example", "d1", [
      ...Array.from({ length: 150 }, (_, index) => ({
        kind: "upsert" as const,
        record: {
          itemId: `item-${index}`,
          path: `2026/a-${index}.xlsx`,
          name: `a-${index}.xlsx`,
          isFolder: false,
          size: 1,
          modified: "2026-09-01T00:00:00Z",
          etag: "e",
        },
      })),
      { kind: "delete" as const, itemId: "item-0" },
    ]);

    expect(inventory.transactions).toBe(2);
    expect(inventory.individualDeletes).toBe(1);
  });

  it("stores the raw item id alongside the encoded row key so it reads back without decoding", async () => {
    const inventory = new FakeTableClient();
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory });

    await store.applyInventoryChanges("example", "d1", [
      {
        kind: "upsert",
        record: {
          itemId: "has/slash",
          path: "a.xlsx",
          name: "a.xlsx",
          isFolder: false,
          size: 1,
          modified: "2026-09-01T00:00:00Z",
          etag: "e",
        },
      },
    ]);

    const [stored] = [...inventory.rows.values()];
    expect(stored?.rowKey).not.toContain("/");
    expect(stored?.itemId).toBe("has/slash");
    await expect(store.listInventory("example", "d1")).resolves.toMatchObject([{ itemId: "has/slash" }]);
  });
});
```

```ts
// tests/store/table.errors.test.ts
import { describe, expect, it } from "vitest";
import { createTableStateStore } from "../../src/store/table.js";
import { FakeTableClient } from "./fake-table-client.js";

describe("Azure Table state store failures", () => {
  it("lets a failed transaction surface rather than reporting a write that did not happen", async () => {
    const inventory = new FakeTableClient();
    inventory.submitTransaction = async () => {
      throw new Error("the service is unavailable");
    };
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory });

    await expect(
      store.applyInventoryChanges("example", "d1", [
        {
          kind: "upsert",
          record: { itemId: "i", path: "a.xlsx", name: "a.xlsx", isFolder: false, size: 1, modified: "m", etag: "e" },
        },
      ]),
    ).rejects.toThrow(/unavailable/);
  });

  it("tolerates a 404 on delete but not another failure", async () => {
    const inventory = new FakeTableClient();
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory });

    await expect(
      store.applyInventoryChanges("example", "d1", [{ kind: "delete", itemId: "absent" }]),
    ).resolves.toMatchObject({ changesApplied: 1 });

    inventory.deleteEntity = async () => {
      const error: Error & { statusCode?: number } = new Error("forbidden");
      error.statusCode = 403;
      throw error;
    };

    await expect(
      store.applyInventoryChanges("example", "d1", [{ kind: "delete", itemId: "absent" }]),
    ).rejects.toThrow(/forbidden/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/store/table.test.ts tests/store/table.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/store/table.js`.

- [ ] **Step 4: Implement**

```ts
// src/store/table.ts
import { TableClient } from "@azure/data-tables";
import { chunk, decodeRowKey, encodeRowKey, inventoryPartitionKey, MAX_TRANSACTION_SIZE } from "./keys.js";
import type { ApplyResult, InventoryChange, InventoryRecord, StateStore } from "./types.js";

export interface TableEntityLike {
  partitionKey: string;
  rowKey: string;
  [key: string]: unknown;
}

/**
 * Narrower than `TableClient` on purpose. The transaction chunking and the
 * delete tolerance below are the parts most likely to be wrong, and this is what
 * lets a fake exercise them with no emulator and no storage account.
 */
export interface TableClientLike {
  createTable(): Promise<unknown>;
  getEntity(partitionKey: string, rowKey: string): Promise<TableEntityLike>;
  upsertEntity(entity: TableEntityLike, mode: "Replace"): Promise<unknown>;
  deleteEntity(partitionKey: string, rowKey: string): Promise<unknown>;
  listEntities(options?: { queryOptions?: { filter?: string } }): AsyncIterable<TableEntityLike>;
  submitTransaction(
    actions: Array<["upsert", TableEntityLike, "Replace"] | ["delete", TableEntityLike]>,
  ): Promise<unknown>;
}

export interface TableStateStoreClients {
  deltaLinks: TableClientLike;
  inventory: TableClientLike;
}

function statusCodeOf(error: unknown): number | undefined {
  const code = (error as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : undefined;
}

function toRecord(entity: TableEntityLike): InventoryRecord {
  return {
    itemId: typeof entity.itemId === "string" ? entity.itemId : decodeRowKey(entity.rowKey),
    path: String(entity.path ?? ""),
    name: String(entity.name ?? ""),
    isFolder: entity.isFolder === true,
    size: typeof entity.size === "number" ? entity.size : 0,
    modified: String(entity.modified ?? ""),
    etag: String(entity.etag ?? ""),
  };
}

export function createTableStateStore(clients: TableStateStoreClients): StateStore {
  function inventoryEntity(partitionKey: string, record: InventoryRecord): TableEntityLike {
    return {
      partitionKey,
      rowKey: encodeRowKey(record.itemId),
      // The raw id is a property as well as the source of the row key, so a
      // reader does not have to know the encoding to use the table.
      itemId: record.itemId,
      path: record.path,
      name: record.name,
      isFolder: record.isFolder,
      size: record.size,
      modified: record.modified,
      etag: record.etag,
    };
  }

  return {
    async getDeltaLink(profileId, driveId) {
      try {
        const entity = await clients.deltaLinks.getEntity(profileId, encodeRowKey(driveId));
        return typeof entity.deltaLink === "string" ? entity.deltaLink : undefined;
      } catch (error) {
        if (statusCodeOf(error) === 404) return undefined;
        throw error;
      }
    },

    async setDeltaLink(profileId, driveId, deltaLink, lastScanAt) {
      await clients.deltaLinks.upsertEntity(
        { partitionKey: profileId, rowKey: encodeRowKey(driveId), driveId, deltaLink, lastScanAt },
        "Replace",
      );
    },

    async getLastScanAt(profileId, driveId) {
      try {
        const entity = await clients.deltaLinks.getEntity(profileId, encodeRowKey(driveId));
        return typeof entity.lastScanAt === "string" ? entity.lastScanAt : undefined;
      } catch (error) {
        if (statusCodeOf(error) === 404) return undefined;
        throw error;
      }
    },

    async clearInventory(profileId, driveId) {
      const partitionKey = inventoryPartitionKey(profileId, driveId);
      const rowKeys: string[] = [];
      for await (const entity of clients.inventory.listEntities({
        queryOptions: { filter: `PartitionKey eq '${partitionKey}'` },
      })) {
        rowKeys.push(entity.rowKey);
      }

      for (const group of chunk(rowKeys, MAX_TRANSACTION_SIZE)) {
        await clients.inventory.submitTransaction(
          group.map((rowKey) => ["delete", { partitionKey, rowKey }] as const),
        );
      }
    },

    async applyInventoryChanges(profileId, driveId, changes): Promise<ApplyResult> {
      const partitionKey = inventoryPartitionKey(profileId, driveId);
      const upserts: InventoryChange[] = changes.filter((change) => change.kind === "upsert");
      const deletes = changes.filter((change) => change.kind === "delete");
      let batches = 0;

      for (const group of chunk(upserts, MAX_TRANSACTION_SIZE)) {
        await clients.inventory.submitTransaction(
          group.map((change) => [
            "upsert",
            inventoryEntity(partitionKey, (change as Extract<InventoryChange, { kind: "upsert" }>).record),
            "Replace",
          ] as const),
        );
        batches += 1;
      }

      // Deletes are issued one at a time rather than batched with the upserts.
      // A transaction containing a delete of a row that is not there fails as a
      // whole, and the scan must tolerate exactly that case: the first
      // incremental pass after a resync legitimately sees deletes for items the
      // store never recorded.
      for (const change of deletes) {
        try {
          await clients.inventory.deleteEntity(
            partitionKey,
            encodeRowKey((change as Extract<InventoryChange, { kind: "delete" }>).itemId),
          );
        } catch (error) {
          if (statusCodeOf(error) !== 404) throw error;
        }
        batches += 1;
      }

      return { changesApplied: changes.length, batches };
    },

    async listInventory(profileId, driveId) {
      const partitionKey = inventoryPartitionKey(profileId, driveId);
      const records: InventoryRecord[] = [];
      for await (const entity of clients.inventory.listEntities({
        queryOptions: { filter: `PartitionKey eq '${partitionKey}'` },
      })) {
        records.push(toRecord(entity));
      }
      return records;
    },
  };
}

/**
 * Tables are created on first use rather than by a separate provisioning step,
 * because one-instance-per-tenant means this runs against a fresh storage
 * account often enough that a missing-table failure would be the common first
 * experience.
 */
export async function ensureTables(clients: TableStateStoreClients): Promise<void> {
  for (const client of [clients.deltaLinks, clients.inventory]) {
    try {
      await client.createTable();
    } catch (error) {
      // 409 is "already there", which is the normal case on every run after the
      // first and is not worth distinguishing from success.
      if (statusCodeOf(error) !== 409) throw error;
    }
  }
}

/**
 * Returns the clients alongside the store so the entry point can call
 * `ensureTables` on the same pair rather than constructing a second one and
 * creating tables a different store would then not use.
 */
export function tableStateStoreFromConnectionString(
  connectionString: string,
): { store: StateStore; clients: TableStateStoreClients } {
  const clients: TableStateStoreClients = {
    deltaLinks: TableClient.fromConnectionString(connectionString, "DeltaLinks") as unknown as TableClientLike,
    inventory: TableClient.fromConnectionString(connectionString, "Inventory") as unknown as TableClientLike,
  };
  return { store: createTableStateStore(clients), clients };
}
```

- [ ] **Step 5: Confirm the fake satisfies the interface**

`FakeTableClient` in `tests/store/fake-table-client.ts` must still structurally satisfy `TableClientLike` after any signature change above. TypeScript will say so at `npm run typecheck`; do not loosen the interface to make it fit.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/store/`
Expected: PASS, including the conformance suite now running twice.

- [ ] **Step 7: Commit**

```bash
git add src/store/table.ts tests/store/table.test.ts tests/store/table.errors.test.ts package.json package-lock.json
git commit -m "feat: add the Azure Table state store"
```

---

### Task 11: Delta items to inventory changes, and inventory to a snapshot

**Files:**
- Create: `src/scan/changes.ts`, `src/scan/snapshot.ts`
- Test: `tests/scan/changes.test.ts`, `tests/scan/changes.errors.test.ts`, `tests/scan/snapshot.test.ts`

**Interfaces:**
- Consumes: `DeltaItem` (Task 8), `libraryRelativePath` and `ParentPathError` (Task 6), `InventoryChange` and `InventoryRecord` (Task 9), `RepositorySnapshot` and `RepositoryFile` from `src/domain/reconcile/index.js`.
- Produces:
  ```ts
  // src/scan/changes.ts
  export class DeltaItemError extends Error { readonly itemId: string }
  export function changesFromDeltaItems(items: readonly DeltaItem[]): InventoryChange[];

  // src/scan/snapshot.ts
  export function assembleSnapshot(
    records: readonly InventoryRecord[],
    scannedAt: string,
    subPath?: string,
  ): RepositorySnapshot;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scan/changes.test.ts
import { describe, expect, it } from "vitest";
import { changesFromDeltaItems } from "../../src/scan/changes.js";

const PARENT = { path: "/drives/d1/root:/2026/CLIENTA" };

describe("changesFromDeltaItems", () => {
  it("turns a file into an upsert carrying its library-relative path and ETag", () => {
    expect(
      changesFromDeltaItems([
        {
          id: "i1",
          name: "report.xlsx",
          size: 2048,
          lastModifiedDateTime: "2026-09-01T10:00:00Z",
          eTag: "\"{GUID},3\"",
          parentReference: PARENT,
          file: {},
        },
      ]),
    ).toEqual([
      {
        kind: "upsert",
        record: {
          itemId: "i1",
          path: "2026/CLIENTA/report.xlsx",
          name: "report.xlsx",
          isFolder: false,
          size: 2048,
          modified: "2026-09-01T10:00:00Z",
          etag: "\"{GUID},3\"",
        },
      },
    ]);
  });

  it("marks a folder and gives it size zero", () => {
    const [change] = changesFromDeltaItems([
      { id: "i2", name: "CLIENTB", parentReference: { path: "/drives/d1/root:/2026" }, folder: {} },
    ]);
    expect(change).toMatchObject({ kind: "upsert", record: { isFolder: true, size: 0, path: "2026/CLIENTB" } });
  });

  it("turns a deleted item into a delete carrying only its id", () => {
    expect(changesFromDeltaItems([{ id: "i3", deleted: { state: "deleted" } }])).toEqual([
      { kind: "delete", itemId: "i3" },
    ]);
  });

  it("skips the drive root, which every delta response repeats", () => {
    expect(changesFromDeltaItems([{ id: "root-1", name: "root", root: {}, folder: {} }])).toEqual([]);
  });

  it("preserves order, because a later page entry supersedes an earlier one", () => {
    const changes = changesFromDeltaItems([
      { id: "i1", name: "a.xlsx", parentReference: PARENT, file: {} },
      { id: "i1", deleted: { state: "deleted" } },
    ]);
    expect(changes.map((change) => change.kind)).toEqual(["upsert", "delete"]);
  });
});
```

```ts
// tests/scan/changes.errors.test.ts
import { describe, expect, it } from "vitest";
import { changesFromDeltaItems, DeltaItemError } from "../../src/scan/changes.js";

describe("changesFromDeltaItems failures", () => {
  it("refuses an item with no parentReference.path, naming the item id", () => {
    expect(() => changesFromDeltaItems([{ id: "i9", name: "a.xlsx", file: {} }])).toThrow(DeltaItemError);
    expect(() => changesFromDeltaItems([{ id: "i9", name: "a.xlsx", file: {} }])).toThrow(/i9/);
  });

  it("refuses an item with no id, since the inventory is keyed by it", () => {
    expect(() =>
      changesFromDeltaItems([{ name: "a.xlsx", parentReference: { path: "/drives/d1/root:" }, file: {} }]),
    ).toThrow(/no id/i);
  });

  it("refuses an item with no name rather than storing a path ending in undefined", () => {
    expect(() =>
      changesFromDeltaItems([{ id: "i9", parentReference: { path: "/drives/d1/root:" }, file: {} }]),
    ).toThrow(/no name/i);
  });
});
```

```ts
// tests/scan/snapshot.test.ts
import { describe, expect, it } from "vitest";
import { assembleSnapshot } from "../../src/scan/snapshot.js";
import type { InventoryRecord } from "../../src/store/types.js";

function record(overrides: Partial<InventoryRecord>): InventoryRecord {
  return {
    itemId: "i",
    path: "a.xlsx",
    name: "a.xlsx",
    isFolder: false,
    size: 1,
    modified: "2026-09-01T00:00:00Z",
    etag: "e",
    ...overrides,
  };
}

describe("assembleSnapshot", () => {
  it("splits files from folders and sorts both, so two runs over one library are byte-identical", () => {
    const snapshot = assembleSnapshot(
      [
        record({ itemId: "2", path: "2026/b.xlsx", name: "b.xlsx" }),
        record({ itemId: "1", path: "2026/a.xlsx", name: "a.xlsx" }),
        record({ itemId: "3", path: "2026", name: "2026", isFolder: true, size: 0 }),
      ],
      "2026-09-13T12:00:00Z",
    );

    expect(snapshot.files.map((file) => file.path)).toEqual(["2026/a.xlsx", "2026/b.xlsx"]);
    expect(snapshot.folderPaths).toEqual(["2026"]);
    expect(snapshot.scannedAt).toBe("2026-09-13T12:00:00Z");
  });

  it("always reports the Search cross-check as absent, because phase 2a does not run one", () => {
    expect(assembleSnapshot([], "2026-09-13T12:00:00Z").searchCrossCheckIncluded).toBe(false);
  });

  it("filters to a sub-path on a segment boundary, not a string prefix", () => {
    const snapshot = assembleSnapshot(
      [
        record({ itemId: "1", path: "2026/CLIENTA/a.xlsx" }),
        record({ itemId: "2", path: "2026/CLIENTAB/b.xlsx" }),
        record({ itemId: "3", path: "2026/CLIENTA", isFolder: true }),
      ],
      "2026-09-13T12:00:00Z",
      "2026/CLIENTA",
    );

    expect(snapshot.files.map((file) => file.path)).toEqual(["2026/CLIENTA/a.xlsx"]);
    expect(snapshot.folderPaths).toEqual(["2026/CLIENTA"]);
  });

  it("carries size, modified date and ETag onto each file", () => {
    const [file] = assembleSnapshot(
      [record({ path: "a.xlsx", size: 99, modified: "2026-08-01T00:00:00Z", etag: "etag-9" })],
      "2026-09-13T12:00:00Z",
    ).files;

    expect(file).toEqual({ path: "a.xlsx", name: "a.xlsx", size: 99, modified: "2026-08-01T00:00:00Z", etag: "etag-9" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scan/`
Expected: FAIL, cannot resolve `../../src/scan/changes.js`.

- [ ] **Step 3: Implement `changes.ts`**

```ts
// src/scan/changes.ts
import type { DeltaItem } from "../graph/delta.js";
import { libraryRelativePath } from "../graph/paths.js";
import type { InventoryChange } from "../store/types.js";

/**
 * An item that cannot be turned into an inventory record is refused rather than
 * skipped. A skipped file becomes a file the reconciliation engine reports as
 * missing, which sends someone to produce a report that already exists; losing
 * an item has to be louder than losing a scan.
 */
export class DeltaItemError extends Error {
  readonly itemId: string;

  constructor(itemId: string, reason: string) {
    super(`A delta item could not be recorded: ${reason}. Item id: ${itemId}.`);
    this.name = "DeltaItemError";
    this.itemId = itemId;
  }
}

export function changesFromDeltaItems(items: readonly DeltaItem[]): InventoryChange[] {
  const changes: InventoryChange[] = [];

  for (const item of items) {
    // The drive root arrives in every delta response, including incremental
    // ones, and it is not a member of the library's contents.
    if (item.root !== undefined) continue;

    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new DeltaItemError("(absent)", "the item carried no id, and the inventory is keyed by it");
    }

    if (item.deleted !== undefined) {
      changes.push({ kind: "delete", itemId: item.id });
      continue;
    }

    if (typeof item.name !== "string" || item.name.length === 0) {
      throw new DeltaItemError(item.id, "the item carried no name");
    }

    const parentPath = item.parentReference?.path;
    if (typeof parentPath !== "string") {
      throw new DeltaItemError(item.id, "the item carried no parentReference.path, so its path cannot be derived");
    }

    const isFolder = item.folder !== undefined;
    changes.push({
      kind: "upsert",
      record: {
        itemId: item.id,
        path: libraryRelativePath(parentPath, item.name),
        name: item.name,
        isFolder,
        // A folder's size is the recursive total of its contents, which is not
        // what any consumer of this inventory means by size.
        size: isFolder ? 0 : (item.size ?? 0),
        modified: item.lastModifiedDateTime ?? "",
        etag: item.eTag ?? "",
      },
    });
  }

  return changes;
}
```

- [ ] **Step 4: Implement `snapshot.ts`**

```ts
// src/scan/snapshot.ts
import type { RepositoryFile, RepositorySnapshot } from "../domain/reconcile/index.js";
import type { InventoryRecord } from "../store/types.js";

/**
 * Ordinary code-unit comparison rather than `localeCompare`, matching the
 * reconciliation engine: sort order is part of what gets diffed between runs and
 * `localeCompare` varies with the host's ICU data.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A segment-boundary test rather than a string prefix. `startsWith("2026/CLIENTA")`
 * also matches `2026/CLIENTAB`, which would silently fold one client's files into
 * another client's scan.
 */
function withinSubPath(path: string, subPath: string): boolean {
  return path === subPath || path.startsWith(`${subPath}/`);
}

export function assembleSnapshot(
  records: readonly InventoryRecord[],
  scannedAt: string,
  subPath?: string,
): RepositorySnapshot {
  const scoped =
    subPath === undefined || subPath.length === 0
      ? [...records]
      : records.filter((record) => withinSubPath(record.path, subPath));

  const files: RepositoryFile[] = scoped
    .filter((record) => !record.isFolder)
    .map((record) => ({
      path: record.path,
      name: record.name,
      size: record.size,
      modified: record.modified,
      etag: record.etag,
    }))
    .sort((a, b) => compareStrings(a.path, b.path));

  const folderPaths = scoped
    .filter((record) => record.isFolder)
    .map((record) => record.path)
    .sort(compareStrings);

  return {
    files,
    folderPaths,
    scannedAt,
    // Phase 2a runs no Microsoft Search cross-check, so every snapshot it
    // produces is a degraded scan by the engine's own definition and says so.
    searchCrossCheckIncluded: false,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/scan/`
Expected: PASS.

- [ ] **Step 6: Confirm the lint boundary still holds**

Run: `npm run lint`
Expected: PASS. `src/scan/snapshot.ts` imports from `domain/reconcile/index.js`, which the entry-point rule allows; importing `domain/reconcile/types.js` directly would fail, and that failure is correct.

- [ ] **Step 7: Commit**

```bash
git add src/scan/changes.ts src/scan/snapshot.ts tests/scan
git commit -m "feat: convert delta items to inventory changes and inventory to a snapshot"
```

---

### Task 12: The scan itself

**Files:**
- Create: `src/scan/run.ts`
- Test: `tests/scan/run.test.ts`, `tests/scan/run.errors.test.ts`

**Interfaces:**
- Consumes: everything above, plus `Profile` from `src/domain/profile/schema.js`.
- Produces:
  ```ts
  export interface ScanDependencies {
    client: GraphClient;
    store: StateStore;
    profile: Profile;
    now: () => Date;
    subPath?: string;
  }
  export interface ScanResult {
    snapshot: RepositorySnapshot;
    driveId: string;
    mode: "full" | "incremental";
    resynced: boolean;
    pages: number;
    changesApplied: number;
    graphRequests: number;
    storeBatches: number;
  }
  export async function runScan(dependencies: ScanDependencies): Promise<ScanResult>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scan/run.test.ts
import { describe, expect, it } from "vitest";
import { runScan } from "../../src/scan/run.js";
import { createMemoryStateStore } from "../../src/store/memory.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import type { GraphClient } from "../../src/graph/client.js";
import exampleProfile from "../../examples/profiles/example.json" with { type: "json" };

const PROFILE = loadProfile(exampleProfile);
const NOW = () => new Date("2026-09-13T12:00:00Z");

function scriptedClient(responses: Record<string, unknown>): GraphClient {
  let requests = 0;
  return {
    requests: () => requests,
    get: async <T,>(path: string): Promise<T> => {
      requests += 1;
      if (!(path in responses)) throw new Error(`unexpected path ${path}`);
      return responses[path] as T;
    },
  };
}

const SITE = "/sites/contoso.sharepoint.com:/sites/Example";
const DRIVES = "/sites/site-1/drives?$select=id,name";

function baseResponses(delta: unknown): Record<string, unknown> {
  return {
    [SITE]: { id: "site-1" },
    [DRIVES]: { value: [{ id: "drive-1", name: "Compliance Reports" }] },
    "/drives/drive-1/root/delta": delta,
  };
}

describe("runScan", () => {
  it("enumerates a cold store in full and stores the deltaLink", async () => {
    const store = createMemoryStateStore();
    const client = scriptedClient(
      baseResponses({
        value: [
          { id: "r", root: {}, name: "root", folder: {} },
          { id: "f1", name: "2026", parentReference: { path: "/drives/drive-1/root:" }, folder: {} },
          {
            id: "i1",
            name: "2026-08_CLIENTA_MonthlyTraining.xlsx",
            parentReference: { path: "/drives/drive-1/root:/2026" },
            file: {},
            size: 10,
            lastModifiedDateTime: "2026-08-31T00:00:00Z",
            eTag: "e1",
          },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/next-link",
      }),
    );

    const result = await runScan({ client, store, profile: PROFILE, now: NOW });

    expect(result.mode).toBe("full");
    expect(result.resynced).toBe(false);
    expect(result.snapshot.files.map((file) => file.path)).toEqual(["2026/2026-08_CLIENTA_MonthlyTraining.xlsx"]);
    expect(result.snapshot.folderPaths).toEqual(["2026"]);
    expect(result.snapshot.scannedAt).toBe("2026-09-13T12:00:00.000Z");
    await expect(store.getDeltaLink("example", "drive-1")).resolves.toBe("https://graph.microsoft.com/v1.0/next-link");
  });

  it("runs incrementally from a stored link and keeps items it did not see again", async () => {
    const store = createMemoryStateStore();
    await store.setDeltaLink("example", "drive-1", "https://graph.microsoft.com/v1.0/stored", "2026-09-12T00:00:00Z");
    await store.applyInventoryChanges("example", "drive-1", [
      {
        kind: "upsert",
        record: {
          itemId: "i1",
          path: "2026/old.xlsx",
          name: "old.xlsx",
          isFolder: false,
          size: 1,
          modified: "2026-08-01T00:00:00Z",
          etag: "e",
        },
      },
    ]);

    const client = scriptedClient({
      [SITE]: { id: "site-1" },
      [DRIVES]: { value: [{ id: "drive-1", name: "Compliance Reports" }] },
      "https://graph.microsoft.com/v1.0/stored": {
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/newer",
      },
    });

    const result = await runScan({ client, store, profile: PROFILE, now: NOW });

    expect(result.mode).toBe("incremental");
    expect(result.snapshot.files.map((file) => file.path)).toEqual(["2026/old.xlsx"]);
    expect(result.graphRequests).toBe(3);
  });
});
```

```ts
// tests/scan/run.errors.test.ts
import { describe, expect, it } from "vitest";
import { runScan } from "../../src/scan/run.js";
import { createMemoryStateStore } from "../../src/store/memory.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import type { GraphClient } from "../../src/graph/client.js";
import exampleProfile from "../../examples/profiles/example.json" with { type: "json" };

const PROFILE = loadProfile(exampleProfile);
const NOW = () => new Date("2026-09-13T12:00:00Z");
const SITE = "/sites/contoso.sharepoint.com:/sites/Example";
const DRIVES = "/sites/site-1/drives?$select=id,name";

describe("runScan when the stored deltaLink is rejected", () => {
  it("clears the inventory, re-enumerates, and reports that it resynced", async () => {
    const store = createMemoryStateStore();
    await store.setDeltaLink("example", "drive-1", "https://graph.microsoft.com/v1.0/stale", "2026-09-12T00:00:00Z");
    await store.applyInventoryChanges("example", "drive-1", [
      {
        kind: "upsert",
        record: {
          itemId: "ghost",
          path: "2026/deleted-while-we-were-away.xlsx",
          name: "deleted-while-we-were-away.xlsx",
          isFolder: false,
          size: 1,
          modified: "2026-08-01T00:00:00Z",
          etag: "e",
        },
      },
    ]);

    let requests = 0;
    const client: GraphClient = {
      requests: () => requests,
      get: async <T,>(path: string): Promise<T> => {
        requests += 1;
        if (path === SITE) return { id: "site-1" } as T;
        if (path === DRIVES) return { value: [{ id: "drive-1", name: "Compliance Reports" }] } as T;
        if (path === "https://graph.microsoft.com/v1.0/stale") {
          throw new GraphRequestError({
            method: "GET",
            path,
            status: 410,
            body: JSON.stringify({ error: { code: "resyncRequired", message: "gone" } }),
          });
        }
        return {
          value: [
            {
              id: "i1",
              name: "fresh.xlsx",
              parentReference: { path: "/drives/drive-1/root:/2026" },
              file: {},
              size: 1,
              lastModifiedDateTime: "2026-09-01T00:00:00Z",
              eTag: "e",
            },
          ],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/after-resync",
        } as T;
      },
    };

    const result = await runScan({ client, store, profile: PROFILE, now: NOW });

    expect(result.resynced).toBe(true);
    expect(result.mode).toBe("full");
    expect(result.snapshot.files.map((file) => file.path)).toEqual(["2026/fresh.xlsx"]);
  });
});

describe("runScan when a page fails partway", () => {
  it("leaves the previous deltaLink in place, so the next run re-reads rather than skipping", async () => {
    const store = createMemoryStateStore();
    await store.setDeltaLink("example", "drive-1", "https://graph.microsoft.com/v1.0/stored", "2026-09-12T00:00:00Z");

    const client: GraphClient = {
      requests: () => 3,
      get: async <T,>(path: string): Promise<T> => {
        if (path === SITE) return { id: "site-1" } as T;
        if (path === DRIVES) return { value: [{ id: "drive-1", name: "Compliance Reports" }] } as T;
        if (path === "https://graph.microsoft.com/v1.0/stored") {
          return { value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/page-2" } as T;
        }
        throw new GraphRequestError({ method: "GET", path, status: 503, body: "unavailable" });
      },
    };

    await expect(runScan({ client, store, profile: PROFILE, now: NOW })).rejects.toThrow(GraphRequestError);
    await expect(store.getDeltaLink("example", "drive-1")).resolves.toBe("https://graph.microsoft.com/v1.0/stored");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scan/run.test.ts tests/scan/run.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/scan/run.js`.

- [ ] **Step 3: Implement**

```ts
// src/scan/run.ts
import type { GraphClient } from "../graph/client.js";
import { DeltaResyncRequiredError, deltaPages } from "../graph/delta.js";
import { resolveDrive } from "../graph/drive.js";
import type { Profile } from "../domain/profile/schema.js";
import type { RepositorySnapshot } from "../domain/reconcile/index.js";
import type { StateStore } from "../store/types.js";
import { changesFromDeltaItems } from "./changes.js";
import { assembleSnapshot } from "./snapshot.js";

export interface ScanDependencies {
  client: GraphClient;
  store: StateStore;
  profile: Profile;
  now: () => Date;
  subPath?: string;
}

export interface ScanResult {
  snapshot: RepositorySnapshot;
  driveId: string;
  mode: "full" | "incremental";
  resynced: boolean;
  pages: number;
  changesApplied: number;
  graphRequests: number;
  storeBatches: number;
}

interface EnumerationResult {
  pages: number;
  changesApplied: number;
  storeBatches: number;
  deltaLink: string;
}

export async function runScan(dependencies: ScanDependencies): Promise<ScanResult> {
  const { client, store, profile, now } = dependencies;
  const { driveId } = await resolveDrive(client, profile.identity.siteUrl, profile.identity.library);

  const storedLink = await store.getDeltaLink(profile.profileId, driveId);

  async function enumerate(fromLink: string | undefined): Promise<EnumerationResult> {
    let pages = 0;
    let changesApplied = 0;
    let storeBatches = 0;
    let deltaLink: string | undefined;

    for await (const page of deltaPages(client, driveId, fromLink)) {
      pages += 1;
      const changes = changesFromDeltaItems(page.items);
      const applied = await store.applyInventoryChanges(profile.profileId, driveId, changes);
      changesApplied += applied.changesApplied;
      storeBatches += applied.batches;
      if (page.deltaLink !== undefined) deltaLink = page.deltaLink;
    }

    if (deltaLink === undefined) {
      // deltaPages only returns after yielding a page carrying the final link,
      // so reaching here means the generator's own contract was broken and
      // continuing would persist an inventory with no way to resume from it.
      throw new Error(`The delta enumeration of drive ${driveId} finished without a deltaLink.`);
    }

    return { pages, changesApplied, storeBatches, deltaLink };
  }

  let mode: "full" | "incremental" = storedLink === undefined ? "full" : "incremental";
  let resynced = false;
  let enumeration: EnumerationResult;

  try {
    enumeration = await enumerate(storedLink);
  } catch (error) {
    if (!(error instanceof DeltaResyncRequiredError)) throw error;
    // The stored inventory is now unreliable in a way no incremental pass can
    // repair: the changes that would have removed its stale rows are exactly the
    // ones that aged out of the change log.
    await store.clearInventory(profile.profileId, driveId);
    resynced = true;
    mode = "full";
    enumeration = await enumerate(undefined);
  }

  // Persisted last. An interrupted scan then resumes by re-reading pages it has
  // already applied, which is wasteful and correct, rather than by skipping
  // changes it never applied, which is cheap and silently wrong.
  const scannedAt = now().toISOString();
  await store.setDeltaLink(profile.profileId, driveId, enumeration.deltaLink, scannedAt);

  const records = await store.listInventory(profile.profileId, driveId);

  return {
    snapshot: assembleSnapshot(records, scannedAt, dependencies.subPath),
    driveId,
    mode,
    resynced,
    pages: enumeration.pages,
    changesApplied: enumeration.changesApplied,
    graphRequests: client.requests(),
    storeBatches: enumeration.storeBatches,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/scan/`
Expected: PASS. The JSON import in the tests needs `resolveJsonModule`; if `npm run typecheck` complains, add `"resolveJsonModule": true` to `tsconfig.json`'s compiler options rather than inlining a copy of the example profile.

- [ ] **Step 5: Run the whole suite**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scan/run.ts tests/scan/run.test.ts tests/scan/run.errors.test.ts tsconfig.json
git commit -m "feat: add the scan, with resync handling and a deltaLink written last"
```

---

### Task 13: Configuration, the CLI, and its output

**Files:**
- Create: `src/config.ts`, `src/scan/cli.ts`, `src/scan/main.ts`
- Test: `tests/config.test.ts`, `tests/config.errors.test.ts`, `tests/scan/cli.test.ts`, `tests/scan/cli.errors.test.ts`
- Modify: `package.json` (add the `scan` script), `docs/SETUP.md` (document the command and its environment)

**Interfaces:**
- Consumes: `ScanResult` (Task 12), `ClientCredentials` (Task 4).
- Produces:
  ```ts
  // src/config.ts
  export interface GraphCredentialsConfig { tenantId: string; clientId: string; clientSecret: string }
  export function loadGraphCredentials(env: NodeJS.ProcessEnv): GraphCredentialsConfig;
  export function loadStoreConnectionString(env: NodeJS.ProcessEnv): string | undefined;

  // src/scan/cli.ts
  export interface ScanArguments { profilePath: string; subPath?: string }
  export function parseScanArguments(argv: readonly string[]): ScanArguments;
  export function formatScanResult(result: ScanResult, storeKind: "azure-table" | "in-memory"): string[];
  ```

- [ ] **Step 1: Write the failing config tests**

```ts
// tests/config.test.ts
import { describe, expect, it } from "vitest";
import { loadGraphCredentials, loadStoreConnectionString } from "../src/config.js";

const ENV = {
  IW_TENANT_ID: "tenant-1",
  IW_CLIENT_ID: "client-1",
  IW_CLIENT_SECRET: "secret-1",
};

describe("loadGraphCredentials", () => {
  it("reads all three values", () => {
    expect(loadGraphCredentials(ENV)).toEqual({ tenantId: "tenant-1", clientId: "client-1", clientSecret: "secret-1" });
  });
});

describe("loadStoreConnectionString", () => {
  it("returns undefined when none is set, which selects the in-memory store", () => {
    expect(loadStoreConnectionString({})).toBeUndefined();
  });

  it("returns the connection string when set", () => {
    expect(loadStoreConnectionString({ IW_TABLE_CONNECTION_STRING: "UseDevelopmentStorage=true" })).toBe(
      "UseDevelopmentStorage=true",
    );
  });
});
```

```ts
// tests/config.errors.test.ts
import { describe, expect, it } from "vitest";
import { loadGraphCredentials } from "../src/config.js";

describe("loadGraphCredentials failures", () => {
  it("names every missing variable at once rather than one per run", () => {
    expect(() => loadGraphCredentials({ IW_TENANT_ID: "tenant-1" })).toThrow(/IW_CLIENT_ID.*IW_CLIENT_SECRET/s);
  });

  it("treats an empty value as absent, since an unset shell variable expands to one", () => {
    expect(() =>
      loadGraphCredentials({ IW_TENANT_ID: "tenant-1", IW_CLIENT_ID: "", IW_CLIENT_SECRET: "secret-1" }),
    ).toThrow(/IW_CLIENT_ID/);
  });

  it("never echoes a value it rejected", () => {
    expect(() => loadGraphCredentials({ IW_CLIENT_SECRET: "secret-1" })).not.toThrow(/secret-1/);
  });
});
```

- [ ] **Step 2: Implement `src/config.ts`**

```ts
// src/config.ts

export interface GraphCredentialsConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Every missing variable is named in one message. Reporting the first one only
 * costs an operator one failed run per variable, and this command is most often
 * run for the first time against a tenant somebody else set up.
 *
 * No rejected value is ever echoed. One of the three is a client secret, and a
 * message an operator pastes into a ticket must not carry it.
 */
export function loadGraphCredentials(env: NodeJS.ProcessEnv): GraphCredentialsConfig {
  const tenantId = env.IW_TENANT_ID;
  const clientId = env.IW_CLIENT_ID;
  const clientSecret = env.IW_CLIENT_SECRET;

  const missing = [
    present(tenantId) ? undefined : "IW_TENANT_ID",
    present(clientId) ? undefined : "IW_CLIENT_ID",
    present(clientSecret) ? undefined : "IW_CLIENT_SECRET",
  ].filter((name): name is string => name !== undefined);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment ${missing.length === 1 ? "variable" : "variables"}: ${missing.join(", ")}. ` +
        "These are the server application's own credentials, produced by npm run setup.",
    );
  }

  return { tenantId: tenantId as string, clientId: clientId as string, clientSecret: clientSecret as string };
}

/**
 * Absent selects the in-memory store rather than failing, so a local run needs
 * no cloud account. The scan's output says which store it used, because an
 * in-memory run cannot demonstrate the incremental path and an operator reading
 * "full scan" twice deserves to know why.
 */
export function loadStoreConnectionString(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.IW_TABLE_CONNECTION_STRING;
  return present(value) ? value : undefined;
}
```

- [ ] **Step 3: Run the config tests**

Run: `npx vitest run tests/config.test.ts tests/config.errors.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing CLI tests**

```ts
// tests/scan/cli.test.ts
import { describe, expect, it } from "vitest";
import { formatScanResult, parseScanArguments } from "../../src/scan/cli.js";
import type { ScanResult } from "../../src/scan/run.js";

function result(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    snapshot: {
      files: [
        { path: "2026/a.xlsx", name: "a.xlsx", size: 1, modified: "2026-09-01T00:00:00Z", etag: "e" },
        { path: "2026/b.xlsx", name: "b.xlsx", size: 1, modified: "2026-09-01T00:00:00Z", etag: "e" },
      ],
      folderPaths: ["2026"],
      scannedAt: "2026-09-13T12:00:00.000Z",
      searchCrossCheckIncluded: false,
    },
    driveId: "drive-1",
    mode: "full",
    resynced: false,
    pages: 2,
    changesApplied: 3,
    graphRequests: 4,
    storeBatches: 1,
    ...overrides,
  };
}

describe("parseScanArguments", () => {
  it("reads the profile path", () => {
    expect(parseScanArguments(["--profile", "profiles/acme.json"])).toEqual({ profilePath: "profiles/acme.json" });
  });

  it("reads an optional sub-path", () => {
    expect(parseScanArguments(["--profile", "p.json", "--sub-path", "2026/CLIENTA"])).toEqual({
      profilePath: "p.json",
      subPath: "2026/CLIENTA",
    });
  });
});

describe("formatScanResult", () => {
  it("reports counts, mode, and the request count the project exists to reduce", () => {
    const lines = formatScanResult(result(), "azure-table");

    expect(lines).toContain("Scan complete: full enumeration of drive drive-1.");
    expect(lines).toContain("Files: 2. Folders: 1.");
    expect(lines).toContain("Graph requests: 4. Delta pages: 2.");
    expect(lines).toContain("Store: azure-table. Changes applied: 3. Write operations: 1.");
  });

  it("says a resync happened and why it cost what it cost", () => {
    const lines = formatScanResult(result({ resynced: true }), "azure-table").join("\n");

    expect(lines).toMatch(/resync/i);
    expect(lines).toMatch(/stored deltaLink was no longer valid/i);
  });

  it("warns that an in-memory run cannot be incremental", () => {
    const lines = formatScanResult(result(), "in-memory").join("\n");

    expect(lines).toMatch(/in-memory/);
    expect(lines).toMatch(/next run will enumerate in full/i);
  });

  it("always states that no Search cross-check ran, since every 2a snapshot is degraded", () => {
    expect(formatScanResult(result(), "azure-table").join("\n")).toMatch(/Search cross-check did not run/i);
  });
});
```

```ts
// tests/scan/cli.errors.test.ts
import { describe, expect, it } from "vitest";
import { parseScanArguments } from "../../src/scan/cli.js";

describe("parseScanArguments failures", () => {
  it("refuses a missing --profile, naming the flag and showing the usage", () => {
    expect(() => parseScanArguments([])).toThrow(/--profile/);
    expect(() => parseScanArguments([])).toThrow(/npm run scan/);
  });

  it("refuses --profile with no value rather than reading the next flag as a path", () => {
    expect(() => parseScanArguments(["--profile", "--sub-path", "2026"])).toThrow(/--profile needs a value/);
  });

  it("refuses an unrecognized flag rather than ignoring a typo", () => {
    expect(() => parseScanArguments(["--profile", "p.json", "--subpath", "2026"])).toThrow(/--subpath/);
  });
});
```

- [ ] **Step 5: Implement `src/scan/cli.ts`**

```ts
// src/scan/cli.ts
import type { ScanResult } from "./run.js";

const USAGE = "Usage: npm run scan -- --profile <path to profile json> [--sub-path <library-relative path>]";

export interface ScanArguments {
  profilePath: string;
  subPath?: string;
}

export function parseScanArguments(argv: readonly string[]): ScanArguments {
  let profilePath: string | undefined;
  let subPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    // A flag's value is read as a value only when it is not itself a flag.
    // Otherwise `--profile --sub-path 2026` silently scans a profile named
    // "--sub-path".
    const value = argv[index + 1];
    const hasValue = value !== undefined && !value.startsWith("--");

    if (flag === "--profile") {
      if (!hasValue) throw new Error(`--profile needs a value. ${USAGE}`);
      profilePath = value;
      index += 1;
    } else if (flag === "--sub-path") {
      if (!hasValue) throw new Error(`--sub-path needs a value. ${USAGE}`);
      subPath = value;
      index += 1;
    } else {
      throw new Error(`Unrecognized argument "${flag}". ${USAGE}`);
    }
  }

  if (profilePath === undefined) throw new Error(`--profile is required. ${USAGE}`);
  return subPath === undefined ? { profilePath } : { profilePath, subPath };
}

/**
 * Every line here is checked against what the scan actually did. `mode` and
 * `resynced` come from the run rather than from what was intended, the counts
 * are the run's own tallies, and the in-memory warning is printed from the store
 * that was actually constructed rather than from the environment that was read.
 */
export function formatScanResult(result: ScanResult, storeKind: "azure-table" | "in-memory"): string[] {
  const lines = [
    `Scan complete: ${result.mode === "full" ? "full enumeration" : "incremental scan"} of drive ${result.driveId}.`,
    `Files: ${result.snapshot.files.length}. Folders: ${result.snapshot.folderPaths.length}.`,
    `Graph requests: ${result.graphRequests}. Delta pages: ${result.pages}.`,
    `Store: ${storeKind}. Changes applied: ${result.changesApplied}. Write operations: ${result.storeBatches}.`,
    `Scanned at: ${result.snapshot.scannedAt}.`,
  ];

  if (result.resynced) {
    lines.push(
      "This run resynced: the stored deltaLink was no longer valid, so the stored inventory was " +
        "discarded and the drive enumerated from scratch. That is why this run cost a full " +
        "enumeration rather than an incremental one.",
    );
  }

  if (storeKind === "in-memory") {
    lines.push(
      "No storage account was configured, so this run used the in-memory store and nothing was " +
        "persisted. The next run will enumerate in full. Set IW_TABLE_CONNECTION_STRING to keep " +
        "the inventory between runs.",
    );
  }

  lines.push(
    "The Microsoft Search cross-check did not run, which phase 2a never does. A correctly named " +
      "file stored outside the expected taxonomy is invisible to this snapshot, so any " +
      "reconciliation run against it is a degraded scan.",
  );

  return lines;
}
```

- [ ] **Step 6: Run the CLI tests**

Run: `npx vitest run tests/scan/cli.test.ts tests/scan/cli.errors.test.ts`
Expected: PASS.

- [ ] **Step 7: Implement `src/scan/main.ts`**

```ts
// src/scan/main.ts
import { readFile } from "node:fs/promises";
import { loadGraphCredentials, loadStoreConnectionString } from "../config.js";
import { loadProfile } from "../domain/profile/load.js";
import { createGraphClient } from "../graph/client.js";
import { clientCredentialsTokenProvider } from "../graph/token.js";
import { createMemoryStateStore } from "../store/memory.js";
import { ensureTables, tableStateStoreFromConnectionString } from "../store/table.js";
import type { StateStore } from "../store/types.js";
import { formatScanResult, parseScanArguments } from "./cli.js";
import { runScan } from "./run.js";

async function main(): Promise<void> {
  const args = parseScanArguments(process.argv.slice(2));
  const profile = loadProfile(JSON.parse(await readFile(args.profilePath, "utf8")));
  const credentials = loadGraphCredentials(process.env);
  const connectionString = loadStoreConnectionString(process.env);

  let store: StateStore;
  let storeKind: "azure-table" | "in-memory";
  if (connectionString === undefined) {
    store = createMemoryStateStore();
    storeKind = "in-memory";
  } else {
    const table = tableStateStoreFromConnectionString(connectionString);
    await ensureTables(table.clients);
    store = table.store;
    storeKind = "azure-table";
  }

  const client = createGraphClient({ tokenProvider: clientCredentialsTokenProvider(credentials) });
  const result = await runScan({
    client,
    store,
    profile,
    now: () => new Date(),
    ...(args.subPath === undefined ? {} : { subPath: args.subPath }),
  });

  for (const line of formatScanResult(result, storeKind)) console.log(line);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

`tableStateStoreFromConnectionString` returns `{ store, clients }` (Task 10), which is what lets `ensureTables` run against the same pair the store will use.

- [ ] **Step 8: Add the script and document it**

In `package.json` scripts, add `"scan": "tsx src/scan/main.ts"`.

In `docs/SETUP.md`, add a section after the setup procedure describing `npm run scan`, the three required environment variables, the optional `IW_TABLE_CONNECTION_STRING`, and how to run Azurite locally (`npx azurite` with `IW_TABLE_CONNECTION_STRING=UseDevelopmentStorage=true`).

- [ ] **Step 9: Audit every message this command can print**

Enumerate every string reachable from `src/scan/main.ts`: the three argument-parsing failures, the profile validation failure, the missing-environment failure, `LibraryNotFoundError`, the site-with-no-id failure, `TokenRequestError`, `DeltaItemError`, `ParentPathError`, `UnsafeKeyError`, the generic `GraphRequestError`, and all five-to-seven lines of `formatScanResult`. For each, name the path that produces it, and confirm that every object it mentions exists at that moment and every action it suggests is possible with what the operator holds then. Fix any that are not, and record the audit in the commit message.

- [ ] **Step 10: Run everything**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/config.ts src/scan/cli.ts src/scan/main.ts tests/config.test.ts tests/config.errors.test.ts tests/scan/cli.test.ts tests/scan/cli.errors.test.ts package.json docs/SETUP.md
git commit -m "feat: add the scan command, its configuration, and its operator output"
```

---

### Task 14: Live verification against the developer tenant

This task needs the operator. It is the evidence for the claim the project was started over, and it is where phase 1 found what its tests did not.

**Split, 2026-09-13.** Steps 1 through 4 need tenant access, a hand-created synthetic library, and
working server-application credentials, none of which the implementing session has or can create;
the server application from the phase 1 setup run is also the one whose secret was exposed and is
awaiting deletion, so it is not available to reuse. Those four steps were not performed and remain
the operator's to run. Step 5 was completed as a record of that: `docs/OPEN-ITEMS.md` now states
plainly that phase 2a is verified only against fakes, names what a fake cannot prove, and gives the
operator the same numbered procedure below to follow and record. The steps stay as written; they
are still the procedure, just not yet executed.

**Files:**
- Modify: `docs/OPEN-ITEMS.md`

**Interfaces:**
- Consumes: the finished command from Task 13.
- Produces: a dated record of what is verified live versus only against fakes.

- [ ] **Step 1: Prepare the tenant**

In the developer tenant used for the phase 1 setup run, create a synthetic document library with a small tree matching the example profile's taxonomy: a year folder, two client folders, and three or four files. Use no real client data. Write a profile JSON for it under `profiles/`, which is git-ignored.

- [ ] **Step 2: Start Azurite and run a cold scan**

```bash
npx azurite --silent &
IW_TABLE_CONNECTION_STRING=UseDevelopmentStorage=true npm run scan -- --profile profiles/dev-tenant.json
```

Record: the mode, the file and folder counts, the Graph request count, and the write-operation count.

- [ ] **Step 3: Run it again immediately**

Expected: mode `incremental`, no resync, the same file and folder counts, and a Graph request count of 3. Record the actual numbers whatever they are.

- [ ] **Step 4: Exercise each change kind**

Add a file, scan. Rename a file, scan. Move a file between client folders, scan. Delete a file, scan. After each, confirm the snapshot reflects the change and no ghost row survives a move. Record anything that did not behave as the design says it should, and fix it in its own commit before continuing.

- [ ] **Step 5: Record the result**

Append a dated section to `docs/OPEN-ITEMS.md` under the live-verification material, stating plainly what executed against the tenant and what remains covered only by fakes. Follow the existing entries' tone: name the numbers, name what was never exercised, and do not describe an untested path as working.

- [ ] **Step 6: Commit**

```bash
git add docs/OPEN-ITEMS.md
git commit -m "docs: record what phase 2a verified against a live tenant"
```

---

## Finishing the branch

After Task 14, use `superpowers:requesting-code-review` for a whole-branch review, then `superpowers:finishing-a-development-branch`. Per the working agreement this is architectural work, so it goes to a feature branch with a PR and no auto-merge.

Before opening the PR, confirm the phase's own claims: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:errors` and `npm run build` all pass, and the PR description names the live-verification numbers from Task 14 rather than asserting the layer works.
