# Setup Grant Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the setup command able to complete, by issuing the per-site grant with an app-only token from a separate long-lived bootstrap application instead of the operator's delegated token, which a live run on 2026-09-12 confirmed Graph refuses.

**Architecture:** The command gains a second mode. `--create-bootstrap` creates a small grant-issuing application holding `Sites.FullControl.All` once per tenant. Normal runs read that application's credentials from the environment and use an app-only token from it for the two calls that touch `/sites/{id}/permissions`, while every other call keeps using the operator's delegated token. The server's own identity never holds more than `Sites.Selected` at any moment, including transiently.

**Tech Stack:** Unchanged. TypeScript ESM, Node 22, Vitest, `@azure/identity` for the device-code sign-in, plain `fetch` for Graph.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=22.0.0`. TypeScript ESM, `NodeNext` resolution, `strict: true`. Relative imports carry a `.js` extension.
- No emojis or icons anywhere: not in code, comments, CLI output, logs, or docs.
- US English. Comments explain why, not what.
- Documentation is prose, short paragraphs. Bullets only for genuinely list-shaped content. No em dashes or en dashes.
- Error-path test files are named `*.errors.test.ts`. `npm run test:errors` is a separate CI gate.
- Tests are type-checked through `tsconfig.test.json`.
- No secret or tenant-identifying value may reach a committed file.
- The orchestrator stays free of transport detail. All HTTP lives in the adapter, behind the `SetupGraph` interface, so the orchestration is testable against a fake.
- Diagnostic messages name a cause and an action. A message that restates a status code is a defect.
- Baseline: 231 tests in 18 files, 64 error-path. Do not modify existing tests except where a task says to.

## Context every task needs

The Microsoft Graph resource app id is `00000003-0000-0000-c000-000000000000`, already exported as `MICROSOFT_GRAPH_APP_ID` from `src/setup/steps.ts`.

Two app role values matter. `Sites.Selected` is what the server's own application gets. `Sites.FullControl.All` is what the bootstrap application holds permanently and what Graph requires in order to call `POST /sites/{site-id}/permissions` at all.

The current normal-run sequence in `runSetup` is: resolve site, create application, add password, create service principal, resolve Graph's service principal, grant the app role, grant the per-site permission, verify. Everything from `addPassword` onward is inside a try whose catch calls `rollback`.

---

### Task 1: Extract the error type and resolve bootstrap credentials

**Files:**
- Create: `src/setup/errors.ts`, `tests/setup/bootstrap-args.test.ts`, `tests/setup/bootstrap-args.errors.test.ts`
- Modify: `src/setup/run.ts` (remove the class, import it), `src/setup/cli.ts` (import from the new module, add resolution), `src/setup/main.ts` (import path if it references the class)

**Interfaces:**
- Consumes: `ParsedArgs`, `findValue`, `requiredValue` in `src/setup/cli.ts`.
- Produces: `SetupFailedError` from `src/setup/errors.ts`. `BootstrapCredentials = { clientId: string; clientSecret: string }`. `resolveBootstrapCredentials(argv: string[], env: NodeJS.ProcessEnv): BootstrapCredentials | undefined`. `parseArgs(argv: string[], env?: NodeJS.ProcessEnv): ParsedArgs`, where `ParsedArgs` gains `createBootstrap: boolean` and `bootstrap: BootstrapCredentials | undefined`.

- [ ] **Step 1: Write the failing test**

Create `tests/setup/bootstrap-args.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseArgs, resolveBootstrapCredentials } from "../../src/setup/cli.js";

const base = ["node", "main.js", "--tenant=contoso.onmicrosoft.com", "--site=https://contoso.sharepoint.com/sites/X"];

describe("resolveBootstrapCredentials", () => {
  it("reads the environment when no flags are given", () => {
    expect(
      resolveBootstrapCredentials(base, { IW_BOOTSTRAP_CLIENT_ID: "env-id", IW_BOOTSTRAP_CLIENT_SECRET: "env-secret" }),
    ).toEqual({ clientId: "env-id", clientSecret: "env-secret" });
  });

  it("prefers explicit flags over the environment", () => {
    const argv = [...base, "--bootstrap-client-id=flag-id", "--bootstrap-client-secret=flag-secret"];
    expect(
      resolveBootstrapCredentials(argv, { IW_BOOTSTRAP_CLIENT_ID: "env-id", IW_BOOTSTRAP_CLIENT_SECRET: "env-secret" }),
    ).toEqual({ clientId: "flag-id", clientSecret: "flag-secret" });
  });

  it("returns undefined when neither source supplies anything", () => {
    expect(resolveBootstrapCredentials(base, {})).toBeUndefined();
  });
});

describe("parseArgs bootstrap mode", () => {
  it("defaults createBootstrap to false", () => {
    expect(parseArgs(base).createBootstrap).toBe(false);
  });

  it("sets createBootstrap when the flag is present", () => {
    expect(parseArgs([...base, "--create-bootstrap"]).createBootstrap).toBe(true);
  });

  it("does not require a site when creating the bootstrap application", () => {
    const argv = ["node", "main.js", "--tenant=contoso.onmicrosoft.com", "--create-bootstrap"];
    expect(() => parseArgs(argv)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/setup/bootstrap-args.test.ts`
Expected: FAIL, `resolveBootstrapCredentials` is not exported.

- [ ] **Step 3: Create `src/setup/errors.ts`**

Move the class out of `run.ts` verbatim, so `cli.ts` no longer imports the orchestrator, which drags the adapter and its `fetch` calls into the CLI unit test module graph.

```ts
import type { VerificationOutcome } from "./steps.js";

/**
 * Lives here rather than beside the orchestrator so that cli.ts, which formats
 * this error, does not have to import run.ts and transitively pull the adapter's
 * network code into a module graph that is meant to be pure.
 */
export class SetupFailedError extends Error {
  readonly outcome: Extract<VerificationOutcome, { ok: false }>;

  constructor(outcome: Extract<VerificationOutcome, { ok: false }>) {
    super(outcome.message);
    this.name = "SetupFailedError";
    this.outcome = outcome;
  }
}
```

- [ ] **Step 4: Update `src/setup/run.ts`**

Delete the `SetupFailedError` class declaration and add at the top:

```ts
import { SetupFailedError } from "./errors.js";
```

Keep a re-export so nothing else breaks:

```ts
export { SetupFailedError } from "./errors.js";
```

- [ ] **Step 5: Update `src/setup/cli.ts`**

Change its import of the error from `./run.js` to `./errors.js`. Then add, after the existing `requiredValue` helper:

```ts
export interface BootstrapCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * The environment is the documented path because these are the credentials of an
 * application holding Sites.FullControl.All over every site in the tenant, and a
 * command-line flag puts that secret in shell history. Flags exist as a
 * documented fallback for a caller that already manages secrets another way.
 */
export function resolveBootstrapCredentials(
  argv: string[],
  env: NodeJS.ProcessEnv,
): BootstrapCredentials | undefined {
  const clientId = findValue(argv, "bootstrap-client-id") ?? emptyToUndefined(env.IW_BOOTSTRAP_CLIENT_ID);
  const clientSecret =
    findValue(argv, "bootstrap-client-secret") ?? emptyToUndefined(env.IW_BOOTSTRAP_CLIENT_SECRET);
  if (clientId === undefined || clientSecret === undefined) return undefined;
  return { clientId, clientSecret };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
```

- [ ] **Step 6: Add the mode flag to `parseArgs`**

Widen the signature to `parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env)`, so the
environment is injected rather than read from a global and the tests above can control it. Add
`createBootstrap: boolean` and `bootstrap: BootstrapCredentials | undefined` to `ParsedArgs`,
then in `parseArgs` set:

```ts
  const createBootstrap = argv.includes("--create-bootstrap");
```

and make the site argument conditional, because creating the bootstrap application does not involve a site:

```ts
    siteUrl: createBootstrap ? (findValue(argv, "site") ?? "") : requiredValue(argv, "site"),
    createBootstrap,
    bootstrap: resolveBootstrapCredentials(argv, env),
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/setup/bootstrap-args.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Write the error-path test**

Create `tests/setup/bootstrap-args.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveBootstrapCredentials } from "../../src/setup/cli.js";

const base = ["node", "main.js", "--tenant=contoso.onmicrosoft.com", "--site=https://contoso.sharepoint.com/sites/X"];

describe("resolveBootstrapCredentials rejections", () => {
  it("returns undefined when only the id is supplied", () => {
    expect(resolveBootstrapCredentials(base, { IW_BOOTSTRAP_CLIENT_ID: "env-id" })).toBeUndefined();
  });

  it("returns undefined when only the secret is supplied", () => {
    expect(resolveBootstrapCredentials(base, { IW_BOOTSTRAP_CLIENT_SECRET: "env-secret" })).toBeUndefined();
  });

  it("treats an empty environment value as absent", () => {
    expect(
      resolveBootstrapCredentials(base, { IW_BOOTSTRAP_CLIENT_ID: "", IW_BOOTSTRAP_CLIENT_SECRET: "env-secret" }),
    ).toBeUndefined();
  });

  it("treats an empty flag value as absent rather than overriding the environment", () => {
    const argv = [...base, "--bootstrap-client-id="];
    expect(
      resolveBootstrapCredentials(argv, { IW_BOOTSTRAP_CLIENT_ID: "env-id", IW_BOOTSTRAP_CLIENT_SECRET: "s" }),
    ).toEqual({ clientId: "env-id", clientSecret: "s" });
  });
});
```

- [ ] **Step 9: Run the error-path test**

Run: `npm run test:errors`
Expected: PASS. The empty-flag case matters: a flag that expanded to nothing must fall back to the environment rather than blanking a valid value.

- [ ] **Step 10: Run the whole gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:errors
git add src tests
git commit -m "feat: resolve bootstrap credentials and extract the setup error type"
```

---

### Task 2: Resolve Graph app role ids from the service principal

**Files:**
- Modify: `src/setup/steps.ts`, `src/setup/adapter.ts`, `src/setup/run.ts`, `tests/setup/adapter.test.ts`, `tests/setup/run.test.ts`
- Test: `tests/setup/steps.test.ts` (append), `tests/setup/steps.errors.test.ts` (append)

**Interfaces:**
- Consumes: `MICROSOFT_GRAPH_APP_ID`, `SITES_SELECTED_ROLE_CLAIM` from Task 0 state.
- Produces: `SITES_FULL_CONTROL_ROLE_CLAIM = "Sites.FullControl.All"`. `appRoleIdByValue(appRoles: GraphAppRole[], value: string): string`, throwing when absent. `GraphAppRole = { id: string; value: string }`. `SetupGraph.resolveServicePrincipal` now returns `{ objectId: string; appRoles: GraphAppRole[] }`.

Why: `SITES_SELECTED_APP_ROLE_ID` is a hardcoded GUID, and this task is about to need a second one. The command already fetches Graph's service principal, and that response carries `appRoles`, so both ids can be looked up by value at no extra call and neither constant has to be trusted.

- [ ] **Step 1: Write the failing test**

Append to `tests/setup/steps.test.ts`:

```ts
import { appRoleIdByValue, SITES_FULL_CONTROL_ROLE_CLAIM } from "../../src/setup/steps.js";

describe("appRoleIdByValue", () => {
  const roles = [
    { id: "role-selected", value: "Sites.Selected" },
    { id: "role-full", value: "Sites.FullControl.All" },
  ];

  it("finds a role id by its value", () => {
    expect(appRoleIdByValue(roles, "Sites.Selected")).toBe("role-selected");
  });

  it("finds the full control role", () => {
    expect(appRoleIdByValue(roles, SITES_FULL_CONTROL_ROLE_CLAIM)).toBe("role-full");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/setup/steps.test.ts`
Expected: FAIL, `appRoleIdByValue` is not exported.

- [ ] **Step 3: Add the lookup to `src/setup/steps.ts`**

```ts
export const SITES_FULL_CONTROL_ROLE_CLAIM = "Sites.FullControl.All";

export interface GraphAppRole {
  id: string;
  value: string;
}

/**
 * Looked up rather than hardcoded. The command already fetches Graph's service
 * principal to get the resourceId for a role assignment, and that same response
 * carries every app role Graph publishes, so a constant GUID here would be an
 * unverified copy of data already in hand.
 */
export function appRoleIdByValue(appRoles: GraphAppRole[], value: string): string {
  const match = appRoles.find((role) => role.value === value);
  if (match === undefined) {
    throw new Error(
      `Microsoft Graph does not publish an application role named "${value}". This usually means the service principal response was truncated or the role was renamed; report it with the value shown here.`,
    );
  }
  return match.id;
}
```

Delete `SITES_SELECTED_APP_ROLE_ID` and its uses.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/setup/steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the error-path test**

Append to `tests/setup/steps.errors.test.ts`:

```ts
import { appRoleIdByValue } from "../../src/setup/steps.js";

describe("appRoleIdByValue rejections", () => {
  it("names the missing role and does not return a guess", () => {
    expect(() => appRoleIdByValue([{ id: "a", value: "Sites.Selected" }], "Sites.FullControl.All")).toThrow(
      /Sites\.FullControl\.All/,
    );
  });

  it("rejects an empty role list rather than returning undefined", () => {
    expect(() => appRoleIdByValue([], "Sites.Selected")).toThrow();
  });
});
```

- [ ] **Step 6: Widen the adapter's return**

In `src/setup/adapter.ts`, change the interface member to
`resolveServicePrincipal(appId: string): Promise<{ objectId: string; appRoles: GraphAppRole[] }>;`
and the implementation to request and return the roles:

```ts
    async resolveServicePrincipal(appId) {
      const response = await graphRequest(
        accessToken,
        "GET",
        `/servicePrincipals(appId='${appId}')?$select=id,appRoles`,
      );
      const found = requireFields(response, ["id"]);
      const appRoles = Array.isArray(response.appRoles) ? (response.appRoles as GraphAppRole[]) : [];
      return { objectId: found.id, appRoles };
    },
```

- [ ] **Step 7: Update `runSetup` to look the id up**

Replace the hardcoded role id in the `buildAppRoleAssignmentRequest` call with
`appRoleId: appRoleIdByValue(graphServicePrincipal.appRoles, SITES_SELECTED_ROLE_CLAIM)`.
`buildAppRoleAssignmentRequest` currently supplies the role id itself from the constant being
deleted, so change it to take `appRoleId` as a third field on its argument object and pass it
through to the request.

- [ ] **Step 8: Update the existing fakes**

Every fake `resolveServicePrincipal` in `tests/setup/run.test.ts` and `tests/setup/run.errors.test.ts` must now return `appRoles` containing at least `{ id: "role-selected", value: "Sites.Selected" }`, and the adapter tests must assert the `$select` is requested.

- [ ] **Step 9: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:errors
git add src tests
git commit -m "refactor: look up Graph app role ids by value instead of hardcoding them"
```

---

### Task 3: Route the site-permission calls through a bootstrap token

**Files:**
- Modify: `src/setup/adapter.ts`, `src/setup/main.ts`, `tests/setup/adapter.test.ts`, `tests/setup/adapter.errors.test.ts`

**Interfaces:**
- Produces: `createFetchSetupGraph(options: FetchSetupGraphOptions): SetupGraph` where `FetchSetupGraphOptions = { adminToken: string; acquireAppToken: (appId: string, secret: string) => Promise<string>; acquireBootstrapToken: () => Promise<string> }`. The positional signature is replaced.

Why: Graph refuses a delegated token on `/sites/{id}/permissions`. Confirmed live on 2026-09-12 with a Global Administrator, so insufficient rights is excluded. Both the grant and its rollback delete hit that same endpoint family and both must use the bootstrap application's app-only token. Every other call keeps the operator's delegated token, because the operator is who should be creating applications and consenting roles.

- [ ] **Step 1: Write the failing test**

Append to `tests/setup/adapter.test.ts`:

```ts
describe("token routing", () => {
  it("uses the bootstrap token for the per-site grant and the admin token elsewhere", async () => {
    const seen: { path: string; authorization: string }[] = [];
    const fetchStub = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      seen.push({ path: String(url), authorization: headers.get("authorization") ?? "" });
      return new Response(JSON.stringify({ id: "x", appId: "y", secretText: "s" }), { status: 200 });
    };

    const graph = createFetchSetupGraph({
      adminToken: "ADMIN",
      acquireAppToken: async () => "APP",
      acquireBootstrapToken: async () => "BOOTSTRAP",
      fetchImpl: fetchStub,
    });

    await graph.resolveSite("host:/sites/X");
    await graph.grantSitePermission("site-1", { roles: ["read"], grantedToIdentities: [] });

    expect(seen[0]?.authorization).toBe("Bearer ADMIN");
    expect(seen[1]?.path).toContain("/sites/site-1/permissions");
    expect(seen[1]?.authorization).toBe("Bearer BOOTSTRAP");
  });
});
```

Read `tests/setup/adapter.test.ts` before writing this. The adapter is already tested against a
stubbed `fetch`, so use whatever injection mechanism those tests already rely on and carry it
into the new options object under the same name. Do not introduce a second mechanism alongside
the existing one; if those tests stub a module-level binding rather than an injected function,
keep that and drop `fetchImpl` from the options entirely.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/setup/adapter.test.ts`
Expected: FAIL, `createFetchSetupGraph` does not accept an options object.

- [ ] **Step 3: Change the factory signature**

```ts
export interface FetchSetupGraphOptions {
  /** The signed-in operator's delegated token. Used for everything except the site permission endpoint. */
  adminToken: string;
  /** Mints an app-only token for a newly created application, used only to verify its own access. */
  acquireAppToken: (appId: string, secret: string) => Promise<string>;
  /**
   * Mints an app-only token for the long-lived bootstrap application. Graph
   * refuses a delegated token on /sites/{id}/permissions regardless of the
   * caller's directory roles, confirmed live against a Global Administrator on
   * 2026-09-12, so the grant and its rollback must both use this.
   */
  acquireBootstrapToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export function createFetchSetupGraph(options: FetchSetupGraphOptions): SetupGraph {
```

Inside, `grantSitePermission` and `deleteSitePermission` both `await options.acquireBootstrapToken()` and pass that token; every other method keeps using `options.adminToken`.

- [ ] **Step 4: Update `src/setup/main.ts`**

Convert the call site to the options object and add the bootstrap token acquisition, reusing `acquireTokenWithRetry` exactly as the app token does, since the same propagation delay applies to a freshly created bootstrap secret:

```ts
  const acquireBootstrapToken = async (): Promise<string> => {
    if (parsed.bootstrap === undefined) {
      throw new Error(
        "No bootstrap credentials. Set IW_BOOTSTRAP_CLIENT_ID and IW_BOOTSTRAP_CLIENT_SECRET, or run this command once with --create-bootstrap to create the grant-issuing application. See docs/SETUP.md.",
      );
    }
    return acquireAppOnlyToken(parsed.bootstrap.clientId, parsed.bootstrap.clientSecret);
  };
```

Extract the existing inline client-credentials exchange into a named `acquireAppOnlyToken(clientId, secret)` so both callers use one implementation rather than two copies.

- [ ] **Step 5: Run the tests and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:errors
git add src tests
git commit -m "feat: issue the per-site grant with the bootstrap application's token"
```

---

### Task 4: Bootstrap creation mode and preflight

**Files:**
- Modify: `src/setup/run.ts`, `src/setup/main.ts`, `src/setup/steps.ts`
- Test: `tests/setup/bootstrap-run.test.ts`, `tests/setup/bootstrap-run.errors.test.ts`

**Interfaces:**
- Produces: `runCreateBootstrap(graph: SetupGraph, args: { displayName: string }, hooks?: SetupHooks): Promise<{ appId: string; objectId: string; secret: string }>`. `assertBootstrapToken(token: string): void`, throwing an actionable error when the token does not carry `Sites.FullControl.All`.

- [ ] **Step 1: Write the failing test**

Create `tests/setup/bootstrap-run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { runCreateBootstrap } from "../../src/setup/run.js";

function fakeGraph(): { graph: SetupGraph; calls: string[] } {
  const calls: string[] = [];
  const graph = {
    resolveSite: async () => {
      calls.push("resolveSite");
      return { siteId: "should-not-be-called" };
    },
    createApplication: async (request: { displayName: string }) => {
      calls.push(`createApplication:${request.displayName}`);
      return { objectId: "obj-1", appId: "app-1" };
    },
    addPassword: async () => {
      calls.push("addPassword");
      return { secretText: "secret-1" };
    },
    createServicePrincipal: async () => {
      calls.push("createServicePrincipal");
      return { objectId: "sp-1" };
    },
    resolveServicePrincipal: async () => {
      calls.push("resolveServicePrincipal");
      return { objectId: "graph-sp", appRoles: [{ id: "role-full", value: "Sites.FullControl.All" }] };
    },
    grantAppRole: async (request: { appRoleId: string }) => {
      calls.push(`grantAppRole:${request.appRoleId}`);
    },
    grantSitePermission: async () => {
      calls.push("grantSitePermission");
      return { permissionId: "p" };
    },
    verifyAppAccess: async () => {
      calls.push("verifyAppAccess");
      return { status: 200, body: "{}", appRoles: [] };
    },
    deleteSitePermission: async () => {
      calls.push("deleteSitePermission");
    },
    deleteApplication: async () => {
      calls.push("deleteApplication");
    },
  } as unknown as SetupGraph;
  return { graph, calls };
}

describe("runCreateBootstrap", () => {
  it("creates a full control application and never touches a site", async () => {
    const { graph, calls } = fakeGraph();

    const result = await runCreateBootstrap(graph, { displayName: "Ironwright Grant Issuer" });

    expect(calls).toEqual([
      "createApplication:Ironwright Grant Issuer",
      "addPassword",
      "createServicePrincipal",
      "resolveServicePrincipal",
      "grantAppRole:role-full",
    ]);
    expect(calls).not.toContain("resolveSite");
    expect(calls).not.toContain("grantSitePermission");
    expect(result).toEqual({ appId: "app-1", objectId: "obj-1", secret: "secret-1" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/setup/bootstrap-run.test.ts`
Expected: FAIL, `runCreateBootstrap` is not exported.

- [ ] **Step 3: Implement `runCreateBootstrap` in `src/setup/run.ts`**

```ts
/**
 * Creates the grant-issuing application. This is the one place a
 * Sites.FullControl.All credential is created deliberately, and it is a separate
 * mode rather than part of a normal run so that creating a tenant-wide
 * credential is always an explicit act. The server's own application never holds
 * this role, not even transiently, which is the reason for the split: removing a
 * role assignment does not revoke a token already issued under it.
 */
export async function runCreateBootstrap(
  graph: SetupGraph,
  args: { displayName: string },
  hooks: SetupHooks = {},
): Promise<{ appId: string; objectId: string; secret: string }> {
  const notice = hooks.onNotice ?? ((): void => {});

  const { objectId, appId } = await graph.createApplication(
    buildAppRegistrationRequest(args.displayName, SITES_FULL_CONTROL_ROLE_CLAIM),
  );

  try {
    const { secretText } = await graph.addPassword(objectId);
    const servicePrincipal = await graph.createServicePrincipal(appId);
    const graphServicePrincipal = await graph.resolveServicePrincipal(MICROSOFT_GRAPH_APP_ID);
    await graph.grantAppRole(
      buildAppRoleAssignmentRequest({
        principalId: servicePrincipal.objectId,
        resourceId: graphServicePrincipal.objectId,
        appRoleId: appRoleIdByValue(graphServicePrincipal.appRoles, SITES_FULL_CONTROL_ROLE_CLAIM),
      }),
    );
    return { appId, objectId, secret: secretText };
  } catch (error) {
    await rollbackApplication(graph, objectId, appId, notice);
    throw error;
  }
}
```

`buildAppRegistrationRequest` gains a second parameter naming which role claim the registration requests, defaulting to `SITES_SELECTED_ROLE_CLAIM` so existing callers are unchanged. Note it requests the role by claim value; the id is resolved at assignment time.

Split the existing `rollback` so its application-deleting half is reusable as `rollbackApplication`, rather than duplicating that block.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/setup/bootstrap-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the preflight assertion to `src/setup/steps.ts`**

```ts
/**
 * Checked before a normal run creates anything. A bootstrap application whose
 * role was never consented fails at the grant call, which is the last step, so
 * without this check a misconfigured bootstrap costs a created-then-rolled-back
 * application on every attempt and reports a failure two steps from its cause.
 */
export function assertBootstrapToken(token: string): void {
  const roles = appRolesFromAccessToken(token);
  if (roles === undefined) {
    throw new Error(
      "The bootstrap application's token could not be read, so its permissions cannot be checked before proceeding. Confirm IW_BOOTSTRAP_CLIENT_ID and IW_BOOTSTRAP_CLIENT_SECRET belong to the grant-issuing application.",
    );
  }
  if (!roles.includes(SITES_FULL_CONTROL_ROLE_CLAIM)) {
    throw new Error(
      `The bootstrap application's token does not carry ${SITES_FULL_CONTROL_ROLE_CLAIM}, so it cannot issue a per-site grant. Its application permission exists on the registration but has not been admin-consented in this tenant. A Privileged Role Administrator or Global Administrator must consent it, or re-run this command with --create-bootstrap to create a correctly configured application.`,
    );
  }
}
```

- [ ] **Step 6: Write the error-path test**

Create `tests/setup/bootstrap-run.errors.test.ts` covering: `assertBootstrapToken` rejecting an unreadable token, rejecting a token whose roles omit full control, and accepting one that includes it; plus `runCreateBootstrap` rolling the application back when `grantAppRole` throws, asserting `deleteApplication` was called and the original error survives.

Build tokens with the same three-segment base64url shape the existing `appRolesFromAccessToken` tests use, so this test exercises the real parser rather than a stub.

- [ ] **Step 7: Wire both into `src/setup/main.ts`**

When `parsed.createBootstrap` is true, call `runCreateBootstrap` and print the two values with an instruction to set them as `IW_BOOTSTRAP_CLIENT_ID` and `IW_BOOTSTRAP_CLIENT_SECRET`, then return without touching a site. Otherwise, before calling `runSetup`, acquire the bootstrap token once and pass it through `assertBootstrapToken`.

- [ ] **Step 8: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:errors
git add src tests
git commit -m "feat: add --create-bootstrap mode and a bootstrap permission preflight"
```

---

### Task 5: Close the three known issues in this module

**Files:**
- Modify: `src/setup/run.ts`, `src/setup/steps.ts`, `tests/setup/run.errors.test.ts`

Each of these is recorded in `docs/PHASE-1-FOLLOW-UPS.md` under "Known minor issues" and each lives in code this plan is already touching.

- [ ] **Step 1: Write the failing test for the rollback gap**

A site permission that is granted but whose response omits an id is currently not rolled back, because the field check throws before the id is captured, so the rollback deletes the application and leaves the permission. Add to `tests/setup/run.errors.test.ts` a fake whose `grantSitePermission` throws after the server-side grant would have happened, and assert the rollback still attempts to remove the permission.

```ts
  it("attempts to remove a site permission whose response could not be read", async () => {
    const calls: string[] = [];
    const graph = graphWith({
      grantSitePermission: async () => {
        calls.push("grantSitePermission");
        throw new Error("permission response had no id");
      },
      deleteSitePermission: async () => {
        calls.push("deleteSitePermission");
      },
    });

    await expect(runSetup(graph, args)).rejects.toThrow(/no id/);
    expect(calls).toContain("deleteSitePermission");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:errors`
Expected: FAIL, `deleteSitePermission` is never called.

- [ ] **Step 3: Treat the permission as possibly-granted from the moment the call starts**

In `runSetup`, set a `sitePermissionAttempted` flag immediately before calling `grantSitePermission`, and have `rollback` attempt the delete when either an id is known or the attempt flag is set. Deleting a permission that was never created must be tolerated: report it through `notice` rather than throwing, exactly as the existing rollback failures are.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run test:errors`
Expected: PASS.

- [ ] **Step 5: Add the replication-lag retry on service principal creation**

`POST /servicePrincipals` immediately after `POST /applications` intermittently fails with `Request_ResourceNotFound` from directory replication lag, and with rollback in place, losing that race now tears down the whole run. Wrap that one call in the same bounded retry the token exchange uses, gated to that Graph error code only. Add a test with a fake that fails once with that code and succeeds on the second attempt, asserting two attempts and a successful run.

- [ ] **Step 6: Correct the grant-missing remedy**

`GRANT_REMEDY` currently tells the operator to issue a per-site grant that the command issued seconds earlier. With the bootstrap flow, a 403 carrying the `Sites.Selected` role most likely means the grant has not propagated, or the bootstrap application's grant did not apply to this site. Rewrite it to say that, name propagation as the first thing to wait on, and keep re-running discouraged. Update the assertions in `tests/setup/steps.errors.test.ts` that pin the old text.

- [ ] **Step 7: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:errors
git add src tests
git commit -m "fix: close the rollback gap, replication race, and stale remedy in setup"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/SETUP.md`, `README.md`, `docs/PHASE-1-FOLLOW-UPS.md`

- [ ] **Step 1: Rewrite `docs/SETUP.md` for the two-phase flow**

It must cover, as prose rather than an outline: that setup is two commands, one of which runs once per tenant; what the bootstrap application is, that it holds `Sites.FullControl.All` permanently, and why that privilege is isolated in an application whose only job is issuing grants rather than held by the server; that the server's own application holds only `Sites.Selected`; which directory role is needed for each phase; that the bootstrap credentials belong in the environment and not on a command line, with flags as a documented fallback; and that a live run on 2026-09-12 confirmed Graph refuses a delegated token on the grant endpoint even for a Global Administrator, which is why the split exists.

Keep the existing sections on the device-code client id and on where the printed values belong. Do not re-teach the Azure portal.

- [ ] **Step 2: Update `README.md`**

One sentence in the setup area noting that the first run per tenant is `--create-bootstrap`, pointing at `docs/SETUP.md`.

- [ ] **Step 3: Update `docs/PHASE-1-FOLLOW-UPS.md`**

Mark the three known issues Task 5 closed as closed with their commit subjects, and update the outstanding-verification section: the bootstrap flow is implemented but the end-to-end run, including the client-credentials exchange and the verification call, has still never executed against a tenant.

- [ ] **Step 4: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:errors
git add docs README.md
git commit -m "docs: describe the two-phase setup and the bootstrap application"
```

---

## Definition of done

- `npm run lint && npm run typecheck && npm test && npm run test:errors && npm run build` all pass.
- `--create-bootstrap` creates an application holding `Sites.FullControl.All` and touches no site.
- A normal run refuses to create anything when bootstrap credentials are missing or lack the role, and says which.
- The per-site grant and its rollback both use the bootstrap application's token; every other call uses the operator's delegated token, asserted in the adapter tests.
- No hardcoded Graph app role GUID remains in the source.
- The live end-to-end run is still outstanding and is documented as such. It is the only way to exercise the client-credentials exchange and the verification call, which have never executed.
