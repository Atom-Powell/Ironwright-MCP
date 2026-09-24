# Token Role Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server never uses a Graph token whose roles claim is anything other than exactly `["Sites.Selected"]`, and a deployment misconfigured that way fails at startup when the sign-in service can be reached.

**Architecture:** The roles reader moves from setup into `src/graph/roles.ts`. A wrapper, `requireExactRoles`, sits around the server's token provider and checks every newly minted token. A testable `checkStartupIdentity` in `src/server/identity.ts` runs once before the port is bound, and `describeToolFailure` gets a message for the new error.

**Tech Stack:** TypeScript, Node, vitest.

## Global Constraints

From `CLAUDE.md` and the spec at `docs/superpowers/specs/2026-09-24-token-role-guard-design.md`:

- **No em dashes and no en dashes anywhere**, including string literals, comments and commit messages. `tests/source-hygiene.test.ts` enforces it.
- **No emojis. US English.**
- **A message states only what the code observed.** The refusal message says the server refused to use the token and made no Graph request with it; it never carries a token or a secret.
- **Unreadable fails closed.** A token whose roles claim cannot be read is refused, never trusted.
- **Only a role mismatch stops startup.** Any other failure to obtain a token at startup logs one warning and continues, exactly as today.
- **Existing tests pass unedited**, including the setup tests that import `appRolesFromAccessToken` through `src/setup/steps.ts`.
- **Test file naming:** happy path in `X.test.ts`, failures in `X.errors.test.ts`.
- **Conventional commits**, each ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Run `npm run lint`, `npm run typecheck` and `npm test` before every commit.

---

## File Structure

**Created:** `src/graph/roles.ts`, `src/server/identity.ts`, `tests/graph/roles.test.ts`, `tests/graph/token-roles.test.ts`, `tests/graph/token-roles.errors.test.ts`, `tests/server/identity.test.ts`, `tests/server/identity.errors.test.ts`.

**Modified:** `src/setup/steps.ts` (re-export), `src/graph/token.ts` (guard), `src/server/main.ts` (wiring), `src/tools/errors.ts` (message), `tests/tools/errors.test.ts` (one test), `CLAUDE.md`, `docs/SETUP.md`, `docs/OPEN-ITEMS.md`.

A note on one deviation from the spec's wording: the spec says the reader's tests move with it. They do not move; the existing setup tests stay where they are and keep passing through the re-export, which the spec also requires, and a new `tests/graph/roles.test.ts` tests the reader at its new home. Moving them would mean editing setup tests, which the constraints forbid.

---

## Task 1: Move the roles reader into `src/graph`

**Files:**
- Create: `src/graph/roles.ts`, `tests/graph/roles.test.ts`
- Modify: `src/setup/steps.ts`

**Interfaces:**
- Produces: `appRolesFromAccessToken(token: string): string[] | undefined` exported from `src/graph/roles.ts`, and still exported from `src/setup/steps.ts`.

- [ ] **Step 1: Write the failing test** `tests/graph/roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { appRolesFromAccessToken } from "../../src/graph/roles.js";

function token(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.signature`;
}

describe("appRolesFromAccessToken", () => {
  it("reads the roles claim", () => {
    expect(appRolesFromAccessToken(token({ roles: ["Sites.Selected"] }))).toEqual(["Sites.Selected"]);
  });

  it("reports an empty array for a readable token with no roles claim", () => {
    expect(appRolesFromAccessToken(token({ aud: "https://graph.microsoft.com" }))).toEqual([]);
  });

  it("reports undefined for a token it cannot read", () => {
    expect(appRolesFromAccessToken("not-a-jwt")).toBeUndefined();
    expect(appRolesFromAccessToken("header.bm90LWpzb24.signature")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/graph/roles.test.ts`
Expected: FAIL, cannot find module `src/graph/roles.js`.

- [ ] **Step 3: Create `src/graph/roles.ts`**

Cut `appRolesFromAccessToken` and its full doc comment out of `src/setup/steps.ts` and paste them into the new file unchanged, then append one paragraph to the doc comment:

```ts
/**
 * (existing comment, unchanged)
 *
 * It lives under src/graph rather than src/setup because the running server
 * now reads its own token's roles too, and the production compile excludes
 * src/setup. The claim is still never an access decision on its own: the
 * server uses it only to refuse a token, never to grant anything.
 */
export function appRolesFromAccessToken(token: string): string[] | undefined {
  // body unchanged
}
```

In `src/setup/steps.ts`, where the function was, add:

```ts
export { appRolesFromAccessToken } from "../graph/roles.js";
```

and, if `steps.ts` itself calls the function (it does, in `assertBootstrapToken`), also add `import { appRolesFromAccessToken } from "../graph/roles.js";` at the top. Keep `src/setup/adapter.ts`'s import from `./steps.js` unchanged.

- [ ] **Step 4: Run the new and the setup tests**

Run: `npx vitest run tests/graph/roles.test.ts tests/setup`
Expected: PASS, with no setup test edited.

- [ ] **Step 5: Lint, typecheck, full suite, commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/graph/roles.ts src/setup/steps.ts tests/graph/roles.test.ts
git commit -m "refactor(graph): move the token roles reader where the server can use it"
```

---

## Task 2: The per-token guard

**Files:**
- Modify: `src/graph/token.ts`
- Test: `tests/graph/token-roles.test.ts`, `tests/graph/token-roles.errors.test.ts`

**Interfaces:**
- Consumes: `appRolesFromAccessToken` from `src/graph/roles.ts` (Task 1).
- Produces:
  - `class UnexpectedTokenRolesError extends Error` with readonly `found: string[] | undefined`, `extra: string[]`, `missing: string[]`
  - `requireExactRoles(provider: TokenProvider, expected: readonly string[]): TokenProvider`
  - `SERVER_TOKEN_ROLES: readonly ["Sites.Selected"]`

- [ ] **Step 1: Write the failing tests**

`tests/graph/token-roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { requireExactRoles, SERVER_TOKEN_ROLES, type TokenProvider } from "../../src/graph/token.js";

function jwt(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.signature`;
}

/** Hands out the given tokens in order, repeating the last, and counts calls. */
function sequence(tokens: string[]): TokenProvider & { calls: () => number } {
  let index = 0;
  return {
    calls: () => index,
    getToken: async () => tokens[Math.min(index++, tokens.length - 1)] ?? "",
  };
}

describe("requireExactRoles", () => {
  it("returns a token whose roles are exactly the expected set", async () => {
    const good = jwt({ roles: ["Sites.Selected"] });
    const guarded = requireExactRoles(sequence([good]), SERVER_TOKEN_ROLES);

    await expect(guarded.getToken()).resolves.toBe(good);
  });

  it("checks a newly minted token again rather than trusting the first", async () => {
    const first = jwt({ roles: ["Sites.Selected"], n: 1 });
    const second = jwt({ roles: ["Sites.Selected", "Files.Read.All"], n: 2 });
    const guarded = requireExactRoles(sequence([first, second]), SERVER_TOKEN_ROLES);

    await expect(guarded.getToken()).resolves.toBe(first);
    await expect(guarded.getToken()).rejects.toThrow(/Files\.Read\.All/);
  });
});
```

`tests/graph/token-roles.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  requireExactRoles,
  SERVER_TOKEN_ROLES,
  TokenRequestError,
  UnexpectedTokenRolesError,
  type TokenProvider,
} from "../../src/graph/token.js";

function jwt(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.signature`;
}

const fixed = (token: string): TokenProvider => ({ getToken: async () => token });

describe("requireExactRoles refusals", () => {
  it("refuses an extra role and names it", async () => {
    const guarded = requireExactRoles(fixed(jwt({ roles: ["Sites.Selected", "Files.Read.All"] })), SERVER_TOKEN_ROLES);

    const error = await guarded.getToken().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UnexpectedTokenRolesError);
    expect((error as UnexpectedTokenRolesError).extra).toEqual(["Files.Read.All"]);
    expect((error as UnexpectedTokenRolesError).missing).toEqual([]);
    expect((error as Error).message).toContain("Files.Read.All");
    expect((error as Error).message).not.toContain("header.");
  });

  it("refuses a token missing the expected role", async () => {
    const guarded = requireExactRoles(fixed(jwt({ roles: ["Sites.Read.All"] })), SERVER_TOKEN_ROLES);

    await expect(guarded.getToken()).rejects.toMatchObject({
      extra: ["Sites.Read.All"],
      missing: ["Sites.Selected"],
    });
  });

  it("refuses a token with no roles claim and says consent is probably missing", async () => {
    const guarded = requireExactRoles(fixed(jwt({ aud: "https://graph.microsoft.com" })), SERVER_TOKEN_ROLES);

    await expect(guarded.getToken()).rejects.toThrow(/admin-consented/);
  });

  it("refuses a token it cannot read rather than trusting it", async () => {
    const guarded = requireExactRoles(fixed("not-a-jwt"), SERVER_TOKEN_ROLES);

    await expect(guarded.getToken()).rejects.toMatchObject({ found: undefined });
  });

  it("passes an inner provider's error through unchanged", async () => {
    const failure = new TokenRequestError({ status: 401, body: '{"error":"invalid_client"}' });
    const guarded = requireExactRoles({ getToken: () => Promise.reject(failure) }, SERVER_TOKEN_ROLES);

    await expect(guarded.getToken()).rejects.toBe(failure);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/graph/token-roles`
Expected: FAIL, `requireExactRoles` is not exported.

- [ ] **Step 3: Implement in `src/graph/token.ts`**

Add `import { appRolesFromAccessToken } from "./roles.js";` and, after `clientCredentialsTokenProvider`:

```ts
/**
 * The one application role the server's own token may carry. Anything more
 * defeats the least-privilege boundary the Decision Record rests on: a Microsoft
 * Q&A moderator answered, as by design, that an application holding
 * Sites.Selected alongside Files.Read.All or User.Read.All could read sites it
 * was never granted.
 */
export const SERVER_TOKEN_ROLES = ["Sites.Selected"] as const;

/**
 * A token was minted whose application roles are not the expected set, so the
 * server refused to use it. `found` is undefined when the token could not be
 * read at all, which is refused rather than trusted: a check that fails open is
 * not a check.
 */
export class UnexpectedTokenRolesError extends Error {
  readonly found: string[] | undefined;
  readonly extra: string[];
  readonly missing: string[];

  constructor(args: { found: string[] | undefined; extra: string[]; missing: string[] }) {
    super(describeRoleMismatch(args));
    this.name = "UnexpectedTokenRolesError";
    this.found = args.found;
    this.extra = args.extra;
    this.missing = args.missing;
  }
}

function describeRoleMismatch(args: { found: string[] | undefined; extra: string[]; missing: string[] }): string {
  const refusal = "The server refused to use it, and made no Microsoft Graph request with it.";
  if (args.found === undefined) {
    return `The server application's Graph token could not be read, so its permissions could not be checked. ${refusal}`;
  }
  if (args.found.length === 0) {
    return (
      "The server application's Graph token carries no application permissions, so its Sites.Selected " +
      `permission is probably not admin-consented. ${refusal}`
    );
  }
  const parts: string[] = [];
  if (args.extra.length > 0) parts.push(`permissions beyond Sites.Selected: ${args.extra.join(", ")}`);
  if (args.missing.length > 0) parts.push(`missing: ${args.missing.join(", ")}`);
  return (
    `The server application's Graph token carries ${parts.join("; ")}. ${refusal} Remove every permission ` +
    "except Sites.Selected from the server application in Entra; the server checks its next token again, " +
    "so no restart is needed."
  );
}

/**
 * Checks every token the inner provider mints before anything uses it. The
 * inner provider owns caching and refresh; this remembers only the last token
 * it approved, so a reused token costs nothing and a newly minted one, which
 * the inner provider produces roughly hourly, is checked again. That is what
 * catches a permission added while the server is running.
 */
export function requireExactRoles(provider: TokenProvider, expected: readonly string[]): TokenProvider {
  const wanted = new Set(expected);
  let approved: string | undefined;

  return {
    async getToken(): Promise<string> {
      const token = await provider.getToken();
      if (token === approved) return token;

      const found = appRolesFromAccessToken(token);
      if (found === undefined) throw new UnexpectedTokenRolesError({ found, extra: [], missing: [...expected] });
      const have = new Set(found);
      const extra = found.filter((role) => !wanted.has(role)).sort();
      const missing = expected.filter((role) => !have.has(role));
      if (found.length === 0 || extra.length > 0 || missing.length > 0) {
        throw new UnexpectedTokenRolesError({ found, extra, missing });
      }

      approved = token;
      return token;
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/graph`
Expected: PASS, including the existing `tests/graph/token*.test.ts`.

- [ ] **Step 5: Lint, typecheck, full suite, commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/graph/token.ts tests/graph/token-roles.test.ts tests/graph/token-roles.errors.test.ts
git commit -m "feat(graph): refuse any token whose roles are not exactly Sites.Selected"
```

---

## Task 3: Startup check, server wiring, and the tool message

**Files:**
- Create: `src/server/identity.ts`, `tests/server/identity.test.ts`, `tests/server/identity.errors.test.ts`
- Modify: `src/server/main.ts`, `src/tools/errors.ts`, `tests/tools/errors.test.ts`

**Interfaces:**
- Consumes: `requireExactRoles`, `SERVER_TOKEN_ROLES`, `UnexpectedTokenRolesError`, `TokenProvider` (Task 2).
- Produces: `checkStartupIdentity(provider: TokenProvider, log: (line: string) => void): Promise<"verified" | "skipped">`.

- [ ] **Step 1: Write the failing tests**

`tests/server/identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkStartupIdentity } from "../../src/server/identity.js";

describe("checkStartupIdentity", () => {
  it("reports verified and logs nothing when the token passes", async () => {
    const lines: string[] = [];
    await expect(checkStartupIdentity({ getToken: async () => "ok" }, (line) => lines.push(line))).resolves.toBe(
      "verified",
    );
    expect(lines).toEqual([]);
  });
});
```

`tests/server/identity.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkStartupIdentity } from "../../src/server/identity.js";
import { TokenRequestError, UnexpectedTokenRolesError } from "../../src/graph/token.js";

describe("checkStartupIdentity failures", () => {
  it("rethrows a role mismatch so startup fails", async () => {
    const mismatch = new UnexpectedTokenRolesError({ found: ["Files.Read.All"], extra: ["Files.Read.All"], missing: ["Sites.Selected"] });
    const lines: string[] = [];

    await expect(checkStartupIdentity({ getToken: () => Promise.reject(mismatch) }, (line) => lines.push(line))).rejects.toBe(
      mismatch,
    );
    expect(lines).toEqual([]);
  });

  it("warns once and continues when the token endpoint refuses", async () => {
    const lines: string[] = [];
    const failure = new TokenRequestError({ status: 401, body: "{}" });

    await expect(checkStartupIdentity({ getToken: () => Promise.reject(failure) }, (line) => lines.push(line))).resolves.toBe(
      "skipped",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("will run on first use");
  });

  it("warns once and continues when the network fails", async () => {
    const lines: string[] = [];

    await expect(
      checkStartupIdentity({ getToken: () => Promise.reject(new TypeError("fetch failed")) }, (line) => lines.push(line)),
    ).resolves.toBe("skipped");
    expect(lines).toHaveLength(1);
  });
});
```

In `tests/tools/errors.test.ts`, add inside the `describe` (and add `UnexpectedTokenRolesError` to the import from `../../src/graph/token.js`):

```ts
  it("explains a refused token role set without sending the operator to the log", () => {
    const message = describeToolFailure(
      new UnexpectedTokenRolesError({ found: ["Sites.Selected", "Files.Read.All"], extra: ["Files.Read.All"], missing: [] }),
      SUBJECT,
    );

    expect(message).toContain("Files.Read.All");
    expect(message).toContain("Nothing was read or changed");
    expect(message).not.toContain("server log");
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/server/identity tests/tools/errors.test.ts`
Expected: FAIL, module `src/server/identity.js` not found, and the new errors test fails on the fallback text.

- [ ] **Step 3: Create `src/server/identity.ts`**

```ts
import { UnexpectedTokenRolesError, type TokenProvider } from "../graph/token.js";

/**
 * Asks for one token before the port is bound, so a deployment whose server
 * application carries the wrong permissions fails at startup with a message
 * rather than looking healthy until its first tool call.
 *
 * Only a role mismatch stops startup. Any other failure to obtain a token is a
 * fact about Entra or the network, not about this deployment's permissions,
 * and refusing to start on it would turn a third party's outage into a restart
 * loop, the failure GET /health is kept free of Graph to avoid. The guard in
 * front of the provider still checks the first token that does arrive.
 */
export async function checkStartupIdentity(
  provider: TokenProvider,
  log: (line: string) => void,
): Promise<"verified" | "skipped"> {
  try {
    await provider.getToken();
    return "verified";
  } catch (error) {
    if (error instanceof UnexpectedTokenRolesError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    log(
      `warning: could not obtain a Graph token at startup, so the check that it carries only Sites.Selected ` +
        `was skipped and will run on first use. ${detail}`,
    );
    return "skipped";
  }
}
```

- [ ] **Step 4: Wire it into `src/server/main.ts`**

Change the import to `import { clientCredentialsTokenProvider, requireExactRoles, SERVER_TOKEN_ROLES } from "../graph/token.js";`, add `import { checkStartupIdentity } from "./identity.js";`, and replace

```ts
  const graph = createGraphClient({ tokenProvider: clientCredentialsTokenProvider(credentials) });
```

with

```ts
  // Every Graph request passes through the guard, so a permission added to the
  // server application while it runs is refused within one token lifetime.
  const tokenProvider = requireExactRoles(clientCredentialsTokenProvider(credentials), SERVER_TOKEN_ROLES);
  // Before the port is bound, with the other configuration checks: a role
  // mismatch rejects out of main() into the handler at the bottom of this file.
  await checkStartupIdentity(tokenProvider, (line) => console.error(line));
  const graph = createGraphClient({ tokenProvider });
```

- [ ] **Step 5: Add the message to `src/tools/errors.ts`**

Add `UnexpectedTokenRolesError` to the import from `../graph/token.js`, and insert before the `TokenRequestError` branch:

```ts
  if (error instanceof UnexpectedTokenRolesError) {
    // Stated in full here rather than pointing at the server log: the error
    // already carries everything the operator needs, and nothing was read or
    // changed, because the token was refused before any Graph request.
    return (
      `${subject.tool} did not run: ${error.message} Nothing was read or changed, so there is nothing to ` +
      "check or roll back."
    );
  }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/server tests/tools/errors.test.ts tests/graph`
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, full suite, commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/server/identity.ts src/server/main.ts src/tools/errors.ts tests/server/identity.test.ts tests/server/identity.errors.test.ts tests/tools/errors.test.ts
git commit -m "feat(server): check the server's own token roles at startup and explain a refusal to tool callers"
```

---

## Task 4: Live check and documents (controller-run)

- [ ] **Step 1: Live check**

With `.superpowers/live-sitting/env.sh` sourced and Azurite reachable, start the server from source (`IW_PROFILE_DIR=profiles npx tsx src/server/main.ts`, under `timeout`), confirm the listening line and no startup warning, and call `inventory_tree` through `.superpowers/live-sitting/call-tool.ts`. Stop the server this session started.

- [ ] **Step 2: Documents, one commit**

- `CLAUDE.md`, Decision Record, Identity entry: append a sentence that the boundary is enforced at runtime since 2026-09-24: the server refuses any token whose roles are not exactly `Sites.Selected`, on every newly minted token and once at startup, starting anyway when Entra cannot be reached.
- `docs/SETUP.md`, near "The permission model": a paragraph saying the server refuses to start if its token carries any permission beyond `Sites.Selected`, what the startup message looks like, and that removing the extra permission in Entra is the fix, with no restart needed once running.
- `docs/OPEN-ITEMS.md`: mark the item "The server should refuse to start..." CLOSED with the commit, what the live check established (a correct token starts and serves), and what it did not (the refusal path was not exercised live, deliberately).

```bash
npm run lint && npm run typecheck && npm test
git add CLAUDE.md docs/SETUP.md docs/OPEN-ITEMS.md
git commit -m "docs: record the token role guard"
```
