# Server Application Teardown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the setup command a `--delete-server-app` mode that revokes a server application's per-site permission, deletes the application, and purges it from the tenant's deleted items, in that order.

**Architecture:** One new mode alongside the existing `--create-bootstrap` and `--delete-bootstrap`, following their established shape: argument parsing in `src/setup/cli.ts`, orchestration in `src/setup/run.ts` against the `SetupGraph` interface, HTTP in `src/setup/adapter.ts`, wiring in `src/setup/main.ts`, and operator-facing text formatted by pure functions in `cli.ts`. The orchestrator never touches `fetch`, which is what lets every path be tested against a fake.

**Tech Stack:** TypeScript, Node 22+, ESM with NodeNext resolution, vitest, plain `fetch`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-13-server-application-teardown-design.md`. It is binding where this plan and it disagree.

## Global Constraints

Every task's requirements implicitly include all of these.

- **No emojis or icons anywhere**, including logs and docs. **US English throughout.**
- **Comments explain why, not what.** This module's existing comments are unusually dense with rationale about Entra's behavior; match that register rather than thinning it.
- **A function that cannot observe an outcome must not assert it.** Before finishing any task that changes operator-facing text, enumerate every string that code path can print, reconstruct each composed string from its parts, and confirm that every object it names exists at that moment and every action it suggests is possible with the credential the operator holds then. This project produced the same defect nine times and this practice is what stopped it.
- **Imports carry the `.js` extension** (NodeNext), and `verbatimModuleSyntax` is on, so type-only imports must be written `import type`.
- **`noUncheckedIndexedAccess` is on.** An indexed read is `T | undefined` and must be narrowed.
- **Tests live in `tests/`, mirroring `src/`.** Error-path tests go in files ending `.errors.test.ts`, which the `test:errors` script gates separately in CI.
- **Conventional commits**, on a feature branch. Every commit message ends with these two lines, verbatim, regardless of which model writes it:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ds8MKaFZcayf4Ug91RCLo9
  ```
- **Verification before completion.** `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` must all pass before a task is called done. Run them; do not assume them. The suite stands at 846 tests across 67 files at the start of this work.
- **No live tenant calls.** Every task is tested against a fake `SetupGraph`. Live verification happens once, by the operator, as described in the spec.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/setup/adapter.ts` | `SetupGraph` interface and its `fetch` implementation | Add `listSitePermissions` and `purgeDeletedApplication` |
| `src/setup/cli.ts` | Argument parsing and every operator-facing string. No I/O | Add the new flags, the mutual-exclusion guard, and the mode's message formatters |
| `src/setup/run.ts` | Orchestration against `SetupGraph`. No `fetch` | Add `runDeleteServerApp`; fix `runDeleteBootstrap`'s already-absent path |
| `src/setup/main.ts` | Entry point: credentials, tokens, mode dispatch | Wire the new mode |
| `docs/SETUP.md` | Per-tenant operational procedure | Document the mode; correct the grant-issuer retention advice |
| `docs/OPEN-ITEMS.md` | The project's register | Close the teardown hole and the already-absent item |

---

### Task 1: `--delete-bootstrap` treats an already-absent grant issuer as a failure

`docs/OPEN-ITEMS.md` records this under "Found by using the tool, 2026-09-12" and it was never fixed. `runDeleteBootstrap` throws when the application does not exist, so the command prints "Bootstrap deletion failed" and exits 1 on a tenant that is already correctly torn down. A script wrapping this to enforce teardown across tenants reads a correct tenant as a broken one.

This task goes first because the new mode is built on the same answer, and because designing that answer into new code while the identical bug sits two functions away in the same file would be indefensible.

**Files:**
- Modify: `src/setup/run.ts` (`runDeleteBootstrap`)
- Modify: `src/setup/cli.ts` (`describeDeleteBootstrapSuccess`)
- Modify: `src/setup/main.ts` (the `--delete-bootstrap` arm)
- Test: `tests/setup/delete-bootstrap.test.ts`, `tests/setup/delete-bootstrap.errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type DeleteBootstrapOutcome =
    | { kind: "deleted"; appId: string; objectId: string }
    | { kind: "already-absent"; displayName: string };

  export async function runDeleteBootstrap(
    graph: SetupGraph,
    args: { displayName: string },
    hooks?: SetupHooks,
  ): Promise<DeleteBootstrapOutcome>;

  export function describeDeleteBootstrapSuccess(result: DeleteBootstrapOutcome): string;
  ```
  The return type changes from `{ appId, objectId }` to the union. Later tasks do not depend on it, but `main.ts` does, and this task updates that call site.

- [ ] **Step 1: Write the failing test**

Add to `tests/setup/delete-bootstrap.test.ts`, using the file's existing `fakeGraph` helper:

```ts
  it("reports an already-absent grant issuer as done, not as a failure", async () => {
    const { graph, calls } = fakeGraph(undefined);

    const outcome = await runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer" });

    expect(outcome).toEqual({ kind: "already-absent", displayName: "Ironwright Grant Issuer" });
    expect(calls).not.toContain("deleteApplication:should-not-be-called");
  });

  it("says nothing was deleted when the grant issuer was already gone, and does not claim a deletion", () => {
    const message = describeDeleteBootstrapSuccess({
      kind: "already-absent",
      displayName: "Ironwright Grant Issuer",
    });

    expect(message).toMatch(/no application named "Ironwright Grant Issuer"/i);
    expect(message).toMatch(/nothing to do/i);
    expect(message).not.toMatch(/Deleted application/);
  });
```

Import `describeDeleteBootstrapSuccess` from `../../src/setup/cli.js` at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/setup/delete-bootstrap.test.ts`
Expected: FAIL. The first case fails because `runDeleteBootstrap` throws instead of returning; the second fails to typecheck or throws because the formatter takes `{ appId }`.

- [ ] **Step 3: Change the orchestrator to return an outcome**

In `src/setup/run.ts`, replace the throw in `runDeleteBootstrap`:

```ts
export type DeleteBootstrapOutcome =
  | { kind: "deleted"; appId: string; objectId: string }
  | { kind: "already-absent"; displayName: string };

export async function runDeleteBootstrap(
  graph: SetupGraph,
  args: { displayName: string },
  hooks: SetupHooks = {},
): Promise<DeleteBootstrapOutcome> {
  const notice = hooks.onNotice ?? ((): void => {});

  const existing = await graph.findApplicationByDisplayName(args.displayName);
  if (existing === undefined) {
    // Absent is the outcome the operator asked for, not a failure. Reporting it
    // as one made a correctly torn-down tenant indistinguishable from a broken
    // one, so a script enforcing teardown across tenants would retry or alert on
    // a tenant that was already finished.
    return { kind: "already-absent", displayName: args.displayName };
  }

  notice(`Deleting application ${existing.appId} (object id ${existing.objectId}).`);
  await graph.deleteApplication(existing.objectId);

  return { kind: "deleted", appId: existing.appId, objectId: existing.objectId };
}
```

Keep the doc comment above the function as it is.

- [ ] **Step 4: Give the formatter the absent branch**

In `src/setup/cli.ts`, change `describeDeleteBootstrapSuccess` to take the union. Keep the existing text verbatim for the deleted branch, and add:

```ts
export function describeDeleteBootstrapSuccess(result: DeleteBootstrapOutcome): string {
  if (result.kind === "already-absent") {
    return (
      `No application named "${result.displayName}" exists in this tenant, so there was nothing to do and ` +
      "nothing was deleted. If the grant issuer was created under a different name, re-run with the same --name " +
      "it was created with. If it was removed by hand or by an earlier run, this is the finished state: a grant " +
      "issuer that does not exist holds no standing permission. Onboarding another site later needs one again, " +
      "so run this command with --create-bootstrap first."
    );
  }

  return (
    `Deleted application ${result.appId}. ` + /* ...existing text, unchanged... */ ""
  );
}
```

Transcribe the existing deleted-branch text exactly; do not reword it. Import `DeleteBootstrapOutcome` as a type from `./run.js`.

Note the circular-looking import: `cli.ts` importing a type from `run.js` while `main.ts` imports both. It is type-only, so it erases at compile time and creates no runtime cycle. If lint or typecheck objects, move the type to `src/setup/errors.ts`, which both already import from, and say so in your report.

- [ ] **Step 5: Update the entry point**

In `src/setup/main.ts`, the `--delete-bootstrap` arm passes the result to `describeDeleteBootstrapSuccess`. It now passes the outcome union unchanged. Confirm the exit code on the absent branch is zero: this is the whole point of the task. If `main.ts` sets a non-zero code anywhere on this path, that is the bug, and fixing it is part of this step.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/setup/`
Expected: PASS. Existing delete-bootstrap tests that asserted a throw must now be updated to assert the outcome; if any exist, change them rather than working around them, and say which in your report.

- [ ] **Step 7: Run everything**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/setup tests/setup
git commit -m "fix: treat an already-absent grant issuer as done, not as a failure"
```

---

### Task 2: two new Graph calls

**Files:**
- Modify: `src/setup/adapter.ts`
- Modify: `tests/setup/adapter.test.ts`, `tests/setup/adapter.errors.test.ts`
- Modify: `tests/setup/bootstrap-run.errors.test.ts`, `tests/setup/delete-bootstrap.test.ts`, `tests/setup/run.errors.test.ts`, `tests/setup/run.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, on `SetupGraph`:
  ```ts
  /** Each entry's id, with the application ids inside its granted identities. */
  listSitePermissions(siteId: string): Promise<Array<{ permissionId: string; appIds: string[] }>>;
  purgeDeletedApplication(objectId: string): Promise<void>;
  ```

**Read this before starting.** Four test files construct a complete `SetupGraph` fake, deliberately: a fake missing a method throws a `TypeError` the instant an unexpected call reaches it, before the calling test's assertions run, which would make a negative assertion pass vacuously. Adding two interface methods breaks all four until each gains both. Update every one; do not make the methods optional to avoid it.

- [ ] **Step 1: Write the failing tests**

Add to `tests/setup/adapter.test.ts`, following that file's existing fetch-stub style:

```ts
  it("lists a site's permissions with the application ids inside each grant", async () => {
    const graph = createFetchSetupGraph({
      token: "delegated",
      bootstrapToken: "bootstrap",
      fetchImpl: stubJson({
        value: [
          {
            id: "perm-1",
            grantedToIdentitiesV2: [{ application: { id: "app-a", displayName: "A" } }],
          },
          {
            id: "perm-2",
            grantedToIdentitiesV2: [
              { application: { id: "app-b", displayName: "B" } },
              { application: { id: "app-c", displayName: "C" } },
            ],
          },
        ],
      }),
    });

    await expect(graph.listSitePermissions("site-1")).resolves.toEqual([
      { permissionId: "perm-1", appIds: ["app-a"] },
      { permissionId: "perm-2", appIds: ["app-b", "app-c"] },
    ]);
  });

  it("reads an entry that carries no granted identities as granting to nobody", async () => {
    const graph = createFetchSetupGraph({
      token: "delegated",
      bootstrapToken: "bootstrap",
      fetchImpl: stubJson({ value: [{ id: "perm-1" }] }),
    });

    await expect(graph.listSitePermissions("site-1")).resolves.toEqual([
      { permissionId: "perm-1", appIds: [] },
    ]);
  });
```

Match `createFetchSetupGraph`'s real construction signature and the file's existing stub helper; the names above are illustrative of shape, not of that file's exact helpers. Read the file first and follow what is there.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/setup/adapter.test.ts`
Expected: FAIL, `listSitePermissions` is not a function.

- [ ] **Step 3: Implement both methods**

In `src/setup/adapter.ts`, add to the interface and the implementation:

```ts
interface SitePermissionListing {
  value?: Array<{
    id?: unknown;
    grantedToIdentitiesV2?: Array<{ application?: { id?: unknown } }>;
  }>;
}

// Listed on the bootstrap token for the same reason the grant and its rollback
// are: Graph refuses a delegated token on /sites/{id}/permissions regardless of
// the operator's directory roles.
async listSitePermissions(siteId: string): Promise<Array<{ permissionId: string; appIds: string[] }>> {
  const response = await graphRequest(bootstrapToken, "GET", `/sites/${siteId}/permissions`);
  const listing = response.value as SitePermissionListing;

  return (listing.value ?? []).flatMap((entry) => {
    if (typeof entry.id !== "string") return [];
    const appIds = (entry.grantedToIdentitiesV2 ?? []).flatMap((identity) =>
      typeof identity.application?.id === "string" ? [identity.application.id] : [],
    );
    return [{ permissionId: entry.id, appIds }];
  });
},

// Entra's delete of an application registration is a soft delete: the object
// sits in deleted items for 30 days, where anyone with Application
// Administrator can restore it along with its credentials. A teardown that
// stops at the delete has scheduled the credential's removal, not performed it.
async purgeDeletedApplication(objectId: string): Promise<void> {
  await graphRequest(token, "DELETE", `/directory/deletedItems/${objectId}`);
},
```

Use whatever the file names its delegated token variable; `token` above is illustrative.

- [ ] **Step 4: Update the four fakes**

Add both methods to the `SetupGraph` fake in each of `tests/setup/bootstrap-run.errors.test.ts`, `tests/setup/delete-bootstrap.test.ts`, `tests/setup/run.errors.test.ts` and `tests/setup/run.test.ts`, following each file's existing convention of recording the call and returning a `should-not-be-called` sentinel.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/setup/`
Expected: PASS.

- [ ] **Step 6: Run everything, then commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add src/setup tests/setup
git commit -m "feat: add site permission listing and deleted-application purge"
```

---

### Task 3: argument parsing for the new mode

**Files:**
- Modify: `src/setup/cli.ts` (`ParsedArgs`, `parseArgs`)
- Test: `tests/setup/cli.test.ts`, `tests/setup/cli.errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, on `ParsedArgs`:
  ```ts
  deleteServerApp: boolean;
  confirm: boolean;
  forceOrphan: boolean;
  ```
  `--delete-server-app` requires `--site`, unlike the two bootstrap modes. `--name` defaults to `DEFAULT_DISPLAY_NAME`, the normal run's default, not the bootstrap one.

- [ ] **Step 1: Write the failing tests**

In `tests/setup/cli.test.ts`:

```ts
  it("parses the server-app teardown mode, defaulting the name to the normal run's default", () => {
    const parsed = parseArgs([
      "node",
      "main.js",
      "--tenant=contoso.onmicrosoft.com",
      "--site=https://contoso.sharepoint.com/sites/Example",
      "--delete-server-app",
    ]);

    expect(parsed.deleteServerApp).toBe(true);
    expect(parsed.confirm).toBe(false);
    expect(parsed.forceOrphan).toBe(false);
    expect(parsed.displayName).toBe("Ironwright Repository Reconciliation");
  });

  it("reads the confirm and force-orphan flags", () => {
    const parsed = parseArgs([
      "node",
      "main.js",
      "--tenant=contoso.onmicrosoft.com",
      "--site=https://contoso.sharepoint.com/sites/Example",
      "--delete-server-app",
      "--confirm",
      "--force-orphan",
    ]);

    expect(parsed.confirm).toBe(true);
    expect(parsed.forceOrphan).toBe(true);
  });
```

Check `DEFAULT_DISPLAY_NAME`'s actual value in `cli.ts` and assert that, not the string above, if it differs.

In `tests/setup/cli.errors.test.ts`:

```ts
  it("refuses the teardown mode without a site, because the permission entry lives on one", () => {
    expect(() =>
      parseArgs(["node", "main.js", "--tenant=contoso.onmicrosoft.com", "--delete-server-app"]),
    ).toThrow(/--site/);
  });

  it.each([["--create-bootstrap"], ["--delete-bootstrap"]])(
    "refuses --delete-server-app together with %s",
    (other) => {
      expect(() =>
        parseArgs([
          "node",
          "main.js",
          "--tenant=contoso.onmicrosoft.com",
          "--site=https://contoso.sharepoint.com/sites/Example",
          "--delete-server-app",
          other,
        ]),
      ).toThrow(/cannot be used together/);
    },
  );
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/setup/cli.test.ts tests/setup/cli.errors.test.ts`
Expected: FAIL, the properties do not exist.

- [ ] **Step 3: Implement**

In `parseArgs`, add the flag and extend the mutual-exclusion guard. The existing guard rejects `--create-bootstrap` with `--delete-bootstrap`; make it reject any two of the three modes, and keep the existing message's reasoning:

```ts
  const deleteServerApp = argv.includes("--delete-server-app");

  // Three modes that act on different applications in different directions.
  // Letting one silently win is how an operator tears down the application they
  // meant to create, or deletes the grant issuer they meant to keep, with no
  // indication either happened.
  const modes = [
    createBootstrap ? "--create-bootstrap" : undefined,
    deleteBootstrap ? "--delete-bootstrap" : undefined,
    deleteServerApp ? "--delete-server-app" : undefined,
  ].filter((mode): mode is string => mode !== undefined);

  if (modes.length > 1) {
    throw new Error(
      `${modes.join(" and ")} cannot be used together. Run one, confirm its result, then run the other if you ` +
        "still need to.",
    );
  }
```

`bootstrapMode` stays as it is, covering only the two bootstrap flags, because `--delete-server-app` does require a site. Add `deleteServerApp`, `confirm: argv.includes("--confirm")` and `forceOrphan: argv.includes("--force-orphan")` to the returned object and to `ParsedArgs`.

- [ ] **Step 4: Run to verify they pass, then everything**

Run: `npx vitest run tests/setup/` then `npm run lint && npm run typecheck && npm test && npm run build`
Expected: PASS. If an existing test asserted the old two-flag message verbatim, update it and say so.

- [ ] **Step 5: Commit**

```bash
git add src/setup/cli.ts tests/setup
git commit -m "feat: parse the server-app teardown mode and its flags"
```

---

### Task 4: the teardown orchestration

**Files:**
- Modify: `src/setup/run.ts`
- Test: `tests/setup/delete-server-app.test.ts`, `tests/setup/delete-server-app.errors.test.ts`

**Interfaces:**
- Consumes: `SetupGraph` with `listSitePermissions` and `purgeDeletedApplication` (Task 2).
- Produces:
  ```ts
  export interface DeleteServerAppArgs {
    siteUrl: string;
    displayName: string;
    confirm: boolean;
    forceOrphan: boolean;
    hasGrantIssuer: boolean;
  }

  export type DeleteServerAppOutcome =
    | { kind: "already-absent"; displayName: string }
    | {
        kind: "planned";
        appId: string;
        objectId: string;
        permissionId: string | undefined;
      }
    | {
        kind: "torn-down";
        appId: string;
        objectId: string;
        permissionRevoked: boolean;
        orphanedPermission: boolean;
      };

  export async function runDeleteServerApp(
    graph: SetupGraph,
    args: DeleteServerAppArgs,
    hooks?: SetupHooks,
  ): Promise<DeleteServerAppOutcome>;
  ```
  `hasGrantIssuer` is passed in rather than detected, because whether bootstrap credentials were supplied is `main.ts`'s knowledge, and the orchestrator must stay free of environment reads to remain testable.

- [ ] **Step 1: Write the happy-path tests**

Create `tests/setup/delete-server-app.test.ts`. Build a fake `SetupGraph` in the style of `tests/setup/delete-bootstrap.test.ts`: every method present, each recording its call, with the ones this mode uses returning real values.

```ts
  it("plans without touching anything when confirm is absent", async () => {
    const { graph, calls } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [{ permissionId: "perm-1", appIds: ["app-1"] }],
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: false,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toEqual({ kind: "planned", appId: "app-1", objectId: "obj-1", permissionId: "perm-1" });
    expect(calls).not.toContain("deleteSitePermission:site-1:perm-1");
    expect(calls).not.toContain("deleteApplication:obj-1");
    expect(calls).not.toContain("purgeDeletedApplication:obj-1");
  });

  it("revokes, deletes and purges in that order when confirmed", async () => {
    const { graph, calls } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [{ permissionId: "perm-1", appIds: ["app-1"] }],
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toEqual({
      kind: "torn-down",
      appId: "app-1",
      objectId: "obj-1",
      permissionRevoked: true,
      orphanedPermission: false,
    });
    expect(calls.filter((call) => /deleteSitePermission|deleteApplication|purgeDeletedApplication/.test(call))).toEqual([
      "deleteSitePermission:site-1:perm-1",
      "deleteApplication:obj-1",
      "purgeDeletedApplication:obj-1",
    ]);
  });

  it("reports an application that is already gone as done", async () => {
    const { graph, calls } = fakeGraph({ app: undefined, permissions: [] });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toEqual({ kind: "already-absent", displayName: "Ironwright Repository Reconciliation" });
    expect(calls).not.toContain("deleteApplication:obj-1");
  });

  it("deletes and purges when no permission entry is granted to the application", async () => {
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [{ permissionId: "perm-9", appIds: ["someone-else"] }],
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toMatchObject({ kind: "torn-down", permissionRevoked: false, orphanedPermission: false });
  });
```

The fake's `resolveSite` should return `{ siteId: "site-1" }` so the call records above line up.

- [ ] **Step 2: Write the error-path tests**

Create `tests/setup/delete-server-app.errors.test.ts`:

```ts
  it("refuses without a grant issuer, and touches nothing", async () => {
    const { graph, calls } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [{ permissionId: "perm-1", appIds: ["app-1"] }],
    });

    await expect(
      runDeleteServerApp(graph, {
        siteUrl: "https://contoso.sharepoint.com/sites/Example",
        displayName: "Ironwright Repository Reconciliation",
        confirm: true,
        forceOrphan: false,
        hasGrantIssuer: false,
      }),
    ).rejects.toThrow(/--create-bootstrap/);

    expect(calls).not.toContain("deleteApplication:obj-1");
    expect(calls).not.toContain("purgeDeletedApplication:obj-1");
  });

  it("with --force-orphan, deletes and purges without a grant issuer and reports the residue", async () => {
    const { graph, calls } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [],
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: true,
      hasGrantIssuer: false,
    });

    expect(outcome).toMatchObject({ kind: "torn-down", permissionRevoked: false, orphanedPermission: true });
    expect(calls).toContain("deleteApplication:obj-1");
    expect(calls).toContain("purgeDeletedApplication:obj-1");
    expect(calls).not.toContain("listSitePermissions:site-1");
  });

  it("tolerates a 404 from the delete and still purges", async () => {
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [],
      deleteApplicationStatus: 404,
    });

    const outcome = await runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    expect(outcome).toMatchObject({ kind: "torn-down" });
  });

  it("tolerates a 404 from the purge, since already purged is the outcome asked for", async () => {
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [],
      purgeStatus: 404,
    });

    await expect(
      runDeleteServerApp(graph, {
        siteUrl: "https://contoso.sharepoint.com/sites/Example",
        displayName: "Ironwright Repository Reconciliation",
        confirm: true,
        forceOrphan: false,
        hasGrantIssuer: true,
      }),
    ).resolves.toMatchObject({ kind: "torn-down" });
  });

  it("says the grant is revoked and the application still exists when the delete fails", async () => {
    const { graph } = fakeGraph({
      app: { objectId: "obj-1", appId: "app-1" },
      permissions: [{ permissionId: "perm-1", appIds: ["app-1"] }],
      deleteApplicationStatus: 403,
    });

    const failure = runDeleteServerApp(graph, {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      displayName: "Ironwright Repository Reconciliation",
      confirm: true,
      forceOrphan: false,
      hasGrantIssuer: true,
    });

    await expect(failure).rejects.toThrow(/permission was revoked/i);
    await expect(failure).rejects.toThrow(/application still exists/i);
  });
```

The fake needs `deleteApplicationStatus` and `purgeStatus` options that make those methods throw a `GraphRequestError` with that status. Import it from `../../src/graph/errors.js`.

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run tests/setup/delete-server-app.test.ts tests/setup/delete-server-app.errors.test.ts`
Expected: FAIL, `runDeleteServerApp` does not exist.

- [ ] **Step 4: Implement**

In `src/setup/run.ts`:

```ts
/**
 * Removes a server application and the per-site permission it was granted.
 *
 * The order is forced rather than chosen. The permission entry is matched to
 * the application by app id, so the revoke has to happen while that identity
 * still exists; deleting first leaves an entry naming an identity that is gone,
 * which is the residue this mode exists to stop producing. The purge is what
 * actually ends the credential's life: Entra's delete is a soft delete with a
 * 30 day restore window, so stopping at the delete schedules the removal rather
 * than performing it.
 */
export async function runDeleteServerApp(
  graph: SetupGraph,
  args: DeleteServerAppArgs,
  hooks: SetupHooks = {},
): Promise<DeleteServerAppOutcome> {
  const notice = hooks.onNotice ?? ((): void => {});

  const existing = await graph.findApplicationByDisplayName(args.displayName);
  if (existing === undefined) {
    // The outcome the operator asked for is already true. Nothing else in this
    // function can run without an app id to match a permission entry against.
    return { kind: "already-absent", displayName: args.displayName };
  }

  // resolveSite takes the hostname-and-server-relative form, not the URL as
  // typed. runSetup builds it the same way; passing the raw URL yields a 400.
  const { siteId } = await graph.resolveSite(siteIdPathFromUrl(args.siteUrl));

  let permissionId: string | undefined;
  if (args.hasGrantIssuer) {
    const permissions = await graph.listSitePermissions(siteId);
    permissionId = permissions.find((entry) => entry.appIds.includes(existing.appId))?.permissionId;
  } else if (!args.forceOrphan) {
    throw new Error(
      `Revoking the site permission needs a grant issuer's app-only token, and none was configured, so nothing ` +
        `was touched: application ${existing.appId} still exists and still holds its grant on ${args.siteUrl}. ` +
        "Create one with --create-bootstrap and re-run, or pass --force-orphan to delete and purge the " +
        "application anyway and leave the permission entry behind.",
    );
  }

  if (!args.confirm) {
    return { kind: "planned", appId: existing.appId, objectId: existing.objectId, permissionId };
  }

  let permissionRevoked = false;
  if (permissionId !== undefined) {
    notice(`Revoking site permission ${permissionId} on ${siteId}.`);
    await graph.deleteSitePermission(siteId, permissionId);
    permissionRevoked = true;
  }

  notice(`Deleting application ${existing.appId} (object id ${existing.objectId}).`);
  try {
    await graph.deleteApplication(existing.objectId);
  } catch (error) {
    if (statusOf(error) !== 404) {
      throw new Error(
        `The site permission was revoked, and the application still exists: deleting ${existing.appId} failed. ` +
          `Re-running is safe and will finish the job. Underlying failure: ${messageOf(error)}`,
      );
    }
  }

  notice(`Purging application ${existing.objectId} from deleted items.`);
  try {
    await graph.purgeDeletedApplication(existing.objectId);
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
  }

  return {
    kind: "torn-down",
    appId: existing.appId,
    objectId: existing.objectId,
    permissionRevoked,
    orphanedPermission: !args.hasGrantIssuer,
  };
}
```

Add two small helpers next to it, or reuse equivalents if `run.ts` already has them:

```ts
function statusOf(error: unknown): number | undefined {
  return error instanceof GraphRequestError ? error.status : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

Import `GraphRequestError` from `../graph/errors.js`.

Note the partial-failure message names the real state rather than a verdict, and says re-running is safe. That is true by construction: on a re-run the permission is already absent so no revoke is attempted, and the delete either succeeds or fails the same way.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/setup/delete-server-app.test.ts tests/setup/delete-server-app.errors.test.ts`
Expected: PASS.

- [ ] **Step 6: Run everything, then commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add src/setup/run.ts tests/setup/delete-server-app.test.ts tests/setup/delete-server-app.errors.test.ts
git commit -m "feat: orchestrate server application teardown"
```

---

### Task 5: the operator-facing messages

**Files:**
- Modify: `src/setup/cli.ts`
- Test: `tests/setup/cli.test.ts`

**Interfaces:**
- Consumes: `DeleteServerAppOutcome` (Task 4).
- Produces:
  ```ts
  export function describeDeleteServerAppOutcome(outcome: DeleteServerAppOutcome, siteUrl: string): string;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
  it("previews what it would remove without claiming it removed anything", () => {
    const message = describeDeleteServerAppOutcome(
      { kind: "planned", appId: "app-1", objectId: "obj-1", permissionId: "perm-1", permissionsInspected: true },
      "https://contoso.sharepoint.com/sites/Example",
    );

    expect(message).toMatch(/would/i);
    expect(message).toMatch(/--confirm/);
    expect(message).toMatch(/app-1/);
    expect(message).toMatch(/perm-1/);
    expect(message).not.toMatch(/Deleted|Purged|Revoked/);
  });

  it("says the permission entry is not there when the listing ran and matched nothing", () => {
    const message = describeDeleteServerAppOutcome(
      { kind: "planned", appId: "app-1", objectId: "obj-1", permissionId: undefined, permissionsInspected: true },
      "https://contoso.sharepoint.com/sites/Example",
    );

    expect(message).toMatch(/no permission entry/i);
  });

  it("says the permissions were not inspected when --force-orphan skipped the listing", () => {
    const message = describeDeleteServerAppOutcome(
      { kind: "planned", appId: "app-1", objectId: "obj-1", permissionId: undefined, permissionsInspected: false },
      "https://contoso.sharepoint.com/sites/Example",
    );

    // The distinction this test exists for: an uninspected site must not be
    // reported as an empty one.
    expect(message).toMatch(/not inspected/i);
    expect(message).not.toMatch(/no permission entry/i);
  });

  it("reports a completed teardown and says the credential is no longer recoverable", () => {
    const message = describeDeleteServerAppOutcome(
      { kind: "torn-down", appId: "app-1", objectId: "obj-1", permissionRevoked: true, orphanedPermission: false },
      "https://contoso.sharepoint.com/sites/Example",
    );

    expect(message).toMatch(/revoked/i);
    expect(message).toMatch(/purged/i);
    expect(message).toMatch(/not recoverable/i);
  });

  it("names the residue exactly when the permission entry was left behind", () => {
    const message = describeDeleteServerAppOutcome(
      { kind: "torn-down", appId: "app-1", objectId: "obj-1", permissionRevoked: false, orphanedPermission: true },
      "https://contoso.sharepoint.com/sites/Example",
    );

    // "may still remain", not "remains": with --force-orphan the site's
    // permissions were never listed, so the code cannot observe whether there
    // was an entry, and asserting one would claim something it did not see.
    expect(message).toMatch(/may still remain/i);
    expect(message).toMatch(/grants access to nothing/i);
    expect(message).toMatch(/--create-bootstrap/);
    expect(message).not.toMatch(/entry remains on/i);
  });

  it("says nothing was deleted when the application was already gone", () => {
    const message = describeDeleteServerAppOutcome(
      { kind: "already-absent", displayName: "Ironwright Repository Reconciliation" },
      "https://contoso.sharepoint.com/sites/Example",
    );

    expect(message).toMatch(/nothing to do/i);
    expect(message).not.toMatch(/Deleted application/);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/setup/cli.test.ts`
Expected: FAIL, the function does not exist.

- [ ] **Step 3: Implement**

```ts
export function describeDeleteServerAppOutcome(outcome: DeleteServerAppOutcome, siteUrl: string): string {
  if (outcome.kind === "already-absent") {
    return (
      `No application named "${outcome.displayName}" exists in this tenant, so there was nothing to do and ` +
      "nothing was deleted. If it was created under a different name, re-run with the same --name it was " +
      "created with. If it was already removed, this is the finished state. A permission entry granted to it " +
      `may still sit on ${siteUrl}, and this command cannot find it once the application it named is gone: ` +
      "clearing that needs the entry identified by hand in the site's permissions."
    );
  }

  if (outcome.kind === "planned") {
    // Three cases, not two. An undefined permissionId means "the listing found
    // no match" only when the listing ran; under --force-orphan it means nobody
    // looked, and reporting that as an absence would assert something this run
    // never observed. Task 4's review added permissionsInspected for exactly
    // this distinction.
    const permission = !outcome.permissionsInspected
      ? `The site's permissions on ${siteUrl} were not inspected, because --force-orphan was given and ` +
        "inspecting them needs a grant issuer. If an entry is granted to this application it would be " +
        "left behind."
      : outcome.permissionId === undefined
        ? `No permission entry on ${siteUrl} is granted to it, so there would be nothing to revoke.`
        : `It would first revoke permission entry ${outcome.permissionId} on ${siteUrl}.`;

    return (
      `This was a dry run and nothing was changed. Application ${outcome.appId}, object id ${outcome.objectId}, ` +
      `is what would be removed. ${permission} It would then delete the application and purge it from the ` +
      "tenant's deleted items, which is what ends its secret's life: a delete alone is a soft delete and leaves " +
      "the credential restorable for 30 days. Re-run with --confirm to carry this out."
    );
  }

  const revoked = outcome.permissionRevoked
    ? `Revoked its permission entry on ${siteUrl}.`
    : `No permission entry on ${siteUrl} was granted to it, so none was revoked.`;

  const residue = outcome.orphanedPermission
    ? ` A permission entry for this application may still remain on ${siteUrl}, because --force-orphan ran this ` +
      "teardown without a grant issuer and the site's permissions were never inspected. If one remains it now " +
      "names an identity that no longer exists, so it grants access to nothing, and removing it needs a grant " +
      "issuer created with --create-bootstrap and the entry identified by hand."
    : "";

  return (
    `Deleted application ${outcome.appId} and purged it from deleted items, so its secret is not recoverable: ` +
    "an application deleted but not purged stays restorable, with its credentials, for 30 days. " +
    `${revoked}${residue} Onboarding this site again needs a fresh application, so run this command without ` +
    "--delete-server-app when you do."
  );
}
```

Two things in that text are load-bearing and must not be softened. The planned branch uses no past-tense verb, because nothing has happened. And the orphaned branch says a permission entry *may* remain rather than that one does: with `--force-orphan` the site's permissions were never listed, so the code cannot observe whether there was one, and claiming there is would assert something it did not see.

- [ ] **Step 4: Perform the message audit**

Enumerate every string this mode can print, including the two thrown from `run.ts` in Task 4 and the argument-parsing failures from Task 3. For each: name the path that produces it, and confirm every object it mentions exists at that moment and every action it suggests is possible then. Write the enumeration into your report as a table. If the audit finds a message that is wrong, fix it and say so.

- [ ] **Step 5: Run everything, then commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add src/setup/cli.ts tests/setup/cli.test.ts
git commit -m "feat: describe every server-app teardown outcome"
```

---

### Task 6: wire the mode into the entry point

**Files:**
- Modify: `src/setup/main.ts`
- Modify: `src/setup/cli.ts` if `SetupMode` needs the new member

**Interfaces:**
- Consumes: `parseArgs` (Task 3), `runDeleteServerApp` (Task 4), `describeDeleteServerAppOutcome` (Task 5).
- Produces: nothing later tasks consume.

- [ ] **Step 1: Extend the mode type and the dispatch**

`main.ts` computes `mode` for its failure reporting and branches on `parsed.deleteBootstrap` then `parsed.createBootstrap`. Add `delete-server-app` to `SetupMode` and a branch for it, before the normal setup arm.

The new arm needs the grant issuer's app-only token, acquired the same way the normal run acquires it, and must pass `hasGrantIssuer` reflecting whether bootstrap credentials were actually resolved. Read how `parsed.bootstrap` is resolved and used in the normal arm and follow it exactly.

When `forceOrphan` is set and no bootstrap credentials exist, do not attempt the token exchange at all: the orchestrator is designed to skip the listing in that case, and attempting a token with credentials that are not there would fail before it could.

- [ ] **Step 2: Confirm the exit codes**

A `planned` outcome and every already-absent outcome exit zero. Only a thrown failure exits 1. Verify by reading the existing top-level catch, and state in your report which paths you traced.

- [ ] **Step 3: Run everything**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 4: Drive the command by hand**

`main.ts` has no test seam by design, so exercise the argument surface directly. These must all fail before any network call and print the message the task expects:

```bash
npm run setup -- --tenant=x --delete-server-app
npm run setup -- --tenant=x --site=https://example.sharepoint.com/sites/A --delete-server-app --delete-bootstrap
```

Paste the real output into your report. Do not run a form that would reach Graph.

- [ ] **Step 5: Commit**

```bash
git add src/setup
git commit -m "feat: wire the server-app teardown mode into the setup command"
```

---

### Task 7: documentation, and closing two open items

**Files:**
- Modify: `docs/SETUP.md`
- Modify: `src/setup/cli.ts` (`GRANT_ISSUER_TEARDOWN_TAIL`)
- Modify: `docs/OPEN-ITEMS.md`

**Interfaces:**
- Consumes: the finished mode.
- Produces: nothing in code.

- [ ] **Step 1: Correct the grant-issuer retention advice**

`GRANT_ISSUER_TEARDOWN_TAIL` in `src/setup/cli.ts` currently tells the operator to delete the grant issuer once onboarding is done. That advice is what strands the permission entry later, and it is the root cause the open item identified.

Rewrite it to say the grant issuer should be kept until the site is decommissioned, because revoking the server application's permission at teardown needs one, and that deleting it now means recreating one later. Keep the existing distinction it draws, that a secret's expiry disables a credential while only deletion removes the standing permission: that part is correct and load-bearing.

Any test asserting the old wording must be updated, not worked around.

- [ ] **Step 2: Document the mode in `docs/SETUP.md`**

Add a section covering: what `--delete-server-app` does, the order it does it in and why, that dry run is the default and `--confirm` is required to act, that it needs the same grant issuer credentials a normal run needs, what `--force-orphan` is for and what it leaves behind, and that a soft delete alone leaves the credential recoverable for 30 days which is why the purge is included rather than optional.

Also correct the existing guidance in that file that recommends deleting the grant issuer after onboarding, to match step 1.

- [ ] **Step 3: Close the two open items**

In `docs/OPEN-ITEMS.md`:

Mark "Teardown has a hole for the server application" as closed, naming the mode, and noting that the root cause, the advice to delete the grant issuer immediately, was corrected in the same work.

Mark "Found by using the tool, 2026-09-12" as closed by Task 1, naming the behavior now: an already-absent grant issuer reports its own message and exits zero.

Both closures follow this file's existing convention of a bold status line at the top of the section with the original entry preserved below.

- [ ] **Step 4: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test && npm run build`

```bash
git add docs src/setup/cli.ts tests/setup
git commit -m "docs: document teardown, fix the grant-issuer advice, close two open items"
```

---

## Finishing the branch

After Task 7, use `superpowers:requesting-code-review` for a whole-branch review, then `superpowers:finishing-a-development-branch`.

This work changes a destructive path and the messages around it, so the review should pay particular attention to the message audit from Task 5 and to whether any path can delete an application without having first attempted the revoke.

Live verification happens once, by the operator, as part of the next setup and scan sitting: create a bootstrap, run setup, run a scan, then tear the application back down with this mode and confirm the site's permission list no longer names it and the deleted-items list is empty. Record the result in `docs/OPEN-ITEMS.md`, including whether a service principal survived the application's deletion, which the spec flags as unverified.
