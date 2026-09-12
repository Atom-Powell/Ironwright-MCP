# Phase 1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a connectable, stateless MCP server with all ten tools registered as honest stubs, a validated profile schema, a mechanically enforced tool-description contract, and a scripted Entra setup command, so every later phase has a running server and a test harness to build against.

**Architecture:** A single npm package with five source directories matching the layers in the design spec (`server`, `mcp`, `tools`, `domain`, `setup`). Layer boundaries are enforced by an ESLint rule rather than by workspace packaging, which keeps the build trivial while still preventing the `domain` layer from acquiring I/O dependencies. The HTTP layer takes its `McpServer` factory by injection, so request isolation is testable without test-only hooks in production code.

**Tech Stack:** Node 22+, TypeScript 5 with ESM and `NodeNext` resolution, Express 5, `@modelcontextprotocol/sdk` 1.26+, Zod 3, Vitest, Supertest, `@azure/identity` for the setup command's interactive sign-in, ESLint 9 with typescript-eslint.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=22.0.0`. TypeScript with `"type": "module"`, `module`/`moduleResolution` set to `NodeNext`, `strict: true`.
- Relative imports MUST carry a `.js` extension, including when importing a `.ts` source file. This is a `NodeNext` ESM requirement and is the most common way this project's build will break.
- `@modelcontextprotocol/sdk` at `^1.26.0` or higher. A new `McpServer` instance per HTTP request. Never reuse one across requests.
- `StreamableHTTPServerTransport` in stateless mode: `sessionIdGenerator: undefined`.
- `GET /health` stays a separate route from `POST /mcp`, because container probes are GET and MCP is POST.
- Writes are disabled by default. When writes are disabled, tools of kind `write` are NOT registered at all.
- Every tool declares all four annotations explicitly (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). No relying on SDK defaults.
- Every tool's `description` prose contains the exact safety sentence for its kind, and every tool has an `outputSchema` and returns `structuredContent`.
- Every tool input field description includes a concrete example value, not just a type restatement.
- No emojis or icons anywhere: not in code, comments, CLI output, logs, or docs.
- US English throughout.
- Comments explain why, not what. Graph and SDK quirks get a reason recorded.
- `src/domain/**` must not import from `src/server`, `src/mcp`, `src/tools`, `src/setup`, or any Azure or Graph package. It is pure.
- Profiles are deployment configuration. Only `examples/profiles/example.json` is committed. A `/profiles/` directory is git-ignored.
- License is Elastic License 2.0, already in `LICENSE`. Do not add per-file license headers.
- The error-path test suite is a CI gate. Error-path test files are named `*.errors.test.ts`.

---

### Task 1: HTTP server with a health endpoint

Carries the project scaffold, because the scaffold has no independently testable deliverable of its own.

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `.github/workflows/ci.yml`
- Create: `src/server/config.ts`, `src/server/app.ts`, `src/server/main.ts`
- Test: `tests/server/health.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env: NodeJS.ProcessEnv): ServerConfig` where `ServerConfig = { port: number; allowWrites: boolean }`. `createApp(opts: AppOptions): express.Express` where `AppOptions = { serverFactory: () => McpServer }`. The `serverFactory` field arrives in Task 2. In this task `createApp()` takes no argument at all.

- [ ] **Step 1: Initialize the package and install dependencies**

Run in the repository root:

```bash
npm init -y
npm pkg set type=module
npm pkg set engines.node=">=22.0.0"
npm pkg set name="@ironwright/repo-reconciliation-mcp"
npm pkg set version="0.1.0"
npm pkg set private=true
npm pkg delete main
npm install express@^5 zod@^3
npm install --save-dev typescript@^5 vitest supertest @types/node @types/express @types/supertest eslint typescript-eslint tsx
npm install "@modelcontextprotocol/sdk@^1.26.0"
```

- [ ] **Step 2: Verify the SDK's Zod major version matches what is installed**

Run:

```bash
node -e "const p=require('./node_modules/@modelcontextprotocol/sdk/package.json');console.log(JSON.stringify(p.peerDependencies||p.dependencies,null,2))"
npm ls zod
```

Expected: the Zod major version the SDK asks for matches the installed one. If the SDK requires a different major, install that major instead and use it consistently everywhere in this plan. A mismatch here produces confusing schema type errors much later.

- [ ] **Step 3: Write `tsconfig.json` and `tsconfig.test.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "verbatimModuleSyntax": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Then `tsconfig.test.json`. Vitest strips types without checking them, and the build config
above includes only `src`, so without this second config not one test file is ever
type-checked and a broken test assertion shows up as a runtime failure instead of a
compile error.

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": ".", "noEmit": true },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 5: Write `.gitignore`**

```gitignore
node_modules/
dist/
coverage/
*.log

# Scratch space for plan-execution artifacts (briefs, reports, review packages).
.superpowers/

# Profiles carry real site IDs, client names, and workbook paths. They are
# deployment configuration and never belong in this repository. The synthetic
# example under examples/profiles/ is the only committed profile.
/profiles/

.env
.env.*
!.env.example
```

- [ ] **Step 6: Add npm scripts**

```bash
npm pkg set scripts.build="tsc -p tsconfig.json"
npm pkg set scripts.typecheck="tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json"
npm pkg set scripts.lint="eslint ."
npm pkg set scripts.test="vitest run"
npm pkg set scripts.test:errors="vitest run .errors.test"
npm pkg set scripts.dev="tsx watch src/server/main.ts"
npm pkg set scripts.start="node dist/server/main.js"
npm pkg set scripts.setup="tsx src/setup/main.ts"
```

`test:errors` exists as a separate gate because Vitest exits non-zero when a filter matches no files. That makes "somebody deleted or never wrote the error-path tests" a loud CI failure rather than a silent one.

- [ ] **Step 7: Write `eslint.config.js`**

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Underscore-prefixed parameters are deliberate placeholders: a signature
      // fixed early so later tasks do not have to touch every call site.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      // The domain layer is pure: no I/O, no transport, no Azure, no Graph.
      // This is what lets the entire reconciliation engine be tested against
      // fixtures before any tenant access exists.
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/server/**", "**/mcp/**", "**/tools/**", "**/setup/**"], message: "The domain layer must not depend on transport, tool, or setup layers." },
          { group: ["@azure/*", "@microsoft/*", "express"], message: "The domain layer must stay free of I/O dependencies." },
        ],
      }],
    },
  },
);
```

- [ ] **Step 8: Write the failing test**

Create `tests/server/health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/server/app.js";

describe("GET /health", () => {
  it("returns 200 with a status body", async () => {
    const response = await request(createApp()).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("does not accept POST", async () => {
    const response = await request(createApp()).post("/health");

    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `npx vitest run tests/server/health.test.ts`
Expected: FAIL, unable to resolve `../../src/server/app.js`.

- [ ] **Step 10: Write `src/server/config.ts`**

```ts
export interface ServerConfig {
  port: number;
  allowWrites: boolean;
}

/**
 * Writes default to disabled. An operator has to opt a deployment in, which is
 * the first of the two independent write gates; the per-call confirm flag is the
 * second. Copilot Studio's DLP granularity is per-server rather than per-tool,
 * so neither gate can be delegated to the platform.
 */
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const rawPort = env.PORT ?? "3000";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${rawPort}"`);
  }

  return { port, allowWrites: env.IW_ALLOW_WRITES === "true" };
}
```

- [ ] **Step 11: Write `src/server/app.ts`**

```ts
import express from "express";

export function createApp(): express.Express {
  const app = express();

  // Kept separate from the MCP route because container probes issue GET and the
  // MCP endpoint only answers POST.
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  return app;
}
```

- [ ] **Step 12: Write `src/server/main.ts`**

```ts
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const app = createApp();

app.listen(config.port, () => {
  console.log(`listening on port ${config.port}, writes ${config.allowWrites ? "enabled" : "disabled"}`);
});
```

- [ ] **Step 13: Run the test to verify it passes**

Run: `npx vitest run tests/server/health.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 14: Write the CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      # Separate gate: Vitest exits non-zero when this filter matches no files,
      # so deleting the error-path suite fails the build instead of passing quietly.
      - run: npm run test:errors
```

- [ ] **Step 15: Verify the full gate sequence locally**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all three succeed. `npm run test:errors` will fail at this point with "No test files found", which is correct: the first error-path test arrives in Task 2.

- [ ] **Step 16: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.test.json vitest.config.ts eslint.config.js .gitignore .github src tests
git commit -m "feat: scaffold TypeScript MCP server with health endpoint and CI"
```

---

### Task 2: Stateless MCP endpoint with per-request server instances

**Files:**
- Create: `src/mcp/build-server.ts`
- Modify: `src/server/app.ts`, `src/server/main.ts`
- Test: `tests/server/mcp-transport.test.ts`, `tests/server/isolation.errors.test.ts`

**Interfaces:**
- Consumes: `createApp` from Task 1, which gains a required options argument here.
- Produces: `buildServer(opts: BuildServerOptions): McpServer` where `BuildServerOptions = { allowWrites: boolean }`. `createApp(opts: AppOptions): express.Express` where `AppOptions = { serverFactory: () => McpServer }`.

- [ ] **Step 1: Write the failing transport test**

Create `tests/server/mcp-transport.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createApp } from "../../src/server/app.js";

function probeServerFactory(): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool(
    "probe",
    {
      title: "Probe",
      description: "Test-only probe tool.",
      inputSchema: { value: z.string() },
      outputSchema: { echoed: z.string() },
    },
    ({ value }) => ({
      structuredContent: { echoed: value },
      content: [{ type: "text" as const, text: value }],
    }),
  );
  return server;
}

describe("POST /mcp", () => {
  let httpServer: Server;
  let baseUrl: URL;

  beforeEach(async () => {
    const app = createApp({ serverFactory: probeServerFactory });
    httpServer = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const address = httpServer.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("lists tools and calls one over Streamable HTTP", async () => {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(baseUrl));

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("probe");

    const called = await client.callTool({ name: "probe", arguments: { value: "hello" } });
    expect(called.structuredContent).toEqual({ echoed: "hello" });

    await client.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/server/mcp-transport.test.ts`
Expected: FAIL, `createApp` does not accept an argument and there is no `/mcp` route.

- [ ] **Step 3: Write `src/mcp/build-server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface BuildServerOptions {
  allowWrites: boolean;
}

export const SERVER_NAME = "ironwright-repo-reconciliation";
export const SERVER_VERSION = "0.1.0";

/**
 * Builds a fresh server. Callers must build one per HTTP request: SDK versions
 * from 1.26 onward treat a reused instance as a cross-request data leak risk,
 * and stateless mode has no session to scope state to.
 */
export function buildServer(_opts: BuildServerOptions): McpServer {
  return new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
}
```

The unused parameter is deliberate. Tool registration lands in Task 4, and the signature is fixed now so no later task has to change every call site.

- [ ] **Step 4: Rewrite `src/server/app.ts`**

```ts
import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface AppOptions {
  /**
   * Injected rather than imported so request isolation can be tested with a
   * probe server, without shipping test-only branches in production code.
   */
  serverFactory: () => McpServer;
}

export function createApp(opts: AppOptions): express.Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/mcp", express.json({ limit: "4mb" }), async (req, res) => {
    const server = opts.serverFactory();
    // Stateless: no session id generator, so the transport never retains
    // per-client state between requests and the service scales behind a plain
    // load balancer with no session affinity.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: error instanceof Error ? error.message : "internal error" },
          id: null,
        });
      }
    }
  });

  return app;
}
```

- [ ] **Step 5: Update `src/server/main.ts`**

```ts
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "../mcp/build-server.js";

const config = loadConfig(process.env);
const app = createApp({
  serverFactory: () => buildServer({ allowWrites: config.allowWrites }),
});

app.listen(config.port, () => {
  console.log(`listening on port ${config.port}, writes ${config.allowWrites ? "enabled" : "disabled"}`);
});
```

- [ ] **Step 6: Update the health test for the new signature**

In `tests/server/health.test.ts`, replace both `createApp()` calls with `createApp({ serverFactory: () => new McpServer({ name: "test", version: "0.0.0" }) })` and add the import:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/server`
Expected: PASS, 3 tests.

- [ ] **Step 8: Write the failing isolation error-path test**

Create `tests/server/isolation.errors.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createApp } from "../../src/server/app.js";

/**
 * Each factory call closes over its own counter. If the HTTP layer ever reuses
 * one server instance across requests, a second caller sees a count above one.
 * That contamination is silent in production, so it gets an explicit test.
 */
function countingServerFactory(): McpServer {
  let callCount = 0;
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool(
    "count",
    {
      title: "Count",
      description: "Test-only instance-scoped counter.",
      inputSchema: {},
      outputSchema: { callCount: z.number() },
    },
    () => {
      callCount += 1;
      return {
        structuredContent: { callCount },
        content: [{ type: "text" as const, text: String(callCount) }],
      };
    },
  );
  return server;
}

describe("request isolation", () => {
  let httpServer: Server;
  let baseUrl: URL;

  beforeEach(async () => {
    const app = createApp({ serverFactory: countingServerFactory });
    httpServer = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const address = httpServer.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("does not accumulate state across concurrent requests", async () => {
    const clients = await Promise.all(
      [0, 1].map(async () => {
        const client = new Client({ name: "test-client", version: "0.0.0" });
        await client.connect(new StreamableHTTPClientTransport(baseUrl));
        return client;
      }),
    );

    const results = await Promise.all(clients.map((client) => client.callTool({ name: "count", arguments: {} })));

    for (const result of results) {
      expect(result.structuredContent).toEqual({ callCount: 1 });
    }

    await Promise.all(clients.map((client) => client.close()));
  });
});
```

- [ ] **Step 9: Run the isolation test to verify it passes**

Run: `npm run test:errors`
Expected: PASS, 1 test. This also confirms the `test:errors` CI gate now has something to run.

- [ ] **Step 10: Confirm the isolation test can actually fail**

Temporarily change `src/server/app.ts` to hoist the server outside the handler:

```ts
  const sharedServer = opts.serverFactory();
  app.post("/mcp", express.json({ limit: "4mb" }), async (req, res) => {
    const server = sharedServer;
```

Run: `npm run test:errors`
Expected: FAIL, with a received `callCount` of 2. Revert the change and re-run to confirm PASS. A test that cannot fail is not protecting anything.

- [ ] **Step 11: Commit**

```bash
git add src tests
git commit -m "feat: add stateless MCP endpoint with per-request server instances"
```

---

### Task 3: Profile schema and validator

**Files:**
- Create: `src/domain/profile/placeholders.ts`, `src/domain/profile/schema.ts`, `src/domain/profile/load.ts`
- Create: `examples/profiles/example.json`
- Test: `tests/domain/fixtures.ts`, `tests/domain/profile.test.ts`, `tests/domain/profile.errors.test.ts`

**Interfaces:**
- Consumes: nothing. This layer is pure.
- Produces: `PLACEHOLDERS: readonly string[]`, `unknownPlaceholders(template: string): string[]`, `ProfileSchema` (a Zod schema), `type Profile = z.infer<typeof ProfileSchema>`, `loadProfile(input: unknown): Profile` which throws `ProfileValidationError` with a `.issues: string[]` property.

- [ ] **Step 1: Write the failing placeholder test**

Create `tests/domain/profile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { unknownPlaceholders } from "../../src/domain/profile/placeholders.js";

describe("unknownPlaceholders", () => {
  it("accepts every supported placeholder", () => {
    expect(unknownPlaceholders("{year}-{month:02}_{client}_{deliverable}{monthName}{month}")).toEqual([]);
  });

  it("reports placeholders that are not supported", () => {
    expect(unknownPlaceholders("{year}/{quarter}/{clientName}")).toEqual(["quarter", "clientName"]);
  });

  it("ignores text outside braces", () => {
    expect(unknownPlaceholders("Reports {year}")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/domain/profile.test.ts`
Expected: FAIL, cannot resolve `placeholders.js`.

- [ ] **Step 3: Write `src/domain/profile/placeholders.ts`**

```ts
/**
 * The closed set of tokens a taxonomy segment or filename template may use.
 * Keeping it closed means a typo in a profile is a validation error rather than
 * a path that renders with a literal brace and silently never matches a file.
 */
export const PLACEHOLDERS = ["year", "month", "month:02", "monthName", "client", "deliverable"] as const;

export type Placeholder = (typeof PLACEHOLDERS)[number];

const TOKEN_PATTERN = /\{([^}]*)\}/g;

export function extractPlaceholders(template: string): string[] {
  return [...template.matchAll(TOKEN_PATTERN)].map((match) => match[1] ?? "");
}

export function unknownPlaceholders(template: string): string[] {
  const supported = new Set<string>(PLACEHOLDERS);
  return extractPlaceholders(template).filter((token) => !supported.has(token));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/domain/profile.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing schema test**

First create `tests/domain/fixtures.ts`. The fixture gets its own module because importing one test file from another registers that file's tests twice.

```ts
export const validProfile = {
  profileId: "example",
  identity: {
    siteUrl: "https://contoso.sharepoint.com/sites/Example",
    library: "Compliance Reports",
    workbookPath: "/Trackers/Operational Tracking Workbook.xlsx",
  },
  taxonomy: { segments: ["{year}", "{client}", "{month:02}-{monthName}"] },
  naming: {
    template: "{year}-{month:02}_{client}_{deliverable}.xlsx",
    recognizers: [
      {
        id: "legacy-spaced",
        pattern: "^(?<client>[A-Z0-9]+) Monthly - (?<monthName>[A-Za-z]{3,}) (?<year>\\d{4})\\.xlsx$",
        deliverable: "MonthlyTraining",
        verdict: "misnamed",
      },
    ],
  },
  deliverables: [
    {
      id: "MonthlyTraining",
      token: "MonthlyTraining",
      cadence: "monthly",
      appliesTo: { workbookField: "monthlyTraining", truthy: true },
    },
  ],
  workbookMapping: {
    source: { kind: "table", name: "ClientRoster" },
    headerRow: 1,
    columns: { client: "Client", monthlyTraining: "Monthly Training" },
  },
  window: { mode: "rolling", months: 12, respectEffectiveFrom: false },
};
```

Then append to `tests/domain/profile.test.ts`:

```ts
import { ProfileSchema } from "../../src/domain/profile/schema.js";
import { validProfile } from "./fixtures.js";

describe("ProfileSchema", () => {
  it("accepts a valid profile", () => {
    expect(() => ProfileSchema.parse(validProfile)).not.toThrow();
  });

  it("defaults periodAnchor to the last month of the period", () => {
    const parsed = ProfileSchema.parse(validProfile);
    expect(parsed.deliverables[0]?.periodAnchor).toBe("last");
  });

  it("defaults recognizers to an empty list", () => {
    const withoutRecognizers = {
      ...validProfile,
      naming: { template: validProfile.naming.template },
    };
    expect(ProfileSchema.parse(withoutRecognizers).naming.recognizers).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/domain/profile.test.ts`
Expected: FAIL, cannot resolve `schema.js`.

- [ ] **Step 7: Write `src/domain/profile/schema.ts`**

```ts
import { z } from "zod";
import { unknownPlaceholders } from "./placeholders.js";

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export const CadenceSchema = z.enum(["monthly", "quarterly", "semiannual", "annual"]);
export const PeriodAnchorSchema = z.enum(["first", "last"]);
export const VerdictSchema = z.enum(["compliant", "misnamed"]);

export const IdentitySchema = z.object({
  siteUrl: z.string().url(),
  library: z.string().min(1),
  workbookPath: z.string().startsWith("/"),
});

export const TaxonomySchema = z.object({
  segments: z.array(z.string().min(1)).min(1),
});

export const RecognizerSchema = z.object({
  id: z.string().min(1),
  pattern: z.string().min(1).refine(isValidRegex, { message: "must be a valid regular expression" }),
  deliverable: z.string().min(1),
  verdict: VerdictSchema,
});

export const NamingSchema = z.object({
  template: z.string().min(1),
  recognizers: z.array(RecognizerSchema).default([]),
});

export const DeliverableSchema = z.object({
  id: z.string().min(1),
  token: z.string().min(1),
  cadence: CadenceSchema,
  // A taxonomy with a month segment still needs one month to render for a
  // non-monthly period. "last" matches how a report covering a period is
  // produced after that period closes.
  periodAnchor: PeriodAnchorSchema.default("last"),
  appliesTo: z.object({
    workbookField: z.string().min(1),
    truthy: z.literal(true),
  }),
});

export const WorkbookMappingSchema = z.object({
  source: z.object({ kind: z.enum(["table", "worksheet"]), name: z.string().min(1) }),
  headerRow: z.number().int().positive(),
  // `client` is required; any other key is a caller-chosen field name that
  // deliverables and the window reference by key rather than by column header,
  // so renaming a spreadsheet column touches only this mapping.
  columns: z.object({ client: z.string().min(1) }).catchall(z.string().min(1)),
});

export const WindowSchema = z.object({
  mode: z.literal("rolling"),
  months: z.number().int().min(1).max(120),
  respectEffectiveFrom: z.boolean().default(false),
});

export const ProfileSchema = z
  .object({
    profileId: z.string().min(1).regex(/^[a-z0-9-]+$/, "must be lowercase letters, digits, and hyphens"),
    identity: IdentitySchema,
    taxonomy: TaxonomySchema,
    naming: NamingSchema,
    deliverables: z.array(DeliverableSchema).min(1),
    workbookMapping: WorkbookMappingSchema,
    window: WindowSchema,
  })
  .superRefine((profile, ctx) => {
    const custom = z.ZodIssueCode.custom;

    for (const token of unknownPlaceholders(profile.naming.template)) {
      ctx.addIssue({ code: custom, path: ["naming", "template"], message: `unknown placeholder {${token}}` });
    }

    profile.taxonomy.segments.forEach((segment, index) => {
      for (const token of unknownPlaceholders(segment)) {
        ctx.addIssue({ code: custom, path: ["taxonomy", "segments", index], message: `unknown placeholder {${token}}` });
      }
    });

    const deliverableIds = new Set<string>();
    profile.deliverables.forEach((deliverable, index) => {
      if (deliverableIds.has(deliverable.id)) {
        ctx.addIssue({ code: custom, path: ["deliverables", index, "id"], message: `duplicate deliverable id "${deliverable.id}"` });
      }
      deliverableIds.add(deliverable.id);
    });

    const columnKeys = new Set(Object.keys(profile.workbookMapping.columns));
    profile.deliverables.forEach((deliverable, index) => {
      if (!columnKeys.has(deliverable.appliesTo.workbookField)) {
        ctx.addIssue({
          code: custom,
          path: ["deliverables", index, "appliesTo", "workbookField"],
          message: `"${deliverable.appliesTo.workbookField}" is not a key in workbookMapping.columns`,
        });
      }
    });

    const recognizerIds = new Set<string>();
    profile.naming.recognizers.forEach((recognizer, index) => {
      if (recognizerIds.has(recognizer.id)) {
        ctx.addIssue({ code: custom, path: ["naming", "recognizers", index, "id"], message: `duplicate recognizer id "${recognizer.id}"` });
      }
      recognizerIds.add(recognizer.id);

      if (!deliverableIds.has(recognizer.deliverable)) {
        ctx.addIssue({
          code: custom,
          path: ["naming", "recognizers", index, "deliverable"],
          message: `no deliverable is declared with id "${recognizer.deliverable}"`,
        });
      }
    });

    if (profile.window.respectEffectiveFrom && !columnKeys.has("effectiveFrom")) {
      ctx.addIssue({
        code: custom,
        path: ["window", "respectEffectiveFrom"],
        message: "requires workbookMapping.columns.effectiveFrom to be mapped",
      });
    }
  });

export type Profile = z.infer<typeof ProfileSchema>;
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run tests/domain/profile.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Write the failing validation error-path test**

Create `tests/domain/profile.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ProfileValidationError, loadProfile } from "../../src/domain/profile/load.js";
import { validProfile } from "./fixtures.js";

function expectIssue(input: unknown, fragment: string): void {
  try {
    loadProfile(input);
    throw new Error("expected loadProfile to reject this profile");
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileValidationError);
    const issues = (error as ProfileValidationError).issues.join("\n");
    expect(issues).toContain(fragment);
  }
}

describe("loadProfile rejections", () => {
  it("rejects an unknown placeholder in the filename template", () => {
    expectIssue(
      { ...validProfile, naming: { ...validProfile.naming, template: "{year}_{clientName}.xlsx" } },
      "unknown placeholder {clientName}",
    );
  });

  it("rejects an unknown placeholder in a taxonomy segment", () => {
    expectIssue({ ...validProfile, taxonomy: { segments: ["{year}", "{quarter}"] } }, "unknown placeholder {quarter}");
  });

  it("rejects a recognizer pointing at an undeclared deliverable", () => {
    expectIssue(
      {
        ...validProfile,
        naming: {
          ...validProfile.naming,
          recognizers: [{ id: "orphan", pattern: "^x$", deliverable: "NoSuchDeliverable", verdict: "misnamed" }],
        },
      },
      'no deliverable is declared with id "NoSuchDeliverable"',
    );
  });

  it("rejects a deliverable whose workbookField is not a mapped column", () => {
    expectIssue(
      {
        ...validProfile,
        deliverables: [
          { ...validProfile.deliverables[0], appliesTo: { workbookField: "notMapped", truthy: true } },
        ],
      },
      '"notMapped" is not a key in workbookMapping.columns',
    );
  });

  it("rejects respectEffectiveFrom without an effectiveFrom column", () => {
    expectIssue(
      { ...validProfile, window: { mode: "rolling", months: 12, respectEffectiveFrom: true } },
      "requires workbookMapping.columns.effectiveFrom",
    );
  });

  it("rejects an invalid regular expression in a recognizer", () => {
    expectIssue(
      {
        ...validProfile,
        naming: {
          ...validProfile.naming,
          recognizers: [{ id: "bad-regex", pattern: "([unclosed", deliverable: "MonthlyTraining", verdict: "misnamed" }],
        },
      },
      "must be a valid regular expression",
    );
  });

  it("rejects duplicate deliverable ids", () => {
    expectIssue(
      { ...validProfile, deliverables: [validProfile.deliverables[0], validProfile.deliverables[0]] },
      'duplicate deliverable id "MonthlyTraining"',
    );
  });

  it("reports the failing path alongside the message", () => {
    try {
      loadProfile({ ...validProfile, profileId: "Not Valid" });
      throw new Error("expected loadProfile to reject this profile");
    } catch (error) {
      expect((error as ProfileValidationError).issues[0]).toMatch(/^profileId: /);
    }
  });
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npx vitest run tests/domain/profile.errors.test.ts`
Expected: FAIL, cannot resolve `load.js`.

- [ ] **Step 11: Write `src/domain/profile/load.ts`**

```ts
import { ProfileSchema, type Profile } from "./schema.js";

/**
 * Validation messages are the product here. A mapping mistake that slips through
 * surfaces later as a wrong compliance finding, which is far more expensive to
 * diagnose than a rejected profile, so every issue names its path.
 */
export class ProfileValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`profile is not valid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ProfileValidationError";
    this.issues = issues;
  }
}

export function loadProfile(input: unknown): Profile {
  const result = ProfileSchema.safeParse(input);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });

  throw new ProfileValidationError(issues);
}
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run tests/domain`
Expected: PASS, 14 tests.

- [ ] **Step 13: Add the committed example profile**

Create `examples/profiles/example.json` with entirely synthetic values:

```json
{
  "profileId": "example",
  "identity": {
    "siteUrl": "https://contoso.sharepoint.com/sites/Example",
    "library": "Compliance Reports",
    "workbookPath": "/Trackers/Operational Tracking Workbook.xlsx"
  },
  "taxonomy": {
    "segments": ["{year}", "{client}", "{month:02}-{monthName}"]
  },
  "naming": {
    "template": "{year}-{month:02}_{client}_{deliverable}.xlsx",
    "recognizers": [
      {
        "id": "legacy-spaced",
        "pattern": "^(?<client>[A-Z0-9]+) Monthly - (?<monthName>[A-Za-z]{3,}) (?<year>\\d{4})\\.xlsx$",
        "deliverable": "MonthlyTraining",
        "verdict": "misnamed"
      },
      {
        "id": "vendor-token",
        "pattern": "^(?<year>\\d{4})-(?<month>\\d{2})_(?<client>[^_]+)_VendorTraining\\.xlsx$",
        "deliverable": "MonthlyTraining",
        "verdict": "misnamed"
      }
    ]
  },
  "deliverables": [
    {
      "id": "MonthlyTraining",
      "token": "MonthlyTraining",
      "cadence": "monthly",
      "appliesTo": { "workbookField": "monthlyTraining", "truthy": true }
    },
    {
      "id": "QuarterlyPhishing",
      "token": "QuarterlyPhishing",
      "cadence": "quarterly",
      "periodAnchor": "last",
      "appliesTo": { "workbookField": "quarterlyPhishing", "truthy": true }
    }
  ],
  "workbookMapping": {
    "source": { "kind": "table", "name": "ClientRoster" },
    "headerRow": 1,
    "columns": {
      "client": "Client",
      "monthlyTraining": "Monthly Training",
      "quarterlyPhishing": "Quarterly Phishing",
      "effectiveFrom": "Onboarded"
    }
  },
  "window": { "mode": "rolling", "months": 12, "respectEffectiveFrom": true }
}
```

- [ ] **Step 14: Write a test that the committed example validates**

Append to `tests/domain/profile.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { loadProfile } from "../../src/domain/profile/load.js";

describe("examples/profiles/example.json", () => {
  it("is a valid profile", () => {
    const raw: unknown = JSON.parse(readFileSync("examples/profiles/example.json", "utf8"));
    expect(() => loadProfile(raw)).not.toThrow();
  });
});
```

- [ ] **Step 15: Run the test to verify it passes**

Run: `npx vitest run tests/domain`
Expected: PASS, 15 tests. If this fails, the example profile and the schema disagree and the example is the thing to fix.

- [ ] **Step 16: Verify the domain purity lint rule actually fires**

Temporarily add to the top of `src/domain/profile/load.ts`:

```ts
import express from "express";
```

Run: `npm run lint`
Expected: FAIL with "The domain layer must stay free of I/O dependencies." Remove the import and re-run to confirm PASS.

- [ ] **Step 17: Commit**

```bash
git add src tests examples
git commit -m "feat: add profile schema with cross-field validation and a synthetic example"
```

---

### Task 4: Tool contract rules and registry

**Files:**
- Create: `src/tools/kinds.ts`, `src/tools/types.ts`, `src/tools/stub-output.ts`, `src/tools/registry.ts`
- Create: `src/tools/definitions/inventory-tree.ts`, `src/tools/definitions/generate-rename-plan.ts`, `src/tools/definitions/execute-rename-plan.ts`
- Modify: `src/mcp/build-server.ts`
- Test: `tests/tools/contract.test.ts`

**Interfaces:**
- Consumes: `buildServer` from Task 2.
- Produces: `type ToolKind = "read" | "plan" | "write"`, `requiredSentence(kind: ToolKind, destructive: boolean): string`, `interface ToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }`, `interface ToolDefinition { name: string; kind: ToolKind; title: string; description: string; annotations: ToolAnnotations; inputSchema: z.ZodRawShape; outputSchema: z.ZodRawShape }`, `ALL_TOOLS: ToolDefinition[]`, `selectTools(allowWrites: boolean): ToolDefinition[]`.

- [ ] **Step 1: Write the failing contract test**

Create `tests/tools/contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../../src/tools/registry.js";
import { requiredSentence } from "../../src/tools/kinds.js";

describe("tool contract", () => {
  it("registers at least one tool", () => {
    expect(ALL_TOOLS.length).toBeGreaterThan(0);
  });

  it.each(ALL_TOOLS)("$name uses snake_case", (tool) => {
    expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it.each(ALL_TOOLS)("$name sets all four annotations", (tool) => {
    expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
    expect(typeof tool.annotations.destructiveHint).toBe("boolean");
    expect(typeof tool.annotations.idempotentHint).toBe("boolean");
    expect(typeof tool.annotations.openWorldHint).toBe("boolean");
  });

  it.each(ALL_TOOLS)(
    "$name has annotations consistent with its kind",
    (tool) => {
      if (tool.kind === "read") {
        expect(tool.annotations.readOnlyHint).toBe(true);
        expect(tool.annotations.destructiveHint).toBe(false);
      } else {
        expect(tool.annotations.readOnlyHint).toBe(false);
      }
      if (tool.kind === "plan") {
        expect(tool.annotations.destructiveHint).toBe(false);
      }
    },
  );

  it.each(ALL_TOOLS)(
    "$name states its safety status in the description prose",
    (tool) => {
      // An automated survey of 856 published MCP tools found 97 percent had at
      // least one description defect, most commonly not stating read-only or
      // destructive status. A name implying safety is not a description saying it.
      expect(tool.description).toContain(requiredSentence(tool.kind, tool.annotations.destructiveHint));
    },
  );

  it.each(ALL_TOOLS)("$name declares an output schema", (tool) => {
    expect(Object.keys(tool.outputSchema).length).toBeGreaterThan(0);
  });

  it.each(ALL_TOOLS)(
    "$name describes every input field with an example",
    (tool) => {
      for (const [field, schema] of Object.entries(tool.inputSchema)) {
        const description = schema.description;
        expect(description, `${tool.name}.${field} has no description`).toBeDefined();
        expect(description, `${tool.name}.${field} description gives no example`).toMatch(/for example/i);
      }
    },
  );

  it("has no duplicate tool names", () => {
    const names = ALL_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools/contract.test.ts`
Expected: FAIL, cannot resolve `registry.js`.

- [ ] **Step 3: Write `src/tools/kinds.ts`**

```ts
export type ToolKind = "read" | "plan" | "write";

/**
 * Fixed sentences rather than free prose, so the contract test can assert the
 * description actually says what the annotations claim. `plan` is a third kind
 * on purpose: a plan generator writes a plan to the state store, so calling it
 * read-only would be exactly the decorative annotation this project avoids.
 */
export const SAFETY_SENTENCES = {
  read: "Read-only: this tool makes no changes and is safe to repeat.",
  plan:
    "Not read-only: this tool saves a plan for review. It makes no changes to the repository, and repeated calls create separate plans.",
  destructiveWrite:
    "Destructive: this tool changes the repository when confirmed. It defaults to a dry run, and repeated calls are not idempotent.",
  additiveWrite:
    "Not read-only: this tool creates missing items in the repository when confirmed. It defaults to a dry run and skips items that already exist.",
} as const;

export function requiredSentence(kind: ToolKind, destructive: boolean): string {
  if (kind === "read") return SAFETY_SENTENCES.read;
  if (kind === "plan") return SAFETY_SENTENCES.plan;
  return destructive ? SAFETY_SENTENCES.destructiveWrite : SAFETY_SENTENCES.additiveWrite;
}
```

- [ ] **Step 4: Write the tool types, the shared stub output schema, and the registry**

`src/tools/types.ts` holds the shared types so the definition modules never import from
`registry.ts`, which imports them. `import type` is erased at compile time so a cycle would
not break at runtime, but a real cycle is easy to turn into a broken one later.

```ts
import type { z } from "zod";
import type { ToolKind } from "./kinds.js";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  kind: ToolKind;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
}
```

`src/tools/stub-output.ts`:

```ts
import { z } from "zod";

/**
 * Shared placeholder output. Every tool declares a real outputSchema from the
 * start so callers always receive structuredContent, and later phases replace
 * this one tool at a time rather than adding output contracts retroactively.
 */
export const STUB_OUTPUT_SCHEMA = {
  stub: z.literal(true).describe("Always true until this tool is implemented, for example true."),
  message: z
    .string()
    .describe("Note explaining that the tool is registered but not implemented, for example \"inventory_tree is not implemented yet\"."),
} satisfies z.ZodRawShape;
```

`src/tools/registry.ts`:

```ts
import type { ToolDefinition } from "./types.js";
import { inventoryTree } from "./definitions/inventory-tree.js";
import { generateRenamePlan } from "./definitions/generate-rename-plan.js";
import { executeRenamePlan } from "./definitions/execute-rename-plan.js";

export type { ToolAnnotations, ToolDefinition } from "./types.js";

export const ALL_TOOLS: ToolDefinition[] = [inventoryTree, generateRenamePlan, executeRenamePlan];

/**
 * Write tools are omitted rather than registered and refused. A refusal leaves a
 * model that still believes the capability exists and retries differently; an
 * absent tool is simply not in its options.
 */
export function selectTools(allowWrites: boolean): ToolDefinition[] {
  return allowWrites ? ALL_TOOLS : ALL_TOOLS.filter((tool) => tool.kind !== "write");
}
```

- [ ] **Step 5: Write `src/tools/definitions/inventory-tree.ts`**

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const inventoryTree: ToolDefinition = {
  name: "inventory_tree",
  kind: "read",
  title: "Inventory repository tree",
  description: [
    "Return the complete folder and file tree of a configured document library in one call, including path, name, type, size, and modified date for every item.",
    "Uses delta query and batched requests internally instead of a recursive per-folder walk, so a full inventory costs a small bounded number of requests rather than hundreds.",
    "Use this when you need what the repository actually contains. Do not use it to decide whether a required report exists, because a folder can exist while the report is stored elsewhere; use reconcile_workbook_vs_repository for that.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to inventory, for example \"example\"."),
    subPath: z
      .string()
      .optional()
      .describe("Library-relative path to limit the scan, for example \"2026/CLIENTA\". Omit to scan the whole library."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
```

- [ ] **Step 6: Write `src/tools/definitions/generate-rename-plan.ts`**

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const generateRenamePlan: ToolDefinition = {
  name: "generate_rename_plan",
  kind: "plan",
  title: "Generate a rename plan",
  description: [
    "Produce a reviewable plan that renames files violating the profile's filename standard, one entry per file, each recording the current name, the proposed name, and the file's current ETag.",
    "Returns a plan id that execute_rename_plan consumes. Review the plan before executing it.",
    SAFETY_SENTENCES.plan,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to plan against, for example \"example\"."),
    clients: z
      .array(z.string().min(1))
      .optional()
      .describe("Limit the plan to these clients, for example [\"CLIENTA\"]. Omit to cover every client in the workbook."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
```

- [ ] **Step 7: Write `src/tools/definitions/execute-rename-plan.ts`**

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const executeRenamePlan: ToolDefinition = {
  name: "execute_rename_plan",
  kind: "write",
  title: "Execute a rename plan",
  description: [
    "Apply a previously generated rename plan by its plan id, writing a reversal log before any change so the batch can be rolled back through this same tool.",
    "Each rename carries the ETag recorded at plan time, so a file edited since planning is reported as skipped rather than overwritten.",
    "Runs as a dry run unless confirm is true.",
    SAFETY_SENTENCES.destructiveWrite,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    planId: z.string().min(1).describe("Plan id returned by generate_rename_plan, for example \"rnm-2026-09-11-a3f2\"."),
    confirm: z
      .boolean()
      .default(false)
      .describe("Set true to apply the plan for real, for example true. Leave false or omit for a dry run."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
```

- [ ] **Step 8: Run the contract test to verify it passes**

Run: `npx vitest run tests/tools/contract.test.ts`
Expected: PASS.

- [ ] **Step 9: Register tools in `src/mcp/build-server.ts`**

Replace the file body:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { selectTools } from "../tools/registry.js";

export interface BuildServerOptions {
  allowWrites: boolean;
}

export const SERVER_NAME = "ironwright-repo-reconciliation";
export const SERVER_VERSION = "0.1.0";

/**
 * Builds a fresh server. Callers must build one per HTTP request: SDK versions
 * from 1.26 onward treat a reused instance as a cross-request data leak risk,
 * and stateless mode has no session to scope state to.
 */
export function buildServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of selectTools(opts.allowWrites)) {
    const message = `${tool.name} is registered but not implemented yet.`;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      () => ({
        structuredContent: { stub: true as const, message },
        content: [{ type: "text" as const, text: message }],
      }),
    );
  }

  return server;
}
```

- [ ] **Step 10: Verify the whole suite and the build**

Run: `npm run typecheck && npm test && npm run lint`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add src tests
git commit -m "feat: add tool registry with a mechanically enforced description contract"
```

---

### Task 5: Remaining seven tool definitions

**Files:**
- Create: `src/tools/definitions/describe-workbook.ts`, `reconcile.ts`, `query-repository.ts`, `validate-structure.ts`, `generate-move-plan.ts`, `execute-move-plan.ts`, `replicate-template.ts` (all under `src/tools/definitions/`)
- Modify: `src/tools/registry.ts`
- Test: `tests/tools/contract.test.ts` (add a completeness assertion)

**Interfaces:**
- Consumes: `ToolDefinition`, `SAFETY_SENTENCES`, `STUB_OUTPUT_SCHEMA` from Task 4.
- Produces: seven exported `ToolDefinition` constants named `describeWorkbook`, `reconcileWorkbookVsRepository`, `queryRepository`, `validateStructure`, `generateMovePlan`, `executeMovePlan`, `replicateTemplate`.

- [ ] **Step 1: Write the failing completeness test**

Append to `tests/tools/contract.test.ts`:

```ts
const EXPECTED_TOOL_NAMES = [
  "inventory_tree",
  "describe_workbook",
  "reconcile_workbook_vs_repository",
  "query_repository",
  "validate_structure",
  "generate_rename_plan",
  "execute_rename_plan",
  "generate_move_plan",
  "execute_move_plan",
  "replicate_template",
];

describe("tool surface completeness", () => {
  it("registers exactly the ten planned tools", () => {
    expect(ALL_TOOLS.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("stays inside the recommended per-agent tool ceiling", () => {
    // Microsoft's guidance is at most 25 to 30 tools per agent under a 128 hard
    // cap, and this server may share an agent with other MCP servers.
    expect(ALL_TOOLS.length).toBeLessThanOrEqual(25);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools/contract.test.ts`
Expected: FAIL, the registry has 3 tools and the expected list has 10.

- [ ] **Step 3: Write `src/tools/definitions/describe-workbook.ts`**

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const describeWorkbook: ToolDefinition = {
  name: "describe_workbook",
  kind: "read",
  title: "Describe a tracking workbook",
  description: [
    "Inspect a tracking workbook and propose a candidate profile mapping, reporting the worksheets, tables, named ranges, detected header rows, and inferred column types it found.",
    "Use this when onboarding a new repository or when a workbook's layout has changed. The proposal is for a human to review and commit as profile configuration; this tool does not change the profile.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    siteUrl: z
      .string()
      .url()
      .describe("Site holding the workbook, for example \"https://contoso.sharepoint.com/sites/Example\"."),
    workbookPath: z
      .string()
      .startsWith("/")
      .describe("Library-relative path to the workbook, for example \"/Trackers/Operational Tracking Workbook.xlsx\"."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
```

- [ ] **Step 4: Write `src/tools/definitions/reconcile.ts`**

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const reconcileWorkbookVsRepository: ToolDefinition = {
  name: "reconcile_workbook_vs_repository",
  kind: "read",
  title: "Reconcile workbook against repository",
  description: [
    "Compare what the tracking workbook says should exist against what the repository actually contains, and return a per-client gap report classifying every expected deliverable as compliant, misnamed, misplaced, both, or missing, plus any orphaned files and empty folders.",
    "This is the primary tool for compliance questions. Use it instead of inventory_tree whenever the question is whether required reports exist, because a folder can exist while its report is stored somewhere else entirely.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to reconcile, for example \"example\"."),
    clients: z
      .array(z.string().min(1))
      .optional()
      .describe("Limit the report to these clients, for example [\"CLIENTA\"]. Omit to cover every client in the workbook."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
```

- [ ] **Step 5: Write `src/tools/definitions/query-repository.ts`**

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const queryRepository: ToolDefinition = {
  name: "query_repository",
  kind: "read",
  title: "Query the repository index",
  description: [
    "Answer operational questions from the stored repository index: empty folders, orphaned files, naming violations, non-compliant clients, and recently modified reports.",
    "Costs no new requests against SharePoint when the index is fresh, so prefer it over inventory_tree for repeated questions. Results are as current as the last inventory, which the response reports.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to query, for example \"example\"."),
    question: z
      .enum(["empty_folders", "orphaned_files", "naming_violations", "non_compliant_clients", "recent_reports"])
      .describe("Which stored question to answer, for example \"empty_folders\"."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
```

- [ ] **Step 6: Write `src/tools/definitions/validate-structure.ts`**

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const validateStructure: ToolDefinition = {
  name: "validate_structure",
  kind: "read",
  title: "Validate client folder structure",
  description: [
    "Check one or more clients against the profile's folder taxonomy and filename standard, returning compliant, non-compliant, or missing along with the specific folders and files responsible for the verdict.",
    "Use this to confirm a client is a safe template source before replicating its structure elsewhere.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to validate against, for example \"example\"."),
    clients: z
      .array(z.string().min(1))
      .optional()
      .describe("Clients to validate, for example [\"CLIENTA\"]. Omit to validate every client in the workbook."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
```

- [ ] **Step 7: Write `src/tools/definitions/generate-move-plan.ts`**

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const generateMovePlan: ToolDefinition = {
  name: "generate_move_plan",
  kind: "plan",
  title: "Generate a move plan",
  description: [
    "Produce a reviewable plan that relocates misplaced files into the folder the profile taxonomy requires, one entry per file, each recording the current path, the target path, and the file's current ETag.",
    "Returns a plan id that execute_move_plan consumes. Review the plan before executing it.",
    SAFETY_SENTENCES.plan,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to plan against, for example \"example\"."),
    scope: z
      .enum(["all", "client", "deliverable"])
      .default("all")
      .describe("How to narrow the plan, for example \"client\"."),
    scopeValue: z
      .string()
      .min(1)
      .optional()
      .describe("Value for the chosen scope, for example \"CLIENTA\" when scope is \"client\". Omit when scope is \"all\"."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
```

- [ ] **Step 8: Write `src/tools/definitions/execute-move-plan.ts`**

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const executeMovePlan: ToolDefinition = {
  name: "execute_move_plan",
  kind: "write",
  title: "Execute a move plan",
  description: [
    "Apply a previously generated move plan by its plan id, writing a reversal log before any change so the batch can be rolled back through this same tool.",
    "Each move carries the ETag recorded at plan time, so a file edited since planning is reported as skipped rather than overwritten. Moves that cross document libraries complete asynchronously and are polled to a final state, so per-item status is reported rather than assumed.",
    "Runs as a dry run unless confirm is true.",
    SAFETY_SENTENCES.destructiveWrite,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    planId: z.string().min(1).describe("Plan id returned by generate_move_plan, for example \"mov-2026-09-11-71bc\"."),
    confirm: z
      .boolean()
      .default(false)
      .describe("Set true to apply the plan for real, for example true. Leave false or omit for a dry run."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
```

- [ ] **Step 9: Write `src/tools/definitions/replicate-template.ts`**

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const replicateTemplate: ToolDefinition = {
  name: "replicate_template",
  kind: "write",
  title: "Replicate a client folder structure",
  description: [
    "Copy a validated client's folder structure onto other clients, creating only the folders that are missing and leaving existing folders and all file content untouched.",
    "Validates the source client internally first and refuses to run when the source is itself non-compliant, so a bad structure cannot be propagated. Runs as a dry run unless confirm is true.",
    SAFETY_SENTENCES.additiveWrite,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to operate on, for example \"example\"."),
    sourceClient: z
      .string()
      .min(1)
      .describe("Client whose structure is the template, for example \"CLIENTB\". Must pass validate_structure."),
    targetClients: z
      .array(z.string().min(1))
      .min(1)
      .describe("Clients to apply the structure to, for example [\"CLIENTA\"]."),
    confirm: z
      .boolean()
      .default(false)
      .describe("Set true to create folders for real, for example true. Leave false or omit for a dry run."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
```

- [ ] **Step 10: Register all ten tools in `src/tools/registry.ts`**

Replace the imports and `ALL_TOOLS`:

```ts
import { inventoryTree } from "./definitions/inventory-tree.js";
import { describeWorkbook } from "./definitions/describe-workbook.js";
import { reconcileWorkbookVsRepository } from "./definitions/reconcile.js";
import { queryRepository } from "./definitions/query-repository.js";
import { validateStructure } from "./definitions/validate-structure.js";
import { generateRenamePlan } from "./definitions/generate-rename-plan.js";
import { executeRenamePlan } from "./definitions/execute-rename-plan.js";
import { generateMovePlan } from "./definitions/generate-move-plan.js";
import { executeMovePlan } from "./definitions/execute-move-plan.js";
import { replicateTemplate } from "./definitions/replicate-template.js";
```

```ts
export const ALL_TOOLS: ToolDefinition[] = [
  inventoryTree,
  describeWorkbook,
  reconcileWorkbookVsRepository,
  queryRepository,
  validateStructure,
  generateRenamePlan,
  executeRenamePlan,
  generateMovePlan,
  executeMovePlan,
  replicateTemplate,
];
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npx vitest run tests/tools/contract.test.ts`
Expected: PASS. Every one of the ten tools satisfies the annotation, description, output schema, and input-example assertions.

- [ ] **Step 12: Run the whole gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 13: Commit**

```bash
git add src tests
git commit -m "feat: define the remaining seven tool stubs"
```

---

### Task 6: Deployment write gate

**Files:**
- Modify: none of `src` if Task 4's `selectTools` is already correct; this task proves it end to end through the HTTP layer.
- Test: `tests/tools/write-gate.test.ts`, `tests/server/write-gate.errors.test.ts`

**Interfaces:**
- Consumes: `selectTools` and `ALL_TOOLS` from Task 4, `buildServer` from Task 2, `createApp` from Task 2, `loadConfig` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing unit test**

Create `tests/tools/write-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ALL_TOOLS, selectTools } from "../../src/tools/registry.js";
import { loadConfig } from "../../src/server/config.js";

describe("selectTools", () => {
  it("omits every write tool when writes are disabled", () => {
    const selected = selectTools(false);
    expect(selected.some((tool) => tool.kind === "write")).toBe(false);
  });

  it("keeps plan tools when writes are disabled, since a plan is reviewable on its own", () => {
    const selected = selectTools(false);
    expect(selected.filter((tool) => tool.kind === "plan").length).toBeGreaterThan(0);
  });

  it("keeps every tool when writes are enabled", () => {
    expect(selectTools(true)).toHaveLength(ALL_TOOLS.length);
  });
});

describe("loadConfig write gate", () => {
  it("disables writes when the variable is absent", () => {
    expect(loadConfig({}).allowWrites).toBe(false);
  });

  it("disables writes for any value other than the exact string true", () => {
    for (const value of ["false", "1", "yes", "TRUE", "True", ""]) {
      expect(loadConfig({ IW_ALLOW_WRITES: value }).allowWrites, `value "${value}"`).toBe(false);
    }
  });

  it("enables writes only for the exact string true", () => {
    expect(loadConfig({ IW_ALLOW_WRITES: "true" }).allowWrites).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify the result**

Run: `npx vitest run tests/tools/write-gate.test.ts`
Expected: PASS. If any assertion fails, fix `selectTools` or `loadConfig` rather than the test. The `"TRUE"` and `"1"` cases are deliberate: a gate that accepts loose truthiness will eventually be switched on by accident.

- [ ] **Step 3: Write the failing end-to-end error-path test**

Create `tests/server/write-gate.errors.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../../src/server/app.js";
import { buildServer } from "../../src/mcp/build-server.js";

let httpServer: Server | undefined;

async function startServer(allowWrites: boolean): Promise<URL> {
  const app = createApp({ serverFactory: () => buildServer({ allowWrites }) });
  httpServer = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function listToolNames(baseUrl: URL): Promise<string[]> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(baseUrl));
  const listed = await client.listTools();
  await client.close();
  return listed.tools.map((tool) => tool.name);
}

afterEach(async () => {
  if (httpServer !== undefined) {
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    httpServer = undefined;
  }
});

describe("write gate over the wire", () => {
  it("does not advertise write tools when writes are disabled", async () => {
    const names = await listToolNames(await startServer(false));

    expect(names).toContain("reconcile_workbook_vs_repository");
    expect(names).toContain("generate_rename_plan");
    expect(names).not.toContain("execute_rename_plan");
    expect(names).not.toContain("execute_move_plan");
    expect(names).not.toContain("replicate_template");
  });

  it("rejects calling a write tool that was never registered", async () => {
    const baseUrl = await startServer(false);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(baseUrl));

    await expect(
      client.callTool({ name: "execute_rename_plan", arguments: { planId: "rnm-1", confirm: true } }),
    ).rejects.toThrow();

    await client.close();
  });

  it("advertises write tools when writes are enabled", async () => {
    const names = await listToolNames(await startServer(true));

    expect(names).toContain("execute_rename_plan");
    expect(names).toContain("execute_move_plan");
    expect(names).toContain("replicate_template");
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:errors`
Expected: PASS. Both error-path files run: request isolation and the write gate.

- [ ] **Step 5: Run the whole gate**

Run: `npm run typecheck && npm run lint && npm test && npm run test:errors`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tests
git commit -m "test: prove the deployment write gate end to end"
```

---

### Task 7: Setup command pure steps

**Files:**
- Create: `src/setup/steps.ts`
- Test: `tests/setup/steps.test.ts`, `tests/setup/steps.errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildAppRegistrationRequest(displayName: string): AppRegistrationRequest`, `buildSitePermissionRequest(args: { appId: string; appDisplayName: string; write: boolean }): SitePermissionRequest`, `siteIdPathFromUrl(siteUrl: string): string`, `interpretVerification(status: number, body: string): VerificationOutcome`, plus the three exported types.

- [ ] **Step 1: Write the failing test**

Create `tests/setup/steps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildAppRegistrationRequest,
  buildSitePermissionRequest,
  interpretVerification,
  siteIdPathFromUrl,
} from "../../src/setup/steps.js";

describe("buildAppRegistrationRequest", () => {
  it("requests a single-tenant confidential client", () => {
    expect(buildAppRegistrationRequest("Ironwright Reconciliation")).toEqual({
      displayName: "Ironwright Reconciliation",
      signInAudience: "AzureADMyOrg",
    });
  });
});

describe("buildSitePermissionRequest", () => {
  it("grants write access to one application identity", () => {
    expect(buildSitePermissionRequest({ appId: "11111111-1111-1111-1111-111111111111", appDisplayName: "App", write: true })).toEqual({
      roles: ["write"],
      grantedToIdentities: [{ application: { id: "11111111-1111-1111-1111-111111111111", displayName: "App" } }],
    });
  });

  it("grants read access when write is not requested", () => {
    const request = buildSitePermissionRequest({ appId: "abc", appDisplayName: "App", write: false });
    expect(request.roles).toEqual(["read"]);
  });
});

describe("siteIdPathFromUrl", () => {
  it("converts a site URL into the Graph host and server-relative path form", () => {
    expect(siteIdPathFromUrl("https://contoso.sharepoint.com/sites/Example")).toBe(
      "contoso.sharepoint.com:/sites/Example",
    );
  });

  it("drops a trailing slash", () => {
    expect(siteIdPathFromUrl("https://contoso.sharepoint.com/sites/Example/")).toBe(
      "contoso.sharepoint.com:/sites/Example",
    );
  });
});

describe("interpretVerification", () => {
  it("treats 200 as success", () => {
    expect(interpretVerification(200, "{}")).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/setup/steps.test.ts`
Expected: FAIL, cannot resolve `steps.js`.

- [ ] **Step 3: Write `src/setup/steps.ts`**

```ts
export interface AppRegistrationRequest {
  displayName: string;
  signInAudience: "AzureADMyOrg";
}

export interface SitePermissionRequest {
  roles: string[];
  grantedToIdentities: { application: { id: string; displayName: string } }[];
}

export type VerificationOutcome =
  | { ok: true }
  | { ok: false; reason: "grant-missing" | "token" | "not-found" | "unknown"; message: string };

/**
 * One instance serves one customer tenant, so the app is single-tenant. A
 * multi-tenant audience would imply a cross-tenant consent story this product
 * deliberately does not have.
 */
export function buildAppRegistrationRequest(displayName: string): AppRegistrationRequest {
  return { displayName, signInAudience: "AzureADMyOrg" };
}

export function buildSitePermissionRequest(args: {
  appId: string;
  appDisplayName: string;
  write: boolean;
}): SitePermissionRequest {
  return {
    roles: [args.write ? "write" : "read"],
    grantedToIdentities: [{ application: { id: args.appId, displayName: args.appDisplayName } }],
  };
}

export function siteIdPathFromUrl(siteUrl: string): string {
  const url = new URL(siteUrl);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.host}:${path}`;
}

/**
 * Sites.Selected access needs a per-site grant after the app registration
 * exists. Skipping it produces a 403 that reads like a broken registration, so
 * the 403 message names the grant explicitly. This mapping is the whole reason
 * the setup command exists rather than another app-registration walkthrough.
 */
export function interpretVerification(status: number, body: string): VerificationOutcome {
  if (status >= 200 && status < 300) return { ok: true };

  if (status === 403) {
    return {
      ok: false,
      reason: "grant-missing",
      message:
        "The app was denied access to the site. With Sites.Selected this almost always means the per-site grant is missing, not that the app registration is wrong. Re-run this command, or grant it manually with POST /sites/{site-id}/permissions.",
    };
  }

  if (status === 401) {
    return {
      ok: false,
      reason: "token",
      message: "Could not acquire an application token. Check the tenant id, client id, and client secret.",
    };
  }

  if (status === 404) {
    return {
      ok: false,
      reason: "not-found",
      message: "The site was not found. Check the site URL, including its /sites/ segment.",
    };
  }

  return { ok: false, reason: "unknown", message: `Unexpected response ${status}: ${body}` };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/setup/steps.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing error-path test**

Create `tests/setup/steps.errors.test.ts`:

```ts
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
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:errors`
Expected: PASS, three error-path files now.

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "feat: add pure setup steps with actionable Sites.Selected diagnostics"
```

---

### Task 8: Setup command orchestrator, adapter, and documentation

**Files:**
- Create: `src/setup/adapter.ts`, `src/setup/run.ts`, `src/setup/main.ts`
- Create: `docs/SETUP.md`
- Modify: `README.md`
- Test: `tests/setup/run.test.ts`, `tests/setup/run.errors.test.ts`

**Interfaces:**
- Consumes: everything exported from `src/setup/steps.ts` in Task 7.
- Produces: `interface SetupGraph`, `runSetup(graph: SetupGraph, args: SetupArgs): Promise<SetupResult>` where `SetupArgs = { displayName: string; siteUrl: string; write: boolean }` and `SetupResult = { appId: string; objectId: string; secret: string; siteId: string }`. `SetupFailedError extends Error`. `createFetchSetupGraph(accessToken: string, acquireAppToken: (appId: string, secret: string) => Promise<string>): SetupGraph`.

- [ ] **Step 1: Write the failing orchestrator test**

Create `tests/setup/run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { runSetup } from "../../src/setup/run.js";

function fakeGraph(overrides: Partial<SetupGraph> = {}): { graph: SetupGraph; calls: string[] } {
  const calls: string[] = [];
  const graph: SetupGraph = {
    createApplication: async (request) => {
      calls.push(`createApplication:${request.displayName}`);
      return { objectId: "object-1", appId: "app-1" };
    },
    addPassword: async (objectId) => {
      calls.push(`addPassword:${objectId}`);
      return { secretText: "secret-1" };
    },
    resolveSite: async (sitePath) => {
      calls.push(`resolveSite:${sitePath}`);
      return { siteId: "site-1" };
    },
    grantSitePermission: async (siteId, request) => {
      calls.push(`grantSitePermission:${siteId}:${request.roles.join(",")}`);
    },
    verifyAppAccess: async () => {
      calls.push("verifyAppAccess");
      return { status: 200, body: "{}" };
    },
    ...overrides,
  };
  return { graph, calls };
}

describe("runSetup", () => {
  it("registers, secures, grants, then verifies, in that order", async () => {
    const { graph, calls } = fakeGraph();

    const result = await runSetup(graph, {
      displayName: "Ironwright Reconciliation",
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      write: true,
    });

    expect(calls).toEqual([
      "createApplication:Ironwright Reconciliation",
      "addPassword:object-1",
      "resolveSite:contoso.sharepoint.com:/sites/Example",
      "grantSitePermission:site-1:write",
      "verifyAppAccess",
    ]);
    expect(result).toEqual({ appId: "app-1", objectId: "object-1", secret: "secret-1", siteId: "site-1" });
  });

  it("requests read-only access when write is false", async () => {
    const { graph, calls } = fakeGraph();

    await runSetup(graph, { displayName: "App", siteUrl: "https://contoso.sharepoint.com/sites/Example", write: false });

    expect(calls).toContain("grantSitePermission:site-1:read");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/setup/run.test.ts`
Expected: FAIL, cannot resolve `adapter.js`.

- [ ] **Step 3: Write `src/setup/adapter.ts`**

```ts
import type { AppRegistrationRequest, SitePermissionRequest } from "./steps.js";

export interface SetupGraph {
  createApplication(request: AppRegistrationRequest): Promise<{ objectId: string; appId: string }>;
  addPassword(objectId: string): Promise<{ secretText: string }>;
  resolveSite(sitePath: string): Promise<{ siteId: string }>;
  grantSitePermission(siteId: string, request: SitePermissionRequest): Promise<void>;
  verifyAppAccess(args: { appId: string; secret: string; siteId: string }): Promise<{ status: number; body: string }>;
}

const GRAPH = "https://graph.microsoft.com/v1.0";

async function graphJson<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Graph ${method} ${path} failed with ${response.status}: ${text}`);
  }
  return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
}

/**
 * Uses fetch rather than the Graph SDK. The setup command runs once per
 * deployment with a signed-in administrator's token, and pulling in the SDK's
 * auth providers here would be the only reason this phase needs them at all.
 */
export function createFetchSetupGraph(
  accessToken: string,
  acquireAppToken: (appId: string, secret: string) => Promise<string>,
): SetupGraph {
  return {
    async createApplication(request) {
      const created = await graphJson<{ id: string; appId: string }>(accessToken, "POST", "/applications", request);
      return { objectId: created.id, appId: created.appId };
    },

    async addPassword(objectId) {
      const created = await graphJson<{ secretText: string }>(
        accessToken,
        "POST",
        `/applications/${objectId}/addPassword`,
        { passwordCredential: { displayName: "ironwright-mcp" } },
      );
      return { secretText: created.secretText };
    },

    async resolveSite(sitePath) {
      const site = await graphJson<{ id: string }>(accessToken, "GET", `/sites/${sitePath}`);
      return { siteId: site.id };
    },

    async grantSitePermission(siteId, request) {
      await graphJson(accessToken, "POST", `/sites/${siteId}/permissions`, request);
    },

    async verifyAppAccess({ appId, secret, siteId }) {
      // Verification deliberately uses a token minted for the new app, not the
      // administrator's token. An administrator can read the site regardless, so
      // verifying with their token would pass while the app itself is still blocked.
      const appToken = await acquireAppToken(appId, secret);
      const response = await fetch(`${GRAPH}/sites/${siteId}/drive`, {
        headers: { authorization: `Bearer ${appToken}` },
      });
      return { status: response.status, body: await response.text() };
    },
  };
}
```

- [ ] **Step 4: Write `src/setup/run.ts`**

```ts
import type { SetupGraph } from "./adapter.js";
import {
  buildAppRegistrationRequest,
  buildSitePermissionRequest,
  interpretVerification,
  siteIdPathFromUrl,
  type VerificationOutcome,
} from "./steps.js";

export interface SetupArgs {
  displayName: string;
  siteUrl: string;
  write: boolean;
}

export interface SetupResult {
  appId: string;
  objectId: string;
  secret: string;
  siteId: string;
}

export class SetupFailedError extends Error {
  readonly outcome: Extract<VerificationOutcome, { ok: false }>;

  constructor(outcome: Extract<VerificationOutcome, { ok: false }>) {
    super(outcome.message);
    this.name = "SetupFailedError";
    this.outcome = outcome;
  }
}

export async function runSetup(graph: SetupGraph, args: SetupArgs): Promise<SetupResult> {
  const { objectId, appId } = await graph.createApplication(buildAppRegistrationRequest(args.displayName));
  const { secretText } = await graph.addPassword(objectId);
  const { siteId } = await graph.resolveSite(siteIdPathFromUrl(args.siteUrl));

  await graph.grantSitePermission(
    siteId,
    buildSitePermissionRequest({ appId, appDisplayName: args.displayName, write: args.write }),
  );

  const verification = await graph.verifyAppAccess({ appId, secret: secretText, siteId });
  const outcome = interpretVerification(verification.status, verification.body);
  if (!outcome.ok) throw new SetupFailedError(outcome);

  return { appId, objectId, secret: secretText, siteId };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/setup/run.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Write the failing error-path test**

Create `tests/setup/run.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { SetupFailedError, runSetup } from "../../src/setup/run.js";

function graphReturning(status: number, body = "{}"): { graph: SetupGraph; granted: boolean[] } {
  const granted: boolean[] = [];
  const graph: SetupGraph = {
    createApplication: async () => ({ objectId: "object-1", appId: "app-1" }),
    addPassword: async () => ({ secretText: "secret-1" }),
    resolveSite: async () => ({ siteId: "site-1" }),
    grantSitePermission: async () => {
      granted.push(true);
    },
    verifyAppAccess: async () => ({ status, body }),
  };
  return { graph, granted };
}

const args = { displayName: "App", siteUrl: "https://contoso.sharepoint.com/sites/Example", write: true };

describe("runSetup failures", () => {
  it("fails with an actionable message when the app is still denied access", async () => {
    const { graph } = graphReturning(403);

    await expect(runSetup(graph, args)).rejects.toThrow(SetupFailedError);
    await expect(runSetup(graph, args)).rejects.toThrow(/\/sites\/\{site-id\}\/permissions/);
  });

  it("does not swallow a failure from the grant call itself", async () => {
    const { graph } = graphReturning(200);
    graph.grantSitePermission = async () => {
      throw new Error("Graph POST /sites/site-1/permissions failed with 403: accessDenied");
    };

    await expect(runSetup(graph, args)).rejects.toThrow(/permissions failed with 403/);
  });

  it("surfaces a credential problem separately from a permission problem", async () => {
    const { graph } = graphReturning(401);

    await expect(runSetup(graph, args)).rejects.toThrow(/client secret/);
  });
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test:errors`
Expected: PASS, four error-path files.

- [ ] **Step 8: Write `src/setup/main.ts`**

```ts
import { DeviceCodeCredential } from "@azure/identity";
import { createFetchSetupGraph } from "./adapter.js";
import { runSetup, SetupFailedError } from "./run.js";

function requireArg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (found === undefined) throw new Error(`missing required argument ${prefix}<value>`);
  return found.slice(prefix.length);
}

async function main(): Promise<void> {
  const tenantId = requireArg("tenant");
  const siteUrl = requireArg("site");
  const displayName = process.argv.includes("--name")
    ? requireArg("name")
    : "Ironwright Repository Reconciliation";
  const write = process.argv.includes("--write");

  // Device code, because creating an app registration needs a human with
  // Application Administrator rights. The server's own credentials cannot
  // bootstrap the app that holds them.
  const credential = new DeviceCodeCredential({
    tenantId,
    clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e",
    userPromptCallback: (info) => {
      console.log(info.message);
      return Promise.resolve();
    },
  });

  const adminToken = await credential.getToken("https://graph.microsoft.com/.default");
  if (adminToken === null) throw new Error("sign-in did not return a token");

  const graph = createFetchSetupGraph(adminToken.token, async (appId, secret) => {
    const body = new URLSearchParams({
      client_id: appId,
      client_secret: secret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await response.json()) as { access_token?: string };
    if (json.access_token === undefined) throw new Error("client credentials flow returned no access token");
    return json.access_token;
  });

  try {
    const result = await runSetup(graph, { displayName, siteUrl, write });
    console.log("Setup complete. Store these as deployment secrets, not in the repository.");
    console.log(`  AZURE_TENANT_ID=${tenantId}`);
    console.log(`  AZURE_CLIENT_ID=${result.appId}`);
    console.log(`  AZURE_CLIENT_SECRET=${result.secret}`);
    console.log(`  IW_SITE_ID=${result.siteId}`);
  } catch (error) {
    if (error instanceof SetupFailedError) {
      console.error(`Setup failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

await main();
```

- [ ] **Step 9: Install the identity dependency and verify the build**

Run:

```bash
npm install @azure/identity
npm run typecheck
```

Expected: typecheck passes. There is a newly created secret printed to stdout by design; note in `docs/SETUP.md` that the output should not be pasted into a chat or a ticket.

- [ ] **Step 10: Write `docs/SETUP.md`**

```markdown
# Setup

One server instance serves one customer tenant. Run this once per tenant.

## What you need

- A user with **Application Administrator** (or Cloud Application Administrator) in the target tenant, to create the app registration.
- A user with **site owner** rights on the target SharePoint site, to grant that app access to it. This can be the same person.
- Node 22 or later.

## Run it

```bash
npm install
npm run setup -- --tenant=<tenant-id> --site=https://<tenant>.sharepoint.com/sites/<SiteName> --write
```

Omit `--write` to grant read-only site access, which is the right choice for a deployment that will never run remediation.

The command signs you in with a device code, creates a single-tenant confidential client, adds a client secret, resolves the site, grants that one app access to that one site, and then verifies the grant using a token minted for the new app rather than your own.

That last step matters. `Sites.Selected` does nothing until a per-site grant is issued, and an administrator's own token can read the site whether or not the grant exists, so verifying with your own credentials would report success against a server that cannot work.

## Output

The command prints four values. Store them as deployment secrets, in Key Vault or the container app's secret store. Do not paste them into a chat, a ticket, or this repository.

Writes stay disabled until `IW_ALLOW_WRITES=true` is set on the deployment, regardless of the site permission granted here.

## If verification fails

The command maps the failure rather than passing the raw status through. A 403 means the per-site grant is missing, which is by far the most common outcome and looks nothing like its cause. A 401 means the credentials are wrong. A 404 means the site URL is wrong.
```

- [ ] **Step 11: Update `README.md`**

```markdown
# Ironwright MCP

A path-native Microsoft Graph and SharePoint reconciliation MCP server. It answers what files
should exist in a document library and whether they do, by reading an operational tracking
workbook as the expected state and comparing it against the repository's actual contents.

Built by Ironwright (Adam Powell). Licensed under the Elastic License 2.0; see `LICENSE`.

## Status

Phase 1. The server is connectable and every tool is registered with its real schema and
annotations, returning a placeholder response until the Graph layer lands.

## Documentation

- `docs/SETUP.md` - per-tenant Entra and SharePoint setup
- `docs/superpowers/specs/` - design specifications
- `docs/superpowers/plans/` - implementation plans

## Development

```bash
npm install
npm run dev        # start with hot reload
npm test           # full test suite
npm run test:errors # error-path suite, a separate CI gate
npm run lint
npm run typecheck
```

Writes are disabled unless `IW_ALLOW_WRITES=true`. Profiles are deployment configuration and
are not committed; see `examples/profiles/example.json` for the shape.
```

- [ ] **Step 12: Run the full gate**

Run: `npm run lint && npm run typecheck && npm test && npm run test:errors && npm run build`
Expected: all pass.

- [ ] **Step 13: Manually verify the setup command against a real developer tenant**

This step cannot be unit tested and is the one live check in phase 1. In your own M365 developer tenant, create a site with a document library, then run:

```bash
npm run setup -- --tenant=<your-dev-tenant-id> --site=https://<your-dev-tenant>.sharepoint.com/sites/<SiteName>
```

Expected: the command prints four values and reports success. Then confirm the failure path is real by creating a second app registration manually, skipping the grant, and calling `GET /sites/{site-id}/drive` with its token. Expected: 403, matching the `grant-missing` branch.

- [ ] **Step 14: Commit**

```bash
git add src tests docs README.md package.json package-lock.json
git commit -m "feat: add scripted per-tenant Entra setup with verified Sites.Selected grant"
```

---

## Definition of done for phase 1

- `npm run lint && npm run typecheck && npm test && npm run test:errors && npm run build` all pass.
- An MCP client connects over Streamable HTTP, lists ten tools with writes enabled and seven with writes disabled, and successfully calls one.
- The concurrency isolation test has been observed failing when the server instance is shared, so it is known to be load-bearing.
- The committed example profile validates, and each documented validation rule has a test proving it rejects.
- `npm run setup` has completed successfully against a real developer tenant, and the 403 grant-missing path has been reproduced deliberately.
