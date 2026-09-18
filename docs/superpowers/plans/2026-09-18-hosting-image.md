# Phase 5a Deployable Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server deployable, and prove it by having the compiled production output answer all five read tools correctly against the live tenant.

**Architecture:** Three changes any hosting approach needs, none of which requires a container runtime: a production compile that excludes the operator tooling, a shutdown that always exits, and a health endpoint whose meaning is settled and pinned. Plus the configuration contract a deployment has to satisfy.

**Tech Stack:** TypeScript, Node 22, Express 5, Vitest.

**Binding spec:** `docs/superpowers/specs/2026-09-18-hosting-image-design.md`, which carries an amendment moving the container image out of this phase. Where this plan and that spec disagree, the spec wins.

## Global Constraints

- No emojis or icons anywhere, including logs, tests and docs. US English throughout.
- No em dashes or en dashes anywhere in the repo, including inside string literals. A test enforces this across tracked files.
- Comments explain why, not what.
- A function that cannot observe an outcome must not assert it. This applies to tests: a test that cannot observe a thing must not assert it.
- **No Dockerfile, no `.dockerignore`, no image work of any kind.** The machine has no container runtime, and this project does not merge artifacts nobody has executed. That slice is held.
- **No code for the federated credential, not even an interface to hold it later.** Phase 5b probes that API before designing against it.
- `/health` must not call Microsoft Graph or Azure Table Storage.
- Gates before every commit: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`.
- The suite stands at 1957 tests across 134 files. Every new tracked text file adds two source-hygiene assertions, so count that way when reporting.

---

## File Structure

**Created**

- `tsconfig.build.json`, the production compile
- `tests/build/production-build.test.ts`
- `tests/server/shutdown.test.ts`

**Modified**

- `package.json`, a script for the production compile
- `src/server/main.ts`, the shutdown deadline
- `src/config.ts`, the deadline value
- `src/server/app.ts`, the health contract
- `docs/SETUP.md`, `docs/OPEN-ITEMS.md`, `CLAUDE.md`

---

### Task 1: Separate the production compile from the development one

**Files:**
- Create: `tsconfig.build.json`
- Modify: `package.json`
- Test: `tests/build/production-build.test.ts`

**Interfaces:**
- Produces: `npm run build:prod`, compiling only what the server needs into `dist`. The controller's verification run uses it. `npm run build` keeps its current meaning for development and CI.

- [ ] **Step 1: Write the failing test**

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

/**
 * Excluding the setup command is a security boundary rather than a size saving.
 * That command issues per-site permission grants through a separate application
 * holding Sites.FullControl.All, and a deployed server has no business carrying
 * that machinery: it widens a compromise from "can read one granted site" to
 * "contains the means to grant access to others".
 *
 * The devDependency failure is the symptom that surfaced it. src/setup/main.ts
 * imports @azure/identity, so a production install cannot compile it.
 */
it("the production compile excludes the setup command", () => {
  const config = JSON.parse(readFileSync("tsconfig.build.json", "utf8")) as { exclude?: string[] };
  expect(config.exclude).toContain("src/setup");
});

it("emits the server entry point and no setup output", () => {
  rmSync("dist", { recursive: true, force: true });
  execFileSync("npm", ["run", "build:prod"], { stdio: "pipe", shell: process.platform === "win32" });

  expect(existsSync("dist/server/main.js")).toBe(true);
  expect(existsSync("dist/setup/main.js")).toBe(false);
});

it("start runs what the production compile emits", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  expect(pkg.scripts.start).toContain("dist/server/main.js");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/build/production-build.test.ts`
Expected: FAIL, `tsconfig.build.json` does not exist.

- [ ] **Step 3: Add the production compile**

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/setup"]
}
```

`package.json`, beside the existing `build`:

```json
"build:prod": "tsc -p tsconfig.build.json"
```

`npm run build` is unchanged. Development and CI still compile the setup command; only a deployment does not carry it.

- [ ] **Step 4: Confirm nothing outside the excluded tree imports it**

Run: `grep -rn "setup/" src --include=*.ts | grep -v "^src/setup/"`
Expected: no output. If something does import it, stop and report rather than widening the exclusion. A server that needs the setup command is a design problem, not a build problem.

- [ ] **Step 5: Run the gates and commit**

Run: `npm run lint && npm run typecheck && npm run build && npm run build:prod && npm test`

```bash
git add tsconfig.build.json package.json tests/build/production-build.test.ts
git commit -m "build: compile the server without the setup command for production"
```

---

### Task 2: Bound the shutdown

**Files:**
- Modify: `src/server/main.ts`, the `SIGTERM` handler at lines 102 to 113
- Modify: `src/config.ts`
- Test: `tests/server/shutdown.test.ts`

**Interfaces:**
- Produces: `installShutdown({ server, deadlineMs, exit, log })`, exported from `src/server/main.ts`. Nothing else consumes it.
- Produces: a shutdown deadline loader in `src/config.ts`, optional with a default.

- [ ] **Step 1: Write the failing test**

The handler today calls `server.close` and exits only from its callback, so a request that never completes means the process never exits on its own. `installShutdown` takes `exit` and `log` as injected functions, the same way `runReconcile` takes its workbook reader, so the behavior is reachable from a test. You will need a fake server exposing `close(cb)`, `closeIdleConnections()` and a connection count; write it in the test file.

```typescript
it("exits after the deadline when a request never completes", async () => {
  const server = fakeHttpServer({ closeNeverCompletes: true, connections: 1 });
  const exits: number[] = [];
  const logs: string[] = [];

  const shutdown = installShutdown({ server, deadlineMs: 20, exit: (c) => exits.push(c), log: (l) => logs.push(l) });
  shutdown();
  await delay(60);

  expect(exits).toEqual([0]);
  expect(logs.join("\n")).toContain("1 request still in flight");
});

it("exits as soon as the drain finishes, without waiting for the deadline", async () => {
  const server = fakeHttpServer({ closeCompletesAfterMs: 5, connections: 0 });
  const exits: number[] = [];

  installShutdown({ server, deadlineMs: 5_000, exit: (c) => exits.push(c), log: () => {} })();
  await delay(40);

  expect(exits).toEqual([0]);
});

it("exits once when the drain finishes just after the deadline", async () => {
  const server = fakeHttpServer({ closeCompletesAfterMs: 30, connections: 1 });
  const exits: number[] = [];

  installShutdown({ server, deadlineMs: 10, exit: (c) => exits.push(c), log: () => {} })();
  await delay(80);

  expect(exits).toEqual([0]);
});

it("closes idle connections so keep-alive sockets do not hold the drain open", () => {
  const server = fakeHttpServer({ closeCompletesAfterMs: 1, connections: 0 });
  installShutdown({ server, deadlineMs: 1_000, exit: () => {}, log: () => {} })();

  expect(server.idleConnectionsClosed).toBe(true);
});
```

The third case is the one worth writing. A deadline and a drain racing each other is how a shutdown path ends up calling `process.exit` twice, or logging a count that was true a moment ago and is not true now.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/server/shutdown.test.ts`
Expected: FAIL, `installShutdown` is not exported.

- [ ] **Step 3: Extract and bound the handler**

Extract the inline `process.on("SIGTERM", ...)` into an exported `installShutdown` that returns the handler it registered, so a test can invoke it without sending a real signal. Production passes `process.exit` and `console.log` and the configured deadline.

On signal: log that shutdown began, call `server.close`, close idle connections as today, and start a timer. Whichever of the drain and the timer finishes first exits, and the other must not exit again. When the deadline wins, the log names how many requests were still outstanding, taken from the server's own connection count rather than a counter this code maintains, because a count it maintains is a count it can get wrong.

Keep the existing comment about idle keep-alive sockets. It is still true and still the reason.

- [ ] **Step 4: Read the deadline from configuration**

Add a loader to `src/config.ts` beside the existing ones, optional, defaulting to 25 seconds. Put the reason in a comment: it sits under a platform's usual 30 second grace so the process exits on its own terms and can say why, rather than being killed silently. A number without a reason is a number the next person changes.

- [ ] **Step 5: Run the gates and commit**

Run: `npm run lint && npm run typecheck && npm run build && npm test`

```bash
git add src/server/main.ts src/config.ts tests/server/shutdown.test.ts
git commit -m "fix(server): exit on a deadline rather than draining forever"
```

---

### Task 3: Settle what health means

**Files:**
- Modify: `src/server/app.ts`, the `/health` route at line 18
- Test: `tests/server/app.test.ts`

- [ ] **Step 1: Write the test**

It may pass immediately, because the route is already trivial. Keep it anyway and say so in your report: it pins a property the next person could break by adding a readiness probe that calls Graph, which is the obvious and wrong next move.

```typescript
it("answers healthy without building a tool server or reaching any dependency", async () => {
  let serverFactoryCalls = 0;
  const app = createApp({ serverFactory: () => { serverFactoryCalls += 1; return stubServer(); } });

  const response = await request(app).get("/health");

  expect(response.status).toBe(200);
  // A health check that depends on a third party turns that party's outage into
  // a restart loop, which is strictly worse than serving one caller an error.
  expect(serverFactoryCalls).toBe(0);
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/server/app.test.ts`
Expected: PASS or FAIL. Report which, honestly. A passing new test is evidence the property already holds, not evidence the task was unnecessary.

- [ ] **Step 3: State the contract in the code**

Rewrite the route's comment to say what the endpoint means: this instance can serve. It does not mean the tenant is reachable, and it must not, for the reason in the test. Configuration and profile failures already exit at startup before the port binds, so a process that answers at all has passed them.

- [ ] **Step 4: Commit**

```bash
git add src/server/app.ts tests/server/app.test.ts
git commit -m "docs(server): state what health answers for, and pin that it reaches nothing"
```

---

### Task 4: Write down the configuration contract and record the phase

**Files:**
- Modify: `docs/SETUP.md`
- Modify: `docs/OPEN-ITEMS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: The contract**

`docs/SETUP.md` gains a section on running the server as a deployment, listing every variable in one place, because phase 5b has to supply them and a deployment that discovers a required variable at startup has already failed.

Required: the tenant, client id and client secret for the server's own application; the granted site, which became required in phase 4c and which the profile registry checks every profile against; and the profile directory.

Optional: the Azure Table connection string, whose absence selects the in-memory store, and the write-enable flag, whose absence leaves every write tool unpublished rather than merely refused. Add the new shutdown deadline.

State that profiles arrive as a directory the deployment supplies, never committed and never baked into an artifact.

- [ ] **Step 2: The phase record**

`docs/OPEN-ITEMS.md` gains a "Phase 5a" section. It must:

- Close the carried item about the production build failing under `--omit=dev`, naming how it was closed and why exclusion was chosen over building before pruning.
- Restate the item this phase deliberately did NOT fix: the SDK's pending stream-mapping entry is not a local defect, the tractable half is detection, and detection is telemetry, which is phase 5b.
- Record that the container image was moved out of this phase because the development machine has no runtime to build one, and that the slice is held rather than dropped.
- State what the phase is covered by, and that the compiled production output answering live is the only evidence beyond unit tests.

- [ ] **Step 3: The build sequence**

`CLAUDE.md`'s phase 5 entry becomes 5a and 5b, naming what each holds. Do not claim live verification; the controller runs that before merge.

- [ ] **Step 4: Commit**

```bash
git add docs/SETUP.md docs/OPEN-ITEMS.md CLAUDE.md
git commit -m "docs: record the deployment configuration contract and phase 5a coverage"
```

---

## Verification before merge, which is the controller's to run

**The compiled production output answers all five read tools correctly against the live tenant.** Not `tsx`, not `npm run dev`: `npm run build:prod` followed by `node dist/server/main.js`, with the same environment every live sitting has used.

Every live run this project has performed used `tsx` against TypeScript source. The compiled artifact has never been executed at all, and the production compile is exactly where excluding the setup command could break something that source execution hides.

Expected figures, from the phase 4b and 4c sittings: `inventory_tree` returns 144 files and 122 folders at 4 Graph requests cold and 3 warm; `query_repository` costs zero on all three questions; `validate_structure` finds 12 client folders, all compliant; `reconcile_workbook_vs_repository` returns its report; `describe_workbook` rediscovers source `ClientRoster` at header row 1.

A figure that differs under the compiled build is a packaging defect, which is what this phase exists to surface.

---

## Self-Review

**Spec coverage.** The production compile is Task 1, the shutdown Task 2, health Task 3, the contract and the record Task 4. The image is out of scope by amendment and no task creates one. The federated credential is absent and no task introduces an abstraction for it. The pending-handler item is restated as deliberately unfixed rather than quietly dropped.

**Placeholder scan.** Task 2's tests need a `fakeHttpServer` helper whose shape depends on how `installShutdown` is extracted, and that is named as the implementer's to write rather than left implied. Task 3's test needs whatever `stubServer` helper `tests/server/app.test.ts` already uses; the implementer reuses it rather than inventing one. Every other code step carries real content.

**Type consistency.** `build:prod` is produced in Task 1 and consumed only by the controller's verification. `installShutdown` is produced in Task 2 and consumed nowhere else. Task 3 depends on nothing.

**One risk worth naming.** Task 1's second test shells out to `npm run build:prod` and deletes `dist` first. That makes it slower than every other test in the suite and gives it a side effect on the working tree. If the implementer finds it unacceptably slow or flaky under the suite's parallelism, the honest alternative is to assert the tsconfig contract only and leave the compile to the gates, and to say so rather than quietly weakening the assertion.
