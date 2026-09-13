# Grant Issuer Teardown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the documented delete-after-setup posture executable, by adding a `--delete-bootstrap` mode and telling the operator about it at the one moment they will act on it.

**Architecture:** No new machinery. `findApplicationByDisplayName` and `deleteApplication` already exist on `SetupGraph`, added for the duplicate guard and the rollback path. The new mode is a third branch in `main.ts` alongside `--create-bootstrap` and the normal run, backed by a small orchestrator function that reuses both.

**Tech Stack:** Unchanged.

## Why this exists

The setup documentation recommends deleting the grant issuer after onboarding a site, and the tool provides no way to do it. That is the same shape of defect this module has produced six times already: the words and the behavior disagreeing. It was missed because a reviewer flagged "no tooling to revoke it" and it was treated as a documentation matter when it was a missing capability.

It matters most in a customer tenant. Leaving the grant issuer in place means the product retains an application with full control over every SharePoint site the customer owns, indefinitely. Deleting it after onboarding means that access existed for the length of a setup run.

One distinction the messages must get right: the seven-day secret expiry kills the credential, not the privilege. After it lapses the application still exists and still holds its admin-consented `Sites.FullControl.All` assignment, so anyone with Application Administrator could mint a new secret and have tenant-wide SharePoint access with no further consent. Expiry is a safety net against a leaked secret. Deletion is what removes the standing privilege. Do not let any message imply that waiting out the week is equivalent.

## Global Constraints

- Node `>=22.0.0`, TypeScript ESM, `NodeNext` resolution, `strict: true`. Relative imports carry a `.js` extension.
- No emojis or icons anywhere, including logs and docs. US English. Comments explain why, not what.
- Documentation is prose. Bullets only for genuinely list-shaped content. No em dashes or en dashes.
- Error-path test files are named `*.errors.test.ts`.
- No secret or tenant-identifying value in a committed file.
- The orchestrator stays free of transport detail; all HTTP lives in the adapter.
- Diagnostic messages name a cause and an action, and must not assert an outcome the code cannot observe. That rule is why this module's messages were rewritten six times; do not reintroduce the pattern.
- Baseline: 313 tests in 22 files, 106 error-path. Gate green.

## Context every task needs

`SetupGraph` already provides `findApplicationByDisplayName(displayName): Promise<{ objectId: string; appId: string } | undefined>` and `deleteApplication(objectId): Promise<void>`.

`parseArgs(argv, env)` returns `ParsedArgs` carrying `tenantId`, `siteUrl`, `displayName`, `write`, `clientId`, `createBootstrap`, and `bootstrap`. `displayName` defaults to `Ironwright Grant Issuer` in bootstrap mode and `Ironwright Repository Reconciliation` otherwise.

`main.ts` currently branches once, on `parsed.createBootstrap`, and otherwise runs the normal setup. Deleting requires only the operator's delegated sign-in; the grant issuer's own credentials cannot delete it, because it holds `Sites.FullControl.All` and nothing else.

---

### Task 1: The `--delete-bootstrap` mode

**Files:**
- Modify: `src/setup/cli.ts`, `src/setup/run.ts`, `src/setup/main.ts`
- Test: `tests/setup/delete-bootstrap.test.ts`, `tests/setup/delete-bootstrap.errors.test.ts`

**Interfaces:**
- Consumes: `findApplicationByDisplayName`, `deleteApplication` on `SetupGraph`; `ParsedArgs`.
- Produces: `ParsedArgs` gains `deleteBootstrap: boolean`. `runDeleteBootstrap(graph: SetupGraph, args: { displayName: string }, hooks?: SetupHooks): Promise<{ appId: string; objectId: string }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/setup/delete-bootstrap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { runDeleteBootstrap } from "../../src/setup/run.js";

function fakeGraph(found: { objectId: string; appId: string } | undefined): {
  graph: SetupGraph;
  calls: string[];
} {
  const calls: string[] = [];
  const graph = {
    findApplicationByDisplayName: async (displayName: string) => {
      calls.push(`findApplicationByDisplayName:${displayName}`);
      return found;
    },
    deleteApplication: async (objectId: string) => {
      calls.push(`deleteApplication:${objectId}`);
    },
  } as unknown as SetupGraph;
  return { graph, calls };
}

describe("runDeleteBootstrap", () => {
  it("finds the grant issuer by name and deletes it", async () => {
    const { graph, calls } = fakeGraph({ objectId: "obj-1", appId: "app-1" });

    const result = await runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer" });

    expect(calls).toEqual([
      "findApplicationByDisplayName:Ironwright Grant Issuer",
      "deleteApplication:obj-1",
    ]);
    expect(result).toEqual({ appId: "app-1", objectId: "obj-1" });
  });

  it("creates nothing and touches no site", async () => {
    const { graph, calls } = fakeGraph({ objectId: "obj-1", appId: "app-1" });

    await runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer" });

    expect(calls.some((call) => call.startsWith("createApplication"))).toBe(false);
    expect(calls.some((call) => call.startsWith("resolveSite"))).toBe(false);
    expect(calls.some((call) => call.startsWith("grantSitePermission"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/setup/delete-bootstrap.test.ts`
Expected: FAIL, `runDeleteBootstrap` is not exported.

- [ ] **Step 3: Add the flag to `parseArgs`**

In `src/setup/cli.ts`, add `deleteBootstrap: boolean` to `ParsedArgs` and set it from `argv.includes("--delete-bootstrap")`. Like `--create-bootstrap`, it takes no site, so include it in the condition that makes `siteUrl` optional, and it should default `displayName` to the grant issuer name for the same reason bootstrap mode does: it operates on that application.

Reject the combination of `--create-bootstrap` and `--delete-bootstrap` in one invocation with a clear message. Creating and deleting in one run is never what someone means, and silently letting one win is how a person deletes what they just made.

- [ ] **Step 4: Write `runDeleteBootstrap` in `src/setup/run.ts`**

```ts
/**
 * Removes the grant issuer. Deleting it is what actually removes the standing
 * privilege: the secret's expiry only disables one credential, while the
 * application keeps its admin-consented Sites.FullControl.All assignment and
 * anyone able to add a secret would regain tenant-wide SharePoint access
 * without further consent.
 */
export async function runDeleteBootstrap(
  graph: SetupGraph,
  args: { displayName: string },
  hooks: SetupHooks = {},
): Promise<{ appId: string; objectId: string }> {
  const notice = hooks.onNotice ?? ((): void => {});

  const existing = await graph.findApplicationByDisplayName(args.displayName);
  if (existing === undefined) {
    throw new Error(
      `No application named "${args.displayName}" exists in this tenant, so there is nothing to delete. ` +
        "If the grant issuer was created with a different name, pass the same --name it was created with. " +
        "If it was already deleted, no action is needed: deleting it is what removes the standing permission, " +
        "and a deleted application keeps no access.",
    );
  }

  notice(`Deleting application ${existing.appId} (object id ${existing.objectId}).`);
  await graph.deleteApplication(existing.objectId);

  return { appId: existing.appId, objectId: existing.objectId };
}
```

- [ ] **Step 5: Check how the lookup behaves when more than one application shares the name**

Read `findApplicationByDisplayName` in `src/setup/adapter.ts`. If it can silently return the first of several matches, that is not acceptable for a delete path: the operator would be told one application was removed while another identically named one remains, and a second run would delete that one too. Make it refuse an ambiguous match with a message naming how many were found and telling the operator to disambiguate with `--name` or to delete in the portal.

If it already refuses or the query cannot return multiples, say so in your report rather than changing it.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/setup/delete-bootstrap.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the error-path tests**

Create `tests/setup/delete-bootstrap.errors.test.ts` covering: the not-found case throwing a message that names the display name and mentions `--name`; the delete itself failing propagating the original error rather than a wrapped one; and the rejected flag combination. Add whatever the Step 5 investigation requires.

- [ ] **Step 8: Wire it into `src/setup/main.ts`**

Add the branch before the normal run and before the bootstrap-credential preflight, since deleting needs no bootstrap credentials at all and requiring them would make the mode unusable in the exact situation it exists for, a grant issuer whose secret was lost or has expired.

It needs the operator's delegated sign-in, so it comes after the device-code flow. On success, print the application id that was deleted and one line noting the standing tenant-wide permission is now gone, and that onboarding another site later means recreating the grant issuer with `--create-bootstrap`.

- [ ] **Step 9: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:errors
git add src tests
git commit -m "feat: add --delete-bootstrap so the documented teardown is executable"
```

---

### Task 2: Tell the operator at the moment they will act

**Files:**
- Modify: `src/setup/main.ts`
- Test: extend an existing `tests/setup/cli*.test.ts` or add one, per whatever seam exists

- [ ] **Step 1: Add the closing guidance to a successful normal run**

After the four printed values, on both the confirmed and the unconfirmed path, print a short closing note: the grant issuer is no longer needed for this site, deleting it removes the standing tenant-wide permission, the command to do it, and that onboarding another site later means recreating it.

It must not print in `--create-bootstrap` or `--delete-bootstrap` mode.

Put it after the values rather than before. Someone scrolling back for a secret should not have to read past advice to find it.

Two things this note must get right, both of which have bitten this module before. It must not imply that letting the secret expire is equivalent to deleting the application, for the reason in this plan's opening. And it must not assert that the operator has done anything or that any object is gone, because at the moment it prints the grant issuer certainly still exists.

- [ ] **Step 2: Pin it with a test**

Assert the note appears on both success paths, that it does not appear in the other two modes, and that it names the delete command. If `main.ts` has no test seam, extract the note's text into a pure function in `cli.ts` alongside the other message builders and test that, which is the pattern the module already uses for exactly this reason.

- [ ] **Step 3: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:errors
git add src tests
git commit -m "feat: point the operator at grant issuer teardown when setup succeeds"
```

---

### Task 3: Documentation

**Files:**
- Modify: `docs/SETUP.md`, `docs/OPEN-ITEMS.md`

- [ ] **Step 1: Update `docs/SETUP.md`**

The delete-after-setup section currently describes a posture with no command. Give it the command, and state the expiry-versus-deletion distinction plainly: the seven-day expiry disables one credential, while deletion removes the standing `Sites.FullControl.All` assignment, and those are not the same thing.

Say that this matters more in a customer tenant than in a developer one, and why: leaving the grant issuer in place means retaining full control of every SharePoint site the customer owns, indefinitely.

Also note what deletion does not affect. The deployed server holds `Sites.Selected` plus its own per-site grant and keeps working after the grant issuer is gone.

- [ ] **Step 2: Update `docs/OPEN-ITEMS.md`**

Record that the teardown gap is closed, with the commit. Note under what remains unexercised that the delete path, like every other failure path, has been tested only against fakes.

- [ ] **Step 3: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:errors
git add docs
git commit -m "docs: document grant issuer teardown and why expiry is not deletion"
```

---

## Definition of done

- `npm run lint && npm run typecheck && npm test && npm run test:errors && npm run build` all pass.
- `--delete-bootstrap` removes the grant issuer using only the operator's delegated sign-in, needing no bootstrap credentials.
- It refuses an ambiguous match rather than deleting one of several identically named applications.
- It refuses to run alongside `--create-bootstrap`.
- A successful normal run tells the operator the grant issuer can be removed, and how, without implying that expiry is equivalent.
- The documentation states the expiry-versus-deletion distinction and gives a command for the posture it recommends.
