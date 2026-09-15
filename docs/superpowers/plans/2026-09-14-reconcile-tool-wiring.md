# Reconciliation Tool Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `reconcile_workbook_vs_repository` a working tool, and build the execution layer that every later tool inherits.

**Architecture:** Six new modules and three modified ones. A `ToolContext` of process-lifetime dependencies is built once in `main.ts` and handed to every per-request `McpServer`. A `ProfileRegistry` loads and validates profiles at startup. A `ScanCoordinator` wraps `runScan` in an in-process single-flight so two concurrent calls cannot read a half-rebuilt inventory. The tool's own code is four pure modules (`output`, `shape`, `text`, `errors`) plus one composition root (`run`) that fetches the workbook, then the scan, calls the finished engine, and shapes what comes back.

**Tech Stack:** TypeScript, Node 22+, ESM with NodeNext resolution, vitest, zod, the MCP TypeScript SDK, plain `fetch`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-14-reconcile-tool-wiring-design.md`. It is binding where this plan and it disagree.

## Global Constraints

Every task's requirements implicitly include all of these.

- **No emojis or icons anywhere**, including logs and docs. **US English throughout.** This repo's prose avoids em dashes and en dashes, including in strings.
- **Comments explain why, not what.** `src/graph/` and `src/setup/` carry unusually dense rationale; match that register.
- **A function that cannot observe an outcome must not assert it.** This project has caught the same defect more than fifteen times: a message correct clause by clause and false once assembled, or one asserting something the program did not observe. This plan is unusually exposed to it, because Task 4 exists only to produce prose an operator reads. When you write or change anything an operator reads, read the assembled string across every combination of the fields that feed it, not clause by clause.
- **The domain layer stays pure.** Nothing in `src/domain/` may import anything this plan adds. Nothing this plan adds may import a reconciliation stage directly: `reconcile` and every report type come from `src/domain/reconcile/index.js`, and the lint rule enforces it.
- **Imports carry the `.js` extension** (NodeNext), and `verbatimModuleSyntax` is on, so type-only imports must be written `import type`.
- **`noUncheckedIndexedAccess` is on.** An indexed read is `T | undefined` and must be narrowed.
- **Tests live in `tests/`, mirroring `src/`.** Error-path tests go in files ending `.errors.test.ts`, which the `test:errors` script gates separately in CI.
- **Conventional commits**, on a feature branch. Every commit message ends with these two lines, verbatim, regardless of which model writes it:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ds8MKaFZcayf4Ug91RCLo9
  ```
- **Verification before completion.** `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` must all pass before a task is called done. Run them; do not assume them. Do not treat any test count quoted to you as a baseline: `tests/source-hygiene.test.ts` emits one case per tracked text file, so the total moves whenever a file is added, documentation included. Measure the count before your change and after it, and require only that it did not shrink.
- **Never run against a tenant.** Every task is tested against fakes. Live verification is the operator's, once.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/profiles/registry.ts` | Load and validate profiles once; resolve a `profileId` | Create |
| `src/scan/coordinator.ts` | In-process single-flight around `runScan` | Create |
| `src/tools/reconciliation/output.ts` | The tool's Zod `outputSchema` and its types. Pure | Create |
| `src/tools/reconciliation/shape.ts` | Report to tool output: filter, omit, truncate. Pure | Create |
| `src/tools/reconciliation/text.ts` | The text block, derived from the shaped output. Pure | Create |
| `src/tools/errors.ts` | A failure to an operator-readable message. Pure | Create |
| `src/tools/reconciliation/run.ts` | Composition: profile, workbook, scan, engine, shape | Create |
| `src/tools/context.ts` | `ToolContext` and `ToolHandler` types | Create |
| `src/tools/types.ts` | The tool definition contract | Add optional `handler` |
| `src/mcp/build-server.ts` | Per-request server construction | Dispatch to a handler; require a context |
| `src/server/config.ts` | Server configuration from the environment | Add `profileDir` |
| `src/server/main.ts` | The server's composition root | Build the real context |
| `src/tools/definitions/reconcile.ts` | The tool's declared contract | Real output schema and handler |
| `eslint.config.js` | The engine's single-entry fence | Exempt the engine's test fixtures |

**The tool's package is `reconciliation`, not `reconcile`.** `src/domain/reconcile/` is the engine and `src/tools/reconciliation/` is the tool that calls it, and they are different things that should not share a name. The lint fence is what forces the point: it restricts every import string matching `**/reconcile/**` to `index.js`, matching on the path as written rather than on what it resolves to, so a second directory named `reconcile` would have every internal import of its own siblings refused by a rule that exists to protect something else entirely. Do not rename it back and carve an exception into the fence instead.

---

## Task 1: The profile registry

**Files:**
- Create: `src/profiles/registry.ts`
- Test: `tests/profiles/registry.test.ts`
- Test: `tests/profiles/registry.errors.test.ts`

**Interfaces:**
- Consumes: `loadProfile`, `ProfileValidationError` from `src/domain/profile/load.js`; `Profile` from `src/domain/profile/schema.js`.
- Produces:
  - `interface ProfileEntry { source: string; contents: unknown }`
  - `interface ProfileRegistry { get(profileId: string): Profile; ids(): string[] }`
  - `function createProfileRegistry(entries: readonly ProfileEntry[]): ProfileRegistry`
  - `function loadProfileDirectory(dir: string): Promise<ProfileRegistry>`
  - `class ProfileRegistryError extends Error`
  - `class UnknownProfileError extends Error` with `readonly profileId: string` and `readonly configured: string[]`

- [ ] **Step 1: Write the failing tests for the pure registry**

Create `tests/profiles/registry.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProfileRegistry } from "../../src/profiles/registry.js";

function exampleProfile(): Record<string, unknown> {
  return JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;
}

describe("createProfileRegistry", () => {
  it("resolves a profile by the profileId inside the file, not by the file name", () => {
    const registry = createProfileRegistry([{ source: "not-the-id.json", contents: exampleProfile() }]);

    expect(registry.get("example").profileId).toBe("example");
  });

  it("lists the configured ids in a stable order", () => {
    const registry = createProfileRegistry([
      { source: "b.json", contents: { ...exampleProfile(), profileId: "zulu" } },
      { source: "a.json", contents: { ...exampleProfile(), profileId: "alpha" } },
    ]);

    expect(registry.ids()).toEqual(["alpha", "zulu"]);
  });

  it("returns the same profile object on repeated gets, so nothing revalidates per call", () => {
    const registry = createProfileRegistry([{ source: "a.json", contents: exampleProfile() }]);

    expect(registry.get("example")).toBe(registry.get("example"));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/profiles/registry.test.ts`
Expected: FAIL, cannot resolve `../../src/profiles/registry.js`.

- [ ] **Step 3: Write the pure registry**

Create `src/profiles/registry.ts`:

```ts
import { loadProfile, ProfileValidationError } from "../domain/profile/load.js";
import type { Profile } from "../domain/profile/schema.js";

/**
 * A profile directory this server cannot start with. Every problem found in
 * the directory is reported in one message rather than the first one only,
 * for the reason `loadGraphCredentials` gives about environment variables: an
 * operator fixing a deployment they did not build should not pay one failed
 * start per mistake.
 */
export class ProfileRegistryError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`the profile directory cannot be loaded:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ProfileRegistryError";
    this.issues = issues;
  }
}

/**
 * Names the ids that are configured. Profile ids are deployment names rather
 * than secrets, and an agent told which ids exist corrects itself in one turn
 * instead of guessing at a second wrong one.
 */
export class UnknownProfileError extends Error {
  readonly profileId: string;
  readonly configured: string[];

  constructor(profileId: string, configured: string[]) {
    super(
      `No profile named "${profileId}" is configured. ` +
        (configured.length === 0
          ? "This server has no profiles at all, which means it was started against an empty profile directory."
          : `The configured ${configured.length === 1 ? "profile is" : "profiles are"}: ${configured
              .map((id) => `"${id}"`)
              .join(", ")}.`),
    );
    this.name = "UnknownProfileError";
    this.profileId = profileId;
    this.configured = configured;
  }
}

/** One candidate profile, already read. `source` is used only in messages. */
export interface ProfileEntry {
  source: string;
  contents: unknown;
}

export interface ProfileRegistry {
  /** Throws `UnknownProfileError` rather than returning undefined: every caller has to report the same thing. */
  get(profileId: string): Profile;
  ids(): string[];
}

/**
 * Pure over already-read contents, so every validation rule is testable
 * without a filesystem. `loadProfileDirectory` below is the only part that
 * does I/O, which keeps the untestable half to one function.
 *
 * Indexed by the `profileId` field rather than by the file name, because the
 * file name is not the identity: the report carries `profileId` from the
 * profile itself, so a registry keyed on the file name could answer a call for
 * one profile with a report labelled another.
 */
export function createProfileRegistry(entries: readonly ProfileEntry[]): ProfileRegistry {
  const issues: string[] = [];
  const byId = new Map<string, { profile: Profile; source: string }>();

  for (const entry of entries) {
    let profile: Profile;
    try {
      profile = loadProfile(entry.contents);
    } catch (error) {
      if (!(error instanceof ProfileValidationError)) throw error;
      issues.push(`${entry.source}: ${error.issues.join("; ")}`);
      continue;
    }

    const held = byId.get(profile.profileId);
    if (held !== undefined) {
      issues.push(
        `${entry.source} and ${held.source} both declare profileId "${profile.profileId}". ` +
          "A profile id names one deployment target, so which of the two a call would reach is undecidable.",
      );
      continue;
    }

    byId.set(profile.profileId, { profile, source: entry.source });
  }

  if (entries.length === 0) {
    issues.push("the directory contains no profile files, so this server could not answer any call");
  }

  if (issues.length > 0) throw new ProfileRegistryError(issues);

  const ids = [...byId.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    ids: () => [...ids],
    get(profileId: string): Profile {
      const held = byId.get(profileId);
      if (held === undefined) throw new UnknownProfileError(profileId, [...ids]);
      return held.profile;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/profiles/registry.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing error-path tests**

Create `tests/profiles/registry.errors.test.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProfileRegistry,
  loadProfileDirectory,
  ProfileRegistryError,
  UnknownProfileError,
} from "../../src/profiles/registry.js";

function exampleProfile(): Record<string, unknown> {
  return JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;
}

describe("createProfileRegistry rejections", () => {
  it("names every invalid profile in one message, not the first one only", () => {
    const attempt = (): unknown =>
      createProfileRegistry([
        { source: "one.json", contents: { profileId: "one" } },
        { source: "two.json", contents: { profileId: "two" } },
      ]);

    expect(attempt).toThrow(ProfileRegistryError);
    try {
      attempt();
    } catch (error) {
      expect((error as ProfileRegistryError).issues).toHaveLength(2);
      expect((error as ProfileRegistryError).message).toContain("one.json");
      expect((error as ProfileRegistryError).message).toContain("two.json");
    }
  });

  it("refuses two files claiming one profileId, naming both files", () => {
    const attempt = (): unknown =>
      createProfileRegistry([
        { source: "first.json", contents: exampleProfile() },
        { source: "second.json", contents: exampleProfile() },
      ]);

    expect(attempt).toThrow(/first\.json and second\.json|second\.json and first\.json/);
    expect(attempt).toThrow(/"example"/);
  });

  it("refuses an empty directory rather than starting a server that can answer nothing", () => {
    expect(() => createProfileRegistry([])).toThrow(/no profile files/);
  });

  it("names the configured ids when asked for one that is not there", () => {
    const registry = createProfileRegistry([{ source: "a.json", contents: exampleProfile() }]);

    try {
      registry.get("missing");
      expect.unreachable("get should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownProfileError);
      expect((error as UnknownProfileError).configured).toEqual(["example"]);
      expect((error as UnknownProfileError).message).toContain('"example"');
      expect((error as UnknownProfileError).message).toContain("profile is");
    }
  });
});

describe("loadProfileDirectory rejections", () => {
  it("names the file when its JSON will not parse, since JSON.parse reports only an offset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iw-profiles-"));
    await writeFile(join(dir, "broken.json"), "{ not json", "utf8");

    await expect(loadProfileDirectory(dir)).rejects.toThrow(/broken\.json/);
  });

  it("names the directory when it does not exist", async () => {
    const missing = join(tmpdir(), "iw-profiles-does-not-exist-12345");

    await expect(loadProfileDirectory(missing)).rejects.toThrow(missing);
  });

  it("ignores files that are not .json rather than failing on them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iw-profiles-"));
    await writeFile(join(dir, "example.json"), JSON.stringify(exampleProfile()), "utf8");
    await writeFile(join(dir, "README.md"), "not a profile", "utf8");

    const registry = await loadProfileDirectory(dir);

    expect(registry.ids()).toEqual(["example"]);
  });
});
```

- [ ] **Step 6: Run the error-path tests to verify they fail**

Run: `npx vitest run tests/profiles/registry.errors.test.ts`
Expected: FAIL, `loadProfileDirectory` is not exported.

- [ ] **Step 7: Add the directory loader**

Append to `src/profiles/registry.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The only part of this module that touches a filesystem, kept to one function
 * so every rule above is testable without one.
 *
 * Files are read in sorted order so two starts over one directory produce the
 * same message when more than one file is wrong, and a duplicate-id message
 * names the same file first every time.
 *
 * A parse failure names the file. `JSON.parse` reports a character offset and
 * nothing else, which leaves an operator holding a parser message with no way
 * to tell which of several profiles produced it, and the same reasoning already
 * put this wrapper around the scan command's own profile read.
 */
export async function loadProfileDirectory(dir: string): Promise<ProfileRegistry> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    throw new Error(
      `The profile directory "${dir}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Extension match is case sensitive on purpose. A container image is built
  // on a case sensitive filesystem, so accepting ".JSON" here would load a file
  // locally that the deployed server does not see, which is a difference that
  // shows up as a missing profile in production and nowhere else.
  const jsonNames = names.filter((name) => name.endsWith(".json")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const entries: ProfileEntry[] = [];
  for (const name of jsonNames) {
    const text = await readFile(join(dir, name), "utf8");
    try {
      entries.push({ source: name, contents: JSON.parse(text) as unknown });
    } catch (error) {
      throw new Error(
        `The profile "${name}" in "${dir}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return createProfileRegistry(entries);
}
```

Move the two `node:` imports to the top of the file with the others; they are shown here beside the function only to keep this step readable.

- [ ] **Step 8: Run the error-path tests to verify they pass**

Run: `npx vitest run tests/profiles/registry.errors.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 9: Run the full gates**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/profiles/registry.ts tests/profiles/
git commit -m "feat(profiles): load and validate profiles once, at startup"
```

---

## Task 2: The scan coordinator

**Files:**
- Create: `src/scan/coordinator.ts`
- Test: `tests/scan/coordinator.test.ts`
- Test: `tests/scan/coordinator.errors.test.ts`

**Interfaces:**
- Consumes: `runScan`, `ScanDependencies`, `ScanResult` from `src/scan/run.js`; `GraphClient`; `StateStore`; `Profile`.
- Produces:
  - `interface CoordinatedScan { result: ScanResult; joined: boolean }`
  - `interface ScanCoordinator { run(profile: Profile): Promise<CoordinatedScan> }`
  - `interface ScanCoordinatorOptions { client: GraphClient; store: StateStore; now: () => Date; scan?: (dependencies: ScanDependencies) => Promise<ScanResult> }`
  - `function createScanCoordinator(options: ScanCoordinatorOptions): ScanCoordinator`

- [ ] **Step 1: Write the failing tests**

Create `tests/scan/coordinator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createScanCoordinator } from "../../src/scan/coordinator.js";
import type { ScanResult } from "../../src/scan/run.js";
import type { GraphClient } from "../../src/graph/client.js";
import type { StateStore } from "../../src/store/types.js";
import type { Profile } from "../../src/domain/profile/schema.js";

const PROFILE = { profileId: "example" } as unknown as Profile;
const OTHER = { profileId: "other" } as unknown as Profile;

function scanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    snapshot: { files: [], folderPaths: [], scannedAt: "2026-09-14T00:00:00Z", searchCrossCheckIncluded: false },
    driveId: "drive-1",
    mode: "incremental",
    resynced: false,
    pages: 1,
    changesApplied: 0,
    graphRequests: 3,
    storeBatches: 0,
    unfilteredFileCount: 0,
    unfilteredFolderCount: 0,
    ...overrides,
  };
}

// Neither is ever called: every test injects `scan`. They exist because the
// coordinator's options are typed and a cast at each call site would hide a
// signature change instead of failing on it.
const client = {} as GraphClient;
const store = {} as StateStore;

describe("createScanCoordinator", () => {
  it("runs one scan for two concurrent calls and tells the joiner it joined", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async () => {
        started += 1;
        await gate;
        return scanResult();
      },
    });

    const first = coordinator.run(PROFILE);
    const second = coordinator.run(PROFILE);
    release?.();
    const [a, b] = await Promise.all([first, second]);

    expect(started).toBe(1);
    expect(a.joined).toBe(false);
    expect(b.joined).toBe(true);
    expect(b.result).toBe(a.result);
  });

  it("scans again for a call that arrives after the first finished, because this is not a cache", async () => {
    let started = 0;
    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async () => {
        started += 1;
        return scanResult();
      },
    });

    await coordinator.run(PROFILE);
    const second = await coordinator.run(PROFILE);

    expect(started).toBe(2);
    expect(second.joined).toBe(false);
  });

  it("does not make a call for one profile wait on a scan of another", async () => {
    const profilesScanned: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async (dependencies) => {
        profilesScanned.push(dependencies.profile.profileId);
        if (dependencies.profile.profileId === "example") await gate;
        return scanResult();
      },
    });

    const blocked = coordinator.run(PROFILE);
    const other = await coordinator.run(OTHER);
    release?.();
    await blocked;

    expect(other.joined).toBe(false);
    expect(profilesScanned).toEqual(["example", "other"]);
  });

  it("passes the profile and the injected dependencies straight through to the scan", async () => {
    let seen: { profileId: string; hasClient: boolean; hasStore: boolean } | undefined;
    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async (dependencies) => {
        seen = {
          profileId: dependencies.profile.profileId,
          hasClient: dependencies.client === client,
          hasStore: dependencies.store === store,
        };
        return scanResult();
      },
    });

    await coordinator.run(PROFILE);

    expect(seen).toEqual({ profileId: "example", hasClient: true, hasStore: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scan/coordinator.test.ts`
Expected: FAIL, cannot resolve `../../src/scan/coordinator.js`.

- [ ] **Step 3: Write the coordinator**

Create `src/scan/coordinator.ts`:

```ts
import type { GraphClient } from "../graph/client.js";
import type { StateStore } from "../store/types.js";
import type { Profile } from "../domain/profile/schema.js";
import { runScan, type ScanDependencies, type ScanResult } from "./run.js";

export interface CoordinatedScan {
  result: ScanResult;
  /**
   * True when this call awaited a scan another call had already started. The
   * caller needs it: the two share one `ScanResult`, so a report that took its
   * Graph request count straight from that shared object would claim a cost
   * this call did not pay.
   */
  joined: boolean;
}

export interface ScanCoordinator {
  run(profile: Profile): Promise<CoordinatedScan>;
}

export interface ScanCoordinatorOptions {
  client: GraphClient;
  store: StateStore;
  now: () => Date;
  /** Injected only by tests. Production always uses `runScan`. */
  scan?: (dependencies: ScanDependencies) => Promise<ScanResult>;
}

/**
 * Single-flight, not a cache. A second call arriving while a scan is running
 * awaits that scan; a second call arriving after it finished starts its own,
 * because the whole reason the tool scans per call is that an agent must not be
 * handed a stale answer.
 *
 * What this prevents is narrow and severe. `runScan` answers a
 * `DeltaResyncRequiredError` by calling `store.clearInventory` and
 * re-enumerating from nothing, and a second call reading `listInventory` inside
 * that window sees an empty or half-built inventory and reports every file in
 * the library as missing. Concurrent scans that do not resync collide
 * harmlessly, applying the same changes idempotently, so this exists for the
 * resync case alone.
 *
 * Keyed on `profileId` rather than on the drive id, because a profile names
 * exactly one site and one library and the profile id is known before the call
 * starts. The drive id is not: it comes back from `resolveDrive` inside
 * `runScan`, by which point the race has already begun.
 *
 * This coordinates within a replica and not across them. `docs/OPEN-ITEMS.md`
 * carries that gap and the one-replica constraint that follows from it.
 */
export function createScanCoordinator(options: ScanCoordinatorOptions): ScanCoordinator {
  const scan = options.scan ?? runScan;
  const inFlight = new Map<string, Promise<ScanResult>>();

  return {
    async run(profile: Profile): Promise<CoordinatedScan> {
      const held = inFlight.get(profile.profileId);
      if (held !== undefined) return { result: await held, joined: true };

      const started = scan({ client: options.client, store: options.store, profile, now: options.now });
      inFlight.set(profile.profileId, started);
      try {
        // Awaited inside the same synchronous block that stored it, so a
        // rejection always has a handler attached and can never surface as an
        // unhandled rejection, which Node 22 answers by ending the process.
        return { result: await started, joined: false };
      } finally {
        // In a `finally` so a failed scan does not leave a rejected promise in
        // the map for every later call to join and fail against.
        inFlight.delete(profile.profileId);
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/scan/coordinator.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing error-path tests**

Create `tests/scan/coordinator.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createScanCoordinator } from "../../src/scan/coordinator.js";
import type { ScanResult } from "../../src/scan/run.js";
import type { GraphClient } from "../../src/graph/client.js";
import type { StateStore } from "../../src/store/types.js";
import type { Profile } from "../../src/domain/profile/schema.js";

const PROFILE = { profileId: "example" } as unknown as Profile;
const client = {} as GraphClient;
const store = {} as StateStore;

function scanResult(): ScanResult {
  return {
    snapshot: { files: [], folderPaths: [], scannedAt: "2026-09-14T00:00:00Z", searchCrossCheckIncluded: false },
    driveId: "drive-1",
    mode: "full",
    resynced: false,
    pages: 1,
    changesApplied: 0,
    graphRequests: 5,
    storeBatches: 0,
    unfilteredFileCount: 0,
    unfilteredFolderCount: 0,
  };
}

describe("createScanCoordinator failures", () => {
  it("fails both calls when the scan they share fails", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async () => {
        await gate;
        throw new Error("delta enumeration failed");
      },
    });

    const first = coordinator.run(PROFILE);
    const second = coordinator.run(PROFILE);
    release?.();

    await expect(first).rejects.toThrow("delta enumeration failed");
    await expect(second).rejects.toThrow("delta enumeration failed");
  });

  it("does not poison the key: a call after a failed scan scans again and can succeed", async () => {
    let attempt = 0;
    const coordinator = createScanCoordinator({
      client,
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
      scan: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("first scan failed");
        return scanResult();
      },
    });

    await expect(coordinator.run(PROFILE)).rejects.toThrow("first scan failed");
    const second = await coordinator.run(PROFILE);

    expect(second.joined).toBe(false);
    expect(second.result.graphRequests).toBe(5);
  });
});
```

- [ ] **Step 6: Run the error-path tests to verify they fail, then pass**

Run: `npx vitest run tests/scan/coordinator.errors.test.ts`
Expected: PASS, 2 tests. They exercise code Step 3 already wrote, so if either fails the `finally` or the await placement is wrong; fix the implementation, not the test.

- [ ] **Step 7: Run the full gates**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/scan/coordinator.ts tests/scan/coordinator.test.ts tests/scan/coordinator.errors.test.ts
git commit -m "feat(scan): single-flight concurrent scans of one profile"
```

---

## Task 3: The output schema and shaping

**Files:**
- Create: `src/tools/reconciliation/output.ts`
- Create: `src/tools/reconciliation/shape.ts`
- Modify: `eslint.config.js` (the `RECONCILE_ENTRY_POINT_PATTERN` group)
- Modify: `tests/lint-guardrails.test.ts`
- Test: `tests/tools/reconciliation/shape.test.ts`
- Test: `tests/tools/reconciliation/shape.errors.test.ts`

**Interfaces:**
- Consumes: `ReconciliationReport`, `ArtifactFinding`, `DuplicateFinding`, `OrphanFinding`, `ClientSummary`, `RejectedWorkbookRow`, `Period` from `src/domain/reconcile/index.js`; `ScanResult` from `src/scan/run.js`.
- Produces:
  - `const MAX_ARTIFACT_FINDINGS = 200`
  - `interface ScanProvenance { scanMode: "full" | "incremental"; resynced: boolean; graphRequestsByThisCall: number; scanSharedWithConcurrentCall: boolean }`
  - `interface ReconcileToolOutput` (fields listed in Step 3)
  - `const RECONCILE_OUTPUT_SCHEMA` satisfying `z.ZodRawShape`
  - `function scanProvenance(result: ScanResult, joined: boolean): ScanProvenance`
  - `function shapeReport(report: ReconciliationReport, provenance: ScanProvenance, options: ShapeOptions): ReconcileToolOutput`
  - `interface ShapeOptions { clients?: readonly string[]; maxArtifacts?: number }`

- [ ] **Step 0: Let a test outside the engine read the engine's golden fixture**

This task's tests are the first in the repo to pin a tool's behavior against the golden report, and the single-entry fence currently refuses them. Its pattern matches the import string as written, so `../../domain/reconcile/fixtures/load.js` is caught by `**/reconcile/**` and is exempted by neither `!**/reconcile/index.js` nor the `tests/domain/reconcile/**` file-level ignore, which covers only tests living inside the engine's own directory.

A fixture loader is not a stage module. Reading a golden JSON file computes no part of the compliance answer, which is the thing the fence exists to keep to one implementation, so this is a carve-out for something the rule was never aimed at rather than a hole in it.

In `eslint.config.js`, add one negation to `RECONCILE_ENTRY_POINT_PATTERN`'s group, after the two existing `index.js` negations:

```js
    "!**/reconcile/fixtures/**",
    "!./reconcile/fixtures/**",
```

and extend the comment block above it with:

```
// The fixtures are exempt for the same reason the engine's own tests are.
// A golden report on disk and the loader that reads it compute no part of
// the compliance answer, so a caller reaching them cannot produce the
// second, drifting answer this rule exists to prevent. Tools are pinned
// against that report, and the alternative is every tool test declaring its
// own fixture, which is how two fixtures start disagreeing.
```

Then add a case to `tests/lint-guardrails.test.ts` asserting that a file at `tests/tools/probe.test.ts` importing `"../domain/reconcile/fixtures/load.js"` produces no `no-restricted-imports` message, alongside the existing cases that assert a stage import does. Follow the shape of the `ruleIdsFor` cases already in that file.

Run: `npx vitest run tests/lint-guardrails.test.ts`
Expected: PASS, including the new case.

- [ ] **Step 1: Write the output schema and its types**

Create `src/tools/reconciliation/output.ts`:

```ts
import { z } from "zod";
import type {
  ArtifactFinding,
  ClientSummary,
  DuplicateFinding,
  OrphanFinding,
  Period,
  RejectedWorkbookRow,
} from "../../domain/reconcile/index.js";

/**
 * The most non-compliant artifact findings one call returns.
 *
 * Findings serialize to roughly 200 bytes each, so 200 of them is on the order
 * of 40 KB, which leaves room for the per-client rollup and the orphan lists
 * alongside it. A report that trips this cap describes a repository in such
 * wholesale disrepair that the per-client counts, which are never truncated,
 * are the useful answer and an enumeration of the first several hundred
 * failures is not.
 *
 * No tool input overrides it. A caller who raises the cap to avoid truncation
 * has removed the only bound on a payload nobody measured.
 */
export const MAX_ARTIFACT_FINDINGS = 200;

/** What this call, specifically, paid for the repository snapshot behind the report. */
export interface ScanProvenance {
  scanMode: "full" | "incremental";
  resynced: boolean;
  /**
   * Named for the call rather than for the scan because those differ. A call
   * that joined a scan another call started reads the same inventory and paid
   * nothing for it, and a field called `graphRequests` on both reports would
   * have two calls claiming one scan's cost.
   */
  graphRequestsByThisCall: number;
  scanSharedWithConcurrentCall: boolean;
}

export interface ReconcileToolOutput {
  profileId: string;
  window: { from: Period; to: Period };
  provenance: {
    scannedAt: string;
    workbookSource: string;
    searchCrossCheckIncluded: boolean;
  } & ScanProvenance;
  scope: {
    /** The clients the caller narrowed to, or null when the report covers every client. */
    clients: string[] | null;
    /** Clients the caller named that the workbook does not track. */
    unknownClients: string[];
    /**
     * True whenever a filter is applied. Unrecognized orphans and empty folders
     * are attributable to no client, so they are still repository-wide and a
     * reader must not take them as scoped to the filter.
     */
    unattributableFindingsRepositoryWide: boolean;
  };
  clients: ClientSummary[];
  /** Non-compliant findings only, capped. The counts in `clients` are never abridged. */
  artifacts: ArtifactFinding[];
  compliantArtifactsOmitted: number;
  artifactsOmittedByCap: number;
  duplicates: DuplicateFinding[];
  orphans: OrphanFinding[];
  emptyFolders: string[];
  rejectedWorkbookRows: RejectedWorkbookRow[];
}

const PeriodSchema = z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) });

const SlotSchema = z.object({
  client: z.string(),
  deliverable: z.string(),
  period: PeriodSchema,
});

const ArtifactStateSchema = z.enum(["compliant", "misnamed", "misplaced", "misnamed_and_misplaced", "missing"]);

const ArtifactSchema = SlotSchema.extend({
  expectedPath: z.string(),
  expectedName: z.string(),
  state: ArtifactStateSchema,
  matched: z
    .object({ path: z.string(), name: z.string(), etag: z.string(), recognizerId: z.string().optional() })
    .optional(),
});

/**
 * Declared as a raw shape rather than a `z.object`, because that is what
 * `ToolDefinition.outputSchema` and the SDK's `registerTool` both take.
 */
export const RECONCILE_OUTPUT_SCHEMA = {
  profileId: z.string().describe("The profile this report was computed for."),
  window: z
    .object({ from: PeriodSchema, to: PeriodSchema })
    .describe("The rolling window the report covers, resolved from the profile and the month it ran in."),
  provenance: z
    .object({
      scannedAt: z.string(),
      workbookSource: z.string(),
      searchCrossCheckIncluded: z
        .boolean()
        .describe(
          "False until the Microsoft Search cross-check ships. While false, a correctly named file stored outside the expected taxonomy is invisible, so every misplaced finding is unreliable and every missing finding is suspect.",
        ),
      scanMode: z.enum(["full", "incremental"]),
      resynced: z.boolean(),
      graphRequestsByThisCall: z.number().int(),
      scanSharedWithConcurrentCall: z.boolean(),
    })
    .describe("Where the two inputs came from, and what this call paid for them."),
  scope: z
    .object({
      clients: z.array(z.string()).nullable(),
      unknownClients: z.array(z.string()),
      unattributableFindingsRepositoryWide: z.boolean(),
    })
    .describe("What the report was narrowed to, and what stayed repository-wide despite the filter."),
  clients: z
    .array(
      z.object({
        client: z.string(),
        counts: z.record(ArtifactStateSchema, z.number().int()),
        compliant: z.boolean(),
      }),
    )
    .describe("Every client in scope with complete counts. Never abridged, and the authoritative answer to whether a client is compliant."),
  artifacts: z
    .array(ArtifactSchema)
    .describe("Non-compliant findings only. Compliant rows are omitted because the counts above already carry them."),
  compliantArtifactsOmitted: z.number().int().describe("How many compliant findings in scope were left out of `artifacts`."),
  artifactsOmittedByCap: z.number().int().describe("How many non-compliant findings in scope exceeded the cap and were left out."),
  duplicates: z
    .array(SlotSchema.omit({ client: true, deliverable: true, period: true }).extend({
      path: z.string(),
      name: z.string(),
      slot: SlotSchema,
      state: z.enum(["compliant", "misnamed", "misplaced", "misnamed_and_misplaced"]),
    }))
    .describe("Extra files that also satisfy a slot already claimed by a better candidate."),
  orphans: z
    .array(
      z.object({
        path: z.string(),
        name: z.string(),
        kind: z.enum(["unrecognized", "unexpected"]),
        parsed: SlotSchema.optional(),
      }),
    )
    .describe("Files with no slot in this report. Unrecognized ones are repository-wide even when a client filter is applied."),
  emptyFolders: z.array(z.string()).describe("Folders holding no files anywhere beneath them. Repository-wide even when a client filter is applied."),
  rejectedWorkbookRows: z
    .array(z.object({ row: z.number().int(), client: z.string().optional(), reason: z.string() }))
    .describe("Workbook rows the reader could not turn into records. A client missing from this report may be here instead."),
} satisfies z.ZodRawShape;
```

- [ ] **Step 2: Write the failing shaping tests**

Create `tests/tools/reconciliation/shape.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadExpectedReport } from "../../domain/reconcile/fixtures/load.js";
import { scanProvenance, shapeReport } from "../../../src/tools/reconciliation/shape.js";
import type { ScanProvenance } from "../../../src/tools/reconciliation/output.js";
import type { ScanResult } from "../../../src/scan/run.js";

const PROVENANCE: ScanProvenance = {
  scanMode: "incremental",
  resynced: false,
  graphRequestsByThisCall: 4,
  scanSharedWithConcurrentCall: false,
};

function scanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    snapshot: { files: [], folderPaths: [], scannedAt: "2026-09-14T00:00:00Z", searchCrossCheckIncluded: false },
    driveId: "drive-1",
    mode: "full",
    resynced: true,
    pages: 2,
    changesApplied: 9,
    graphRequests: 7,
    storeBatches: 3,
    unfilteredFileCount: 9,
    unfilteredFolderCount: 4,
    ...overrides,
  };
}

describe("shapeReport", () => {
  it("omits the compliant findings and says how many, while the counts stay whole", () => {
    const report = loadExpectedReport();

    const output = shapeReport(report, PROVENANCE, {});

    // The golden report holds five compliant findings out of ten.
    expect(output.artifacts).toHaveLength(5);
    expect(output.artifacts.every((artifact) => artifact.state !== "compliant")).toBe(true);
    expect(output.compliantArtifactsOmitted).toBe(5);
    expect(output.clients.find((client) => client.client === "CLIENTA")?.counts.compliant).toBe(3);
  });

  it("covers every client when no filter is given, including one that owes nothing", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, {});

    expect(output.clients.map((client) => client.client)).toEqual(["CLIENTA", "CLIENTB", "CLIENTC"]);
    expect(output.scope.clients).toBeNull();
    expect(output.scope.unattributableFindingsRepositoryWide).toBe(false);
  });

  it("narrows what is attributable to a client and leaves what is not", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["CLIENTA"] });

    expect(output.clients.map((client) => client.client)).toEqual(["CLIENTA"]);
    expect(output.artifacts.every((artifact) => artifact.client === "CLIENTA")).toBe(true);
    // Both golden duplicates belong to CLIENTA and both survive.
    expect(output.duplicates).toHaveLength(2);
    // Of three golden orphans, one is unrecognized and two are CLIENTB and CLIENTC.
    expect(output.orphans.map((orphan) => orphan.kind)).toEqual(["unrecognized"]);
    // Empty folders are attributable to no client and are never filtered.
    expect(output.emptyFolders).toEqual(["2025/CLIENTA", "2026/CLIENTA/04-April"]);
    expect(output.scope.clients).toEqual(["CLIENTA"]);
    expect(output.scope.unattributableFindingsRepositoryWide).toBe(true);
  });

  it("counts the compliant omissions within the filter, not across the whole report", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["CLIENTB"] });

    expect(output.compliantArtifactsOmitted).toBe(2);
    expect(output.artifacts).toHaveLength(0);
  });

  it("truncates at the cap and states the exact number it left out", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { maxArtifacts: 2 });

    expect(output.artifacts).toHaveLength(2);
    expect(output.artifactsOmittedByCap).toBe(3);
  });

  it("reports nothing omitted by the cap when nothing was", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, {});

    expect(output.artifactsOmittedByCap).toBe(0);
  });

  it("carries the report's own provenance through beside the scan's", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, {});

    expect(output.provenance.scannedAt).toBe("2026-07-06T08:30:00Z");
    expect(output.provenance.workbookSource).toContain("Deliverable Tracker.xlsx");
    expect(output.provenance.searchCrossCheckIncluded).toBe(true);
    expect(output.provenance.graphRequestsByThisCall).toBe(4);
  });
});

describe("scanProvenance", () => {
  it("reports what the starting call actually paid", () => {
    expect(scanProvenance(scanResult(), false)).toEqual({
      scanMode: "full",
      resynced: true,
      graphRequestsByThisCall: 7,
      scanSharedWithConcurrentCall: false,
    });
  });

  it("reports zero for a call that joined a scan it did not start", () => {
    const provenance = scanProvenance(scanResult(), true);

    expect(provenance.graphRequestsByThisCall).toBe(0);
    expect(provenance.scanSharedWithConcurrentCall).toBe(true);
    // The scan it joined still resynced, and the report is built on that
    // inventory, so this describes the scan rather than the caller.
    expect(provenance.resynced).toBe(true);
    expect(provenance.scanMode).toBe("full");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/tools/reconciliation/shape.test.ts`
Expected: FAIL, cannot resolve `../../../src/tools/reconciliation/shape.js`.

- [ ] **Step 4: Write the shaping module**

Create `src/tools/reconciliation/shape.ts`:

```ts
import type {
  ArtifactFinding,
  ClientSummary,
  DuplicateFinding,
  OrphanFinding,
  ReconciliationReport,
  RejectedWorkbookRow,
} from "../../domain/reconcile/index.js";
import type { ScanResult } from "../../scan/run.js";
import { MAX_ARTIFACT_FINDINGS, type ReconcileToolOutput, type ScanProvenance } from "./output.js";

export interface ShapeOptions {
  /** Absent means every client. */
  clients?: readonly string[];
  /** Overridden only by tests, so the truncation rule can be exercised on a small fixture. */
  maxArtifacts?: number;
}

/**
 * What this call paid, as distinct from what the scan cost.
 *
 * A joiner reads the same inventory and issued no Graph request of its own, so
 * its count is zero. The scan's own mode and resync flag are carried through
 * unchanged for both, because they describe the inventory the report is built
 * on rather than the caller: a joiner whose scan resynced is reading a
 * rebuilt inventory, and saying otherwise would be false about the data.
 */
export function scanProvenance(result: ScanResult, joined: boolean): ScanProvenance {
  return {
    scanMode: result.mode,
    resynced: result.resynced,
    graphRequestsByThisCall: joined ? 0 : result.graphRequests,
    scanSharedWithConcurrentCall: joined,
  };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Narrows a report to what one caller asked for and drops what the counts
 * already carry.
 *
 * Applied after the engine has run over everything, never before. Filtering the
 * workbook first would leave every other client's files with no slot to match,
 * so the engine would classify them as `unexpected` orphans and a report
 * narrowed to one client would invent orphans for the rest of the library.
 *
 * The filter reaches what is attributable to a client and nothing else.
 * Unrecognized orphans, empty folders and workbook rows too broken to name a
 * client are attributable to none, so they are returned whole, and
 * `scope.unattributableFindingsRepositoryWide` says so rather than leaving a
 * reader to assume the whole payload was scoped.
 */
export function shapeReport(
  report: ReconciliationReport,
  provenance: ScanProvenance,
  options: ShapeOptions,
): ReconcileToolOutput {
  const filter = options.clients === undefined ? undefined : new Set(options.clients);
  const max = options.maxArtifacts ?? MAX_ARTIFACT_FINDINGS;

  const tracked = new Set(report.clients.map((client) => client.client));
  const unknownClients =
    filter === undefined ? [] : [...filter].filter((client) => !tracked.has(client)).sort(compareStrings);

  const inScope = <T>(items: readonly T[], client: (item: T) => string | undefined): T[] =>
    filter === undefined
      ? [...items]
      : items.filter((item) => {
          const owner = client(item);
          // Attributable to no client: kept, because filtering it out would
          // hide a repository-wide problem behind a question about one client.
          return owner === undefined || filter.has(owner);
        });

  const clients: ClientSummary[] = inScope(report.clients, (summary) => summary.client);
  const artifactsInScope: ArtifactFinding[] = inScope(report.artifacts, (artifact) => artifact.client);
  const nonCompliant = artifactsInScope.filter((artifact) => artifact.state !== "compliant");
  const artifacts = nonCompliant.slice(0, max);

  const duplicates: DuplicateFinding[] = inScope(report.duplicates, (duplicate) => duplicate.slot.client);
  const orphans: OrphanFinding[] = inScope(report.orphans, (orphan) => orphan.parsed?.client);
  const rejectedWorkbookRows: RejectedWorkbookRow[] = inScope(report.rejectedWorkbookRows, (row) => row.client);

  return {
    profileId: report.profileId,
    window: report.window,
    provenance: {
      scannedAt: report.provenance.scannedAt,
      workbookSource: report.provenance.workbookSource,
      searchCrossCheckIncluded: report.provenance.searchCrossCheckIncluded,
      ...provenance,
    },
    scope: {
      clients: options.clients === undefined ? null : [...options.clients],
      unknownClients,
      unattributableFindingsRepositoryWide: filter !== undefined,
    },
    clients,
    artifacts,
    compliantArtifactsOmitted: artifactsInScope.length - nonCompliant.length,
    artifactsOmittedByCap: nonCompliant.length - artifacts.length,
    duplicates,
    orphans,
    emptyFolders: [...report.emptyFolders],
    rejectedWorkbookRows,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/tools/reconciliation/shape.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Write the failing error-path tests**

Create `tests/tools/reconciliation/shape.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadExpectedReport } from "../../domain/reconcile/fixtures/load.js";
import { shapeReport } from "../../../src/tools/reconciliation/shape.js";
import type { ScanProvenance } from "../../../src/tools/reconciliation/output.js";

const PROVENANCE: ScanProvenance = {
  scanMode: "incremental",
  resynced: false,
  graphRequestsByThisCall: 1,
  scanSharedWithConcurrentCall: false,
};

describe("shapeReport with a filter that does not match", () => {
  it("names a client the workbook does not track rather than returning a silently empty report", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["NOSUCHCLIENT"] });

    expect(output.scope.unknownClients).toEqual(["NOSUCHCLIENT"]);
    expect(output.clients).toEqual([]);
    expect(output.artifacts).toEqual([]);
  });

  it("separates the tracked half of a mixed filter from the untracked half", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["CLIENTB", "NOSUCHCLIENT"] });

    expect(output.scope.unknownClients).toEqual(["NOSUCHCLIENT"]);
    expect(output.clients.map((client) => client.client)).toEqual(["CLIENTB"]);
  });

  it("reports no unknown clients when every named client is tracked", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["CLIENTA"] });

    expect(output.scope.unknownClients).toEqual([]);
  });

  it("keeps the unattributable findings even when nothing else survives the filter", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["NOSUCHCLIENT"] });

    expect(output.orphans.map((orphan) => orphan.kind)).toEqual(["unrecognized"]);
    expect(output.emptyFolders).toHaveLength(2);
  });

  it("treats an empty client list as a filter matching nothing, not as no filter", () => {
    const output = shapeReport(loadExpectedReport(), PROVENANCE, { clients: [] });

    expect(output.scope.clients).toEqual([]);
    expect(output.scope.unattributableFindingsRepositoryWide).toBe(true);
    expect(output.clients).toEqual([]);
  });
});
```

- [ ] **Step 7: Run the error-path tests**

Run: `npx vitest run tests/tools/reconciliation/shape.errors.test.ts`
Expected: PASS, 5 tests. They exercise code Step 4 already wrote.

- [ ] **Step 8: Run the full gates**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/tools/reconciliation/ tests/tools/reconciliation/ eslint.config.js tests/lint-guardrails.test.ts
git commit -m "feat(tools): shape a reconciliation report for a caller with a context budget"
```

---

## Task 4: The text block

**Files:**
- Create: `src/tools/reconciliation/text.ts`
- Test: `tests/tools/reconciliation/text.test.ts`
- Test: `tests/tools/reconciliation/text.errors.test.ts`

**Interfaces:**
- Consumes: `ReconcileToolOutput` from `src/tools/reconciliation/output.js`.
- Produces: `function reconcileText(output: ReconcileToolOutput): string[]`

Returns lines rather than one string, matching `formatScanResult` in `src/scan/cli.ts`, so a test can assert one sentence without matching around its neighbors. The caller joins with a newline.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/reconciliation/text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadExpectedReport } from "../../domain/reconcile/fixtures/load.js";
import { shapeReport } from "../../../src/tools/reconciliation/shape.js";
import { reconcileText } from "../../../src/tools/reconciliation/text.js";
import type { ScanProvenance } from "../../../src/tools/reconciliation/output.js";

const PROVENANCE: ScanProvenance = {
  scanMode: "incremental",
  resynced: false,
  graphRequestsByThisCall: 4,
  scanSharedWithConcurrentCall: false,
};

function textFor(options: Parameters<typeof shapeReport>[2] = {}): string {
  return reconcileText(shapeReport(loadExpectedReport(), PROVENANCE, options)).join("\n");
}

describe("reconcileText", () => {
  it("names the profile and the resolved window", () => {
    expect(textFor()).toContain('Profile "synthetic-compliance"');
    expect(textFor()).toContain("2026-01 through 2026-06");
  });

  it("says how many clients are compliant out of how many", () => {
    // The golden report has CLIENTB and CLIENTC compliant, CLIENTA not.
    expect(textFor()).toContain("2 of 3 clients are compliant");
  });

  it("counts the non-compliant findings by state", () => {
    const text = textFor();

    expect(text).toContain("2 misnamed");
    expect(text).toContain("1 misplaced");
    expect(text).toContain("1 missing");
  });

  it("says the compliant rows were left out and how many", () => {
    expect(textFor()).toContain("5 compliant findings are not listed");
  });

  it("states that the Search cross-check did not run, in words", () => {
    // The golden fixture has it true, so this is asserted against a report
    // that says it did not run.
    const report = loadExpectedReport();
    report.provenance.searchCrossCheckIncluded = false;

    const text = reconcileText(shapeReport(report, PROVENANCE, {})).join("\n");

    expect(text).toContain("Microsoft Search cross-check did not run");
    expect(text).toContain("every missing finding is suspect");
  });

  it("says nothing about the Search cross-check when it did run", () => {
    expect(textFor()).not.toContain("Search cross-check");
  });

  it("names the scan mode and what this call paid for it", () => {
    expect(textFor()).toContain("incremental scan");
    expect(textFor()).toContain("4 Graph requests");
  });

  it("uses the singular for one Graph request", () => {
    const output = shapeReport(loadExpectedReport(), { ...PROVENANCE, graphRequestsByThisCall: 1 }, {});

    expect(reconcileText(output).join("\n")).toContain("1 Graph request,");
  });

  it("says a joined call issued no Graph request of its own", () => {
    const output = shapeReport(
      loadExpectedReport(),
      { ...PROVENANCE, graphRequestsByThisCall: 0, scanSharedWithConcurrentCall: true },
      {},
    );

    expect(reconcileText(output).join("\n")).toContain("shared a scan already running");
  });

  it("names the filter when one was applied, and says what stayed repository-wide", () => {
    const text = textFor({ clients: ["CLIENTA"] });

    expect(text).toContain('narrowed to "CLIENTA"');
    expect(text).toContain("repository-wide");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools/reconciliation/text.test.ts`
Expected: FAIL, cannot resolve `../../../src/tools/reconciliation/text.js`.

- [ ] **Step 3: Write the formatter**

Create `src/tools/reconciliation/text.ts`:

```ts
import type { ArtifactState, Period } from "../../domain/reconcile/index.js";
import type { ReconcileToolOutput } from "./output.js";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function period(value: Period): string {
  return `${value.year}-${String(value.month).padStart(2, "0")}`;
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

const STATE_LABELS: ReadonlyArray<{ state: Exclude<ArtifactState, "compliant">; label: string }> = [
  { state: "missing", label: "missing" },
  { state: "misnamed", label: "misnamed" },
  { state: "misplaced", label: "misplaced" },
  { state: "misnamed_and_misplaced", label: "both misnamed and misplaced" },
];

/**
 * Every sentence here is derived from the shaped output and from nothing else.
 * That is the message-audit practice made structural rather than remembered: a
 * formatter that cannot see the report cannot describe a report it did not
 * produce, and this project has repeatedly shipped prose that was correct
 * clause by clause and false against what the program had actually done.
 *
 * Two facts are stated in words rather than left as booleans in
 * `structuredContent`, because a field is not a sentence the model will pass
 * on to the person reading its summary: that the Search cross-check did not
 * run, and that findings were truncated.
 */
export function reconcileText(output: ReconcileToolOutput): string[] {
  const lines: string[] = [];

  const scope =
    output.scope.clients === null
      ? "every client in the workbook"
      : output.scope.clients.length === 0
        ? "no clients, because an empty client list was given"
        : `narrowed to ${quoteList(output.scope.clients)}`;

  lines.push(
    `Profile "${output.profileId}", ${period(output.window.from)} through ${period(output.window.to)}, ${scope}.`,
  );

  const compliantClients = output.clients.filter((client) => client.compliant).length;
  lines.push(
    output.clients.length === 0
      ? "No clients are in scope, so there is no compliance result to report."
      : `${compliantClients} of ${plural(output.clients.length, "client is", "clients are")} compliant.`,
  );

  // Tallied over the returned findings rather than over the per-client counts,
  // so this line cannot claim a state the list beneath it does not show. When
  // the cap truncated the list the next line says so, which is what keeps the
  // two readable together.
  const byState = new Map<ArtifactState, number>();
  for (const artifact of output.artifacts) {
    byState.set(artifact.state, (byState.get(artifact.state) ?? 0) + 1);
  }
  const stateParts = STATE_LABELS.flatMap(({ state, label }) => {
    const count = byState.get(state) ?? 0;
    return count === 0 ? [] : [`${count} ${label}`];
  });

  lines.push(
    stateParts.length === 0
      ? "No non-compliant deliverables are listed."
      : `Listed non-compliant deliverables: ${stateParts.join(", ")}.`,
  );

  if (output.artifactsOmittedByCap > 0) {
    lines.push(
      `${plural(output.artifactsOmittedByCap, "further non-compliant finding was", "further non-compliant findings were")} ` +
        "omitted to keep this response bounded. The per-client counts above are complete and were not truncated; " +
        "narrow the call with the clients argument to see the rest.",
    );
  }

  if (output.compliantArtifactsOmitted > 0) {
    lines.push(
      `${plural(output.compliantArtifactsOmitted, "compliant finding is", "compliant findings are")} not listed, ` +
        "by design. The per-client counts above carry them.",
    );
  }

  const extras: string[] = [];
  if (output.duplicates.length > 0) extras.push(plural(output.duplicates.length, "duplicate", "duplicates"));
  if (output.orphans.length > 0) extras.push(plural(output.orphans.length, "orphan", "orphans"));
  if (output.emptyFolders.length > 0) {
    extras.push(plural(output.emptyFolders.length, "empty folder", "empty folders"));
  }
  if (extras.length > 0) {
    lines.push(
      `Also found: ${extras.join(", ")}.` +
        (output.scope.unattributableFindingsRepositoryWide
          ? " Unrecognized orphans and empty folders are repository-wide rather than scoped to the named clients, because neither is attributable to a client."
          : ""),
    );
  }

  if (output.rejectedWorkbookRows.length > 0) {
    lines.push(
      `${plural(output.rejectedWorkbookRows.length, "workbook row was", "workbook rows were")} rejected and could ` +
        "not be reconciled. A client absent from this report may be one of them rather than compliant.",
    );
  }

  if (output.scope.unknownClients.length > 0) {
    lines.push(
      `${quoteList(output.scope.unknownClients)} ${output.scope.unknownClients.length === 1 ? "is" : "are"} ` +
        "not in the workbook, so nothing was reconciled for it. That is not the same as having nothing outstanding.",
    );
  }

  if (!output.provenance.searchCrossCheckIncluded) {
    lines.push(
      "The Microsoft Search cross-check did not run. Without it a correctly named file stored outside the " +
        "expected taxonomy is invisible to this scan, so every misplaced finding is unreliable and every missing " +
        "finding is suspect.",
    );
  }

  const cost = output.provenance.scanSharedWithConcurrentCall
    ? "issued no Graph request of its own because it shared a scan already running"
    : `${plural(output.provenance.graphRequestsByThisCall, "Graph request", "Graph requests")}, this call`;

  lines.push(
    `Repository read by ${output.provenance.scanMode} scan at ${output.provenance.scannedAt}` +
      `${output.provenance.resynced ? ", after a delta resync forced a full re-enumeration" : ""}. ` +
      `This call ${output.provenance.scanSharedWithConcurrentCall ? cost : `cost ${cost}`}. ` +
      `Workbook read from ${output.provenance.workbookSource}.`,
  );

  return lines;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tools/reconciliation/text.test.ts`
Expected: PASS, 10 tests. The final line's phrasing is the likeliest thing to fail: read the assembled sentence for each of the two branches and fix the builder rather than loosening the assertion.

- [ ] **Step 5: Write the failing message-audit tests**

Create `tests/tools/reconciliation/text.errors.test.ts`. These are the message audit: each one hands the formatter an output that contradicts the sentence under test.

```ts
import { describe, expect, it } from "vitest";
import { loadExpectedReport } from "../../domain/reconcile/fixtures/load.js";
import { shapeReport } from "../../../src/tools/reconciliation/shape.js";
import { reconcileText } from "../../../src/tools/reconciliation/text.js";
import type { ReconcileToolOutput, ScanProvenance } from "../../../src/tools/reconciliation/output.js";

const PROVENANCE: ScanProvenance = {
  scanMode: "incremental",
  resynced: false,
  graphRequestsByThisCall: 4,
  scanSharedWithConcurrentCall: false,
};

function emptyOutput(): ReconcileToolOutput {
  const output = shapeReport(loadExpectedReport(), PROVENANCE, {});
  return {
    ...output,
    clients: [],
    artifacts: [],
    compliantArtifactsOmitted: 0,
    artifactsOmittedByCap: 0,
    duplicates: [],
    orphans: [],
    emptyFolders: [],
    rejectedWorkbookRows: [],
  };
}

describe("reconcileText says nothing it cannot observe", () => {
  it("does not claim a compliance ratio when no client is in scope", () => {
    const text = reconcileText(emptyOutput()).join("\n");

    expect(text).toContain("no compliance result to report");
    expect(text).not.toMatch(/\d+ of \d+ client/);
  });

  it("does not list a state that no returned finding carries", () => {
    const text = reconcileText(emptyOutput()).join("\n");

    expect(text).toContain("No non-compliant deliverables are listed");
    expect(text).not.toContain("misnamed");
  });

  it("says nothing about truncation when nothing was truncated", () => {
    expect(reconcileText(emptyOutput()).join("\n")).not.toContain("omitted to keep this response bounded");
  });

  it("says nothing about compliant omissions when none were omitted", () => {
    expect(reconcileText(emptyOutput()).join("\n")).not.toContain("not listed");
  });

  it("says nothing about duplicates, orphans or empty folders when there are none", () => {
    expect(reconcileText(emptyOutput()).join("\n")).not.toContain("Also found");
  });

  it("does not claim findings are repository-wide when no filter was applied", () => {
    const text = reconcileText(shapeReport(loadExpectedReport(), PROVENANCE, {})).join("\n");

    expect(text).not.toContain("repository-wide");
  });

  it("reports a resync in the scan line only when one happened", () => {
    const clean = reconcileText(shapeReport(loadExpectedReport(), PROVENANCE, {})).join("\n");
    const resynced = reconcileText(
      shapeReport(loadExpectedReport(), { ...PROVENANCE, resynced: true }, {}),
    ).join("\n");

    expect(clean).not.toContain("resync");
    expect(resynced).toContain("after a delta resync forced a full re-enumeration");
  });

  it("does not report a Graph cost for a call that paid none", () => {
    const text = reconcileText(
      shapeReport(
        loadExpectedReport(),
        { ...PROVENANCE, graphRequestsByThisCall: 0, scanSharedWithConcurrentCall: true },
        {},
      ),
    ).join("\n");

    expect(text).not.toMatch(/cost \d+ Graph request/);
    expect(text).toContain("issued no Graph request of its own");
  });

  it("uses the singular for one rejected workbook row and one unknown client", () => {
    const base = shapeReport(loadExpectedReport(), PROVENANCE, { clients: ["NOSUCHCLIENT"] });
    const output: ReconcileToolOutput = {
      ...base,
      rejectedWorkbookRows: [{ row: 4, client: "CLIENTD", reason: "effectiveFrom is not an ISO date" }],
    };

    const text = reconcileText(output).join("\n");

    expect(text).toContain("1 workbook row was rejected");
    expect(text).toContain('"NOSUCHCLIENT" is');
    expect(text).not.toContain("rows were rejected");
  });
});
```

- [ ] **Step 6: Run the message-audit tests**

Run: `npx vitest run tests/tools/reconciliation/text.errors.test.ts`
Expected: PASS, 9 tests. Any failure here is a false sentence, not a strict test. Fix `text.ts`.

Note the fourth test: `"not listed"` appears in the compliant-omission sentence and must not appear anywhere else, so if a different sentence uses that phrase, change that sentence rather than the assertion.

- [ ] **Step 7: Run the full gates**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/tools/reconciliation/text.ts tests/tools/reconciliation/text.test.ts tests/tools/reconciliation/text.errors.test.ts
git commit -m "feat(tools): summarize a reconciliation report in prose an operator can act on"
```

---

## Task 5: Failure messages

**Files:**
- Create: `src/tools/errors.ts`
- Test: `tests/tools/errors.test.ts`
- Test: `tests/tools/errors.errors.test.ts`

**Interfaces:**
- Consumes: `UnknownProfileError` from `src/profiles/registry.js`; `LibraryNotFoundError` from `src/graph/drive.js`; `WorkbookMappingError` from `src/workbook/read.js`; `GraphRequestError` from `src/graph/errors.js`; `TokenRequestError` from `src/graph/token.js`.
- Produces:
  - `interface FailureSubject { profileId: string; siteUrl?: string; library?: string }`
  - `function describeToolFailure(error: unknown, subject: FailureSubject): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeToolFailure } from "../../src/tools/errors.js";
import { UnknownProfileError } from "../../src/profiles/registry.js";
import { LibraryNotFoundError } from "../../src/graph/drive.js";
import { WorkbookMappingError } from "../../src/workbook/read.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { TokenRequestError } from "../../src/graph/token.js";

const SUBJECT = {
  profileId: "example",
  siteUrl: "https://contoso.sharepoint.com/sites/Example",
  library: "Compliance Reports",
};

describe("describeToolFailure", () => {
  it("passes an unknown profile through, since it already names the configured ids", () => {
    const message = describeToolFailure(new UnknownProfileError("nope", ["example", "other"]), {
      profileId: "nope",
    });

    expect(message).toContain('"example", "other"');
    expect(message).toContain('No profile named "nope"');
  });

  it("names the site and library from the profile when the library will not resolve", () => {
    const message = describeToolFailure(new LibraryNotFoundError("Compliance Reports", ["Documents"], 1), SUBJECT);

    expect(message).toContain('profile "example"');
    expect(message).toContain("https://contoso.sharepoint.com/sites/Example");
    expect(message).toContain('"Compliance Reports"');
    expect(message).toContain('"Documents"');
  });

  it("passes a workbook mapping message through unchanged and says which profile it came from", () => {
    const original = 'The mapping names a column "Client Code" that the sheet does not have.';

    const message = describeToolFailure(new WorkbookMappingError(original), SUBJECT);

    expect(message).toContain(original);
    expect(message).toContain('workbook mapping in profile "example"');
  });

  it("reports a Graph failure by status, code and request, and guesses at no cause", () => {
    const error = new GraphRequestError({
      method: "GET",
      path: "/drives/drive-1/root/delta",
      status: 403,
      body: JSON.stringify({ error: { code: "accessDenied", message: "Access denied" } }),
    });

    const message = describeToolFailure(error, SUBJECT);

    expect(message).toContain("403");
    expect(message).toContain("accessDenied");
    expect(message).toContain("GET /drives/drive-1/root/delta");
    expect(message).toContain("written to the server log");
  });

  it("reports a token failure as being about the server application's own credentials", () => {
    const message = describeToolFailure(new TokenRequestError({ status: 401, body: "{}" }), SUBJECT);

    expect(message).toContain("client id and secret");
    expect(message).not.toContain("signed-in operator has");
  });

  it("reports an unrecognized error by its own message rather than inventing a category", () => {
    expect(describeToolFailure(new Error("socket hang up"), SUBJECT)).toContain("socket hang up");
  });

  it("reports a thrown non-error without crashing on it", () => {
    expect(describeToolFailure("not an error object", SUBJECT)).toContain("not an error object");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools/errors.test.ts`
Expected: FAIL, cannot resolve `../../src/tools/errors.js`.

- [ ] **Step 3: Write the failure describer**

Create `src/tools/errors.ts`:

```ts
import { GraphRequestError } from "../graph/errors.js";
import { LibraryNotFoundError } from "../graph/drive.js";
import { TokenRequestError } from "../graph/token.js";
import { WorkbookMappingError } from "../workbook/read.js";
import { UnknownProfileError } from "../profiles/registry.js";

/**
 * What the failing call was about, for the messages that can name it. The site
 * and library are absent when the failure was resolving the profile itself,
 * because at that point this server does not know them.
 */
export interface FailureSubject {
  profileId: string;
  siteUrl?: string;
  library?: string;
}

/**
 * Turns a failure into something an operator can act on, naming only what this
 * server observed.
 *
 * Nothing here infers a cause from a status. A 403 from Graph has several
 * remedies and this server cannot tell which applies, and a message that picks
 * one sends the operator to check the wrong thing. The setup command already
 * produced that defect and it is recorded in `docs/OPEN-ITEMS.md`.
 */
export function describeToolFailure(error: unknown, subject: FailureSubject): string {
  if (error instanceof UnknownProfileError) {
    // Already names the configured ids, which is the whole remedy.
    return error.message;
  }

  if (error instanceof LibraryNotFoundError) {
    const where =
      subject.siteUrl === undefined
        ? `Profile "${subject.profileId}" is what names the library.`
        : `Profile "${subject.profileId}" names site ${subject.siteUrl} and library "${subject.library ?? error.library}".`;
    return `${error.message} ${where}`;
  }

  if (error instanceof WorkbookMappingError) {
    // Passed through verbatim. That message was written for this reader,
    // against the sheet it read, and has its own tests; rewording it here
    // would produce a second, worse description of the same thing. The
    // attribution is a separate sentence for that reason.
    return `${error.message} This came from the workbook mapping in profile "${subject.profileId}".`;
  }

  if (error instanceof TokenRequestError) {
    return (
      `Acquiring a Microsoft Graph token failed with ${error.status}. This is about the server application's own ` +
      "client id and secret rather than about the site, the profile, or whoever asked the question."
    );
  }

  if (error instanceof GraphRequestError) {
    return (
      `Microsoft Graph refused ${error.method} ${error.path} with ${error.status}` +
      `${error.code === undefined ? "" : ` (${error.code})`}, while reconciling profile "${subject.profileId}". ` +
      "The full Graph response was written to the server log. This server does not infer a cause from the status."
    );
  }

  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tools/errors.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing message-audit tests**

Create `tests/tools/errors.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeToolFailure } from "../../src/tools/errors.js";
import { LibraryNotFoundError } from "../../src/graph/drive.js";
import { GraphRequestError } from "../../src/graph/errors.js";

describe("describeToolFailure says nothing it cannot observe", () => {
  it("does not name a site it was not given", () => {
    const message = describeToolFailure(new LibraryNotFoundError("Reports", ["Documents"], 1), {
      profileId: "example",
    });

    expect(message).not.toContain("names site");
    expect(message).toContain('Profile "example" is what names the library');
  });

  it("omits the parenthesized code when Graph returned a body carrying none", () => {
    const error = new GraphRequestError({ method: "GET", path: "/sites/x", status: 502, body: "<html>bad gateway</html>" });

    const message = describeToolFailure(error, { profileId: "example" });

    expect(message).toContain("502");
    expect(message).not.toContain("(undefined)");
    expect(message).not.toContain("()");
  });

  it("does not reproduce a Graph response body in the tool result", () => {
    const error = new GraphRequestError({
      method: "GET",
      path: "/sites/x",
      status: 500,
      body: JSON.stringify({ error: { code: "internalServerError", message: "SECRET-LOOKING-DETAIL" } }),
    });

    expect(describeToolFailure(error, { profileId: "example" })).not.toContain("SECRET-LOOKING-DETAIL");
  });
});
```

- [ ] **Step 6: Run the message-audit tests**

Run: `npx vitest run tests/tools/errors.errors.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Run the full gates**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/tools/errors.ts tests/tools/errors.test.ts tests/tools/errors.errors.test.ts
git commit -m "feat(tools): describe a tool failure without guessing at its cause"
```

---

## Task 6: Server configuration

**Files:**
- Modify: `src/server/config.ts`
- Test: `tests/server/config.test.ts` (create)
- Test: `tests/server/config.errors.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ServerConfig` gains `profileDir: string`. `loadConfig(env)` throws when `IW_PROFILE_DIR` is absent or blank.

`main.ts` reads only `port` and `allowWrites` today, so widening the return type does not break it. The Graph credentials and the store connection string are already loaded by `src/config.ts` and are wired into `main.ts` in Task 7.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";

describe("loadConfig", () => {
  it("reads the profile directory alongside the port and the write gate", () => {
    const config = loadConfig({ PORT: "8080", IW_ALLOW_WRITES: "true", IW_PROFILE_DIR: "/etc/iw/profiles" });

    expect(config).toEqual({ port: 8080, allowWrites: true, profileDir: "/etc/iw/profiles" });
  });

  it("keeps the port default and the writes-disabled default", () => {
    const config = loadConfig({ IW_PROFILE_DIR: "profiles" });

    expect(config.port).toBe(3000);
    expect(config.allowWrites).toBe(false);
  });

  it("trims a profile directory given with surrounding whitespace", () => {
    expect(loadConfig({ IW_PROFILE_DIR: "  profiles  " }).profileDir).toBe("profiles");
  });
});
```

Create `tests/server/config.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";

describe("loadConfig rejections", () => {
  it("refuses to start without a profile directory, naming the variable", () => {
    expect(() => loadConfig({})).toThrow(/IW_PROFILE_DIR/);
  });

  it("treats a blank profile directory as absent rather than as the current directory", () => {
    expect(() => loadConfig({ IW_PROFILE_DIR: "   " })).toThrow(/IW_PROFILE_DIR/);
  });

  it("still rejects a port that is not an integer", () => {
    expect(() => loadConfig({ PORT: "3000abc", IW_PROFILE_DIR: "profiles" })).toThrow(/PORT/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/server/config.test.ts tests/server/config.errors.test.ts`
Expected: FAIL on the profile directory cases; `profileDir` is not on `ServerConfig`.

- [ ] **Step 3: Extend the config**

In `src/server/config.ts`, add `profileDir: string` to `ServerConfig`, and inside `loadConfig`, before the return:

```ts
  // Required, and checked at startup rather than on the first tool call. A
  // profile mistake does not surface as an error: it surfaces as a wrong
  // compliance finding weeks later, which is far more expensive to diagnose
  // than a deployment that refused to start.
  const profileDir = env.IW_PROFILE_DIR?.trim();
  if (profileDir === undefined || profileDir.length === 0) {
    throw new Error(
      "IW_PROFILE_DIR is required: it names the directory holding this deployment's profile files. " +
        "Profiles are deployment configuration and are never committed, so there is no default to fall back to.",
    );
  }
```

and return `{ port, allowWrites: env.IW_ALLOW_WRITES === "true", profileDir }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/server/config.test.ts tests/server/config.errors.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full gates**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/config.ts tests/server/config.test.ts tests/server/config.errors.test.ts
git commit -m "feat(server): require a profile directory at startup"
```

---

## Task 7: The tool execution layer

**Files:**
- Create: `src/tools/context.ts`
- Create: `tests/tools/fake-context.ts`
- Modify: `src/tools/types.ts`
- Modify: `src/mcp/build-server.ts`
- Modify: `src/server/main.ts`
- Modify: `tests/server/write-gate.errors.test.ts:11`
- Modify: `tests/tools/wire-contract.test.ts:30`
- Test: `tests/mcp/build-server.test.ts` (create)
- Test: `tests/mcp/build-server.errors.test.ts` (create)

**Interfaces:**
- Consumes: `ProfileRegistry` (Task 1), `ScanCoordinator` (Task 2), `GraphClient`, `StateStore`.
- Produces:
  - `interface ToolContext { profiles: ProfileRegistry; graph: GraphClient; store: StateStore; scans: ScanCoordinator; now: () => Date }`
  - `type ToolHandler = (input: unknown, context: ToolContext) => Promise<CallToolResult>`
  - `ToolDefinition` gains `handler?: ToolHandler`
  - `BuildServerOptions` gains a required `context: ToolContext`
  - `function createFakeToolContext(overrides?: Partial<ToolContext>): ToolContext` in `tests/tools/fake-context.ts`

- [ ] **Step 1: Write the context types**

Create `src/tools/context.ts`:

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GraphClient } from "../graph/client.js";
import type { StateStore } from "../store/types.js";
import type { ProfileRegistry } from "../profiles/registry.js";
import type { ScanCoordinator } from "../scan/coordinator.js";

/**
 * The dependencies a tool handler may use, built once per process and shared by
 * every per-request server.
 *
 * Shared rather than rebuilt per request, and that does not contradict the
 * locked decision that a fresh `McpServer` is built per request. That decision
 * is about MCP protocol state, which stateless mode has no session to scope.
 * A Graph client and a table client are not protocol state, and rebuilding them
 * per request would discard the token provider's cache and mint a new
 * client-credentials token on every tool call.
 */
export interface ToolContext {
  profiles: ProfileRegistry;
  graph: GraphClient;
  store: StateStore;
  scans: ScanCoordinator;
  now: () => Date;
}

/**
 * Takes `unknown` rather than the type the tool's own input schema implies.
 * The SDK validates against that schema before calling, but a handler is also
 * a plain function this repo tests directly, without the SDK in the way, so it
 * validates its own input with its own schema. The duplicate parse is cheap
 * and it is what lets the handler be tested as a function.
 */
export type ToolHandler = (input: unknown, context: ToolContext) => Promise<CallToolResult>;
```

- [ ] **Step 2: Add the handler to the tool definition**

In `src/tools/types.ts`, add the import and the optional field:

```ts
import type { ToolHandler } from "./context.js";
```

and inside `ToolDefinition`:

```ts
  /**
   * Absent means this tool is still a stub. Keeping it optional is what lets
   * the nine unwired tools stay exactly as they are while the tenth becomes
   * real, rather than requiring nine placeholder handlers that each assert
   * something they cannot do.
   */
  handler?: ToolHandler;
```

- [ ] **Step 3: Write the failing build-server tests**

Create `tests/mcp/build-server.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../../src/mcp/build-server.js";
import { createFakeToolContext } from "../tools/fake-context.js";
import { ALL_TOOLS } from "../../src/tools/registry.js";
import type { ToolDefinition } from "../../src/tools/types.js";

async function callTool(definitions: ToolDefinition[], name: string, args: Record<string, unknown>) {
  const server = buildServer({ allowWrites: true, context: createFakeToolContext(), tools: definitions });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

const HANDLED: ToolDefinition = {
  name: "handled_tool",
  kind: "read",
  title: "Handled",
  description: "A tool with a handler. Read-only: this tool makes no changes and is safe to repeat.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { echo: z.string().describe("Text to echo back, for example \"hello\".") },
  outputSchema: { echoed: z.string().describe("What came in, for example \"hello\".") },
  handler: async (input) => {
    const { echo } = z.object({ echo: z.string() }).parse(input);
    return { structuredContent: { echoed: echo }, content: [{ type: "text" as const, text: echo }] };
  },
};

const STUBBED: ToolDefinition = { ...HANDLED, name: "stubbed_tool" };
delete (STUBBED as { handler?: unknown }).handler;

describe("buildServer", () => {
  it("routes a call to the tool's own handler when it has one", async () => {
    const result = await callTool([HANDLED], "handled_tool", { echo: "hello" });

    expect(result.structuredContent).toEqual({ echoed: "hello" });
  });

  it("hands the shared context to the handler", async () => {
    let sawProfileIds: string[] | undefined;
    const spy: ToolDefinition = {
      ...HANDLED,
      handler: async (_input, context) => {
        sawProfileIds = context.profiles.ids();
        return { structuredContent: { echoed: "ok" }, content: [{ type: "text" as const, text: "ok" }] };
      },
    };

    await callTool([spy], "handled_tool", { echo: "hello" });

    expect(sawProfileIds).toEqual(["example"]);
  });

  it("still serves the stub answer for a tool with no handler", async () => {
    const result = await callTool([STUBBED], "stubbed_tool", { echo: "hello" });

    expect(result.structuredContent).toMatchObject({ stub: true });
  });

  it("defaults to the full registry when no tool list is given", () => {
    const server = buildServer({ allowWrites: true, context: createFakeToolContext() });

    expect(server).toBeDefined();
    expect(ALL_TOOLS.length).toBeGreaterThan(0);
  });
});
```

Note the new optional `tools` field on `BuildServerOptions`. It exists so this suite can exercise the dispatch with definitions it controls, rather than by mutating the shared registry, which would leak into every other suite in the same process.

- [ ] **Step 4: Write the fake context helper**

Create `tests/tools/fake-context.ts`:

```ts
import { readFileSync } from "node:fs";
import { createProfileRegistry } from "../../src/profiles/registry.js";
import { createMemoryStateStore } from "../../src/store/memory.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { GraphClient } from "../../src/graph/client.js";
import type { ScanCoordinator } from "../../src/scan/coordinator.js";

/**
 * A context whose dependencies do nothing useful, for suites that exercise the
 * wiring rather than the work. Every member throws or returns empty rather
 * than pretending to succeed, so a test that accidentally depends on one fails
 * loudly instead of asserting against a fabricated result.
 */
export function createFakeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const graph: GraphClient = {
    get: () => Promise.reject(new Error("the fake Graph client was called")),
    post: () => Promise.reject(new Error("the fake Graph client was called")),
    requests: () => 0,
  };

  const scans: ScanCoordinator = {
    run: () => Promise.reject(new Error("the fake scan coordinator was called")),
  };

  return {
    profiles: createProfileRegistry([
      { source: "example.json", contents: JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown },
    ]),
    graph,
    store: createMemoryStateStore(),
    scans,
    now: () => new Date("2026-09-14T12:00:00Z"),
    ...overrides,
  };
}
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run tests/mcp/build-server.test.ts`
Expected: FAIL, `buildServer` does not accept `context` or `tools`.

- [ ] **Step 6: Rewrite build-server**

Replace the body of `src/mcp/build-server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { selectTools } from "../tools/registry.js";
import type { ToolContext } from "../tools/context.js";
import type { ToolDefinition } from "../tools/types.js";

export interface BuildServerOptions {
  allowWrites: boolean;
  /**
   * Required rather than optional. A server built without dependencies would
   * silently serve a stub for a tool that does have a handler, and a stub
   * answer to a compliance question is a confident wrong answer with no signal
   * attached. Required means a deployment that cannot reconcile fails to start.
   */
  context: ToolContext;
  /** Overridden only by tests, which need definitions they control. */
  tools?: ToolDefinition[];
}

export const SERVER_NAME = "ironwright-repo-reconciliation";
export const SERVER_VERSION = "0.1.0";

/**
 * Builds a fresh server. Callers must build one per HTTP request: SDK versions
 * from 1.26 onward treat a reused instance as a cross-request data leak risk,
 * and stateless mode has no session to scope state to. The context handed in is
 * deliberately not per request; see `src/tools/context.ts`.
 */
export function buildServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const available = opts.tools ?? selectTools(opts.allowWrites);
  const tools = opts.tools === undefined ? available : available.filter((tool) => opts.allowWrites || tool.kind !== "write");

  for (const tool of tools) {
    const message = `${tool.name} is registered but not implemented yet.`;
    const handler = tool.handler;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      handler === undefined
        ? () => ({
            structuredContent: { stub: true as const, message },
            content: [{ type: "text" as const, text: message }],
          })
        : (input: unknown) => handler(input, opts.context),
    );
  }

  return server;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/mcp/build-server.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Establish what the SDK does with an `isError` result**

This is the spec's open question and it must be answered by observation, not assumption. Create `tests/mcp/build-server.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../../src/mcp/build-server.js";
import { createFakeToolContext } from "../tools/fake-context.js";
import type { ToolDefinition } from "../../src/tools/types.js";

const FAILING: ToolDefinition = {
  name: "failing_tool",
  kind: "read",
  title: "Failing",
  description: "Always fails. Read-only: this tool makes no changes and is safe to repeat.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { any: z.string().describe("Ignored, for example \"x\".") },
  outputSchema: { required: z.string().describe("Never produced on the error path, for example \"x\".") },
  handler: async () => ({
    isError: true,
    content: [{ type: "text" as const, text: "the thing failed for a reason the operator can act on" }],
  }),
};

describe("a handler that fails", () => {
  it("reaches the client as a tool error rather than a transport fault, despite declaring an output schema", async () => {
    const server = buildServer({ allowWrites: true, context: createFakeToolContext(), tools: [FAILING] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({ name: "failing_tool", arguments: { any: "x" } });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("the operator can act on");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
```

- [ ] **Step 9: Run it and act on what it shows**

Run: `npx vitest run tests/mcp/build-server.errors.test.ts`

If it PASSES, an `isError` result is exempt from output-schema validation. Record that in a comment above `ToolHandler` in `src/tools/context.ts`, naming the SDK version from `package.json`, and continue.

If it FAILS with a schema-validation error, the fallback from the spec applies: widen `RECONCILE_OUTPUT_SCHEMA` in `src/tools/reconciliation/output.ts` so every field is optional and add a required `ok: z.boolean()` discriminator, set `ok: true` in `shapeReport`'s return, and have the error path return `{ isError: true, structuredContent: { ok: false }, content: [...] }`. Update `ReconcileToolOutput` and Task 3's tests to match. Do not skip the test or loosen the assertion.

- [ ] **Step 10: Update the two existing call sites and the server's composition root**

`tests/server/write-gate.errors.test.ts:11` becomes:

```ts
  const app = createApp({ serverFactory: () => buildServer({ allowWrites, context: createFakeToolContext() }) });
```

with `import { createFakeToolContext } from "../tools/fake-context.js";` added.

`tests/tools/wire-contract.test.ts:30` becomes:

```ts
  const app = createApp({ serverFactory: () => buildServer({ allowWrites: true, context: createFakeToolContext() }) });
```

with the same import.

Replace the top of `src/server/main.ts`:

```ts
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "../mcp/build-server.js";
import { loadGraphCredentials, loadStoreConnectionString } from "../config.js";
import { loadProfileDirectory } from "../profiles/registry.js";
import { createGraphClient } from "../graph/client.js";
import { clientCredentialsTokenProvider } from "../graph/token.js";
import { createMemoryStateStore } from "../store/memory.js";
import { ensureTables, tableStateStoreFromConnectionString } from "../store/table.js";
import { createScanCoordinator } from "../scan/coordinator.js";
import type { StateStore } from "../store/types.js";
import type { ToolContext } from "../tools/context.js";

const config = loadConfig(process.env);
const credentials = loadGraphCredentials(process.env);
const connectionString = loadStoreConnectionString(process.env);

// Everything that can fail on configuration fails here, before the port is
// bound, so a container that cannot answer a call never reports itself healthy.
const profiles = await loadProfileDirectory(config.profileDir);

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

const graph = createGraphClient({ tokenProvider: clientCredentialsTokenProvider(credentials) });
const now = (): Date => new Date();

// Built once and shared by every per-request server. See src/tools/context.ts.
const context: ToolContext = {
  profiles,
  graph,
  store,
  scans: createScanCoordinator({ client: graph, store, now }),
  now,
};

const app = createApp({
  serverFactory: () => buildServer({ allowWrites: config.allowWrites, context }),
});

const server = app.listen(config.port, () => {
  console.log(
    `listening on port ${config.port}, writes ${config.allowWrites ? "enabled" : "disabled"}, ` +
      `${profiles.ids().length} profile(s) from ${config.profileDir}, ${storeKind} store`,
  );
});
```

Leave the `SIGTERM` handler below it unchanged. Top-level `await` is available: the package is ESM and the module target is NodeNext.

- [ ] **Step 11: Run the full gates**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass. The startup log line is prose an operator reads, so check it against a run with one profile and against a run with two before calling this done: `"1 profile(s)"` is acceptable only because the parenthesized plural is honest for both. If you change it to a real plural, cover both counts.

- [ ] **Step 12: Commit**

```bash
git add src/tools/context.ts src/tools/types.ts src/mcp/build-server.ts src/server/main.ts tests/tools/fake-context.ts tests/mcp/ tests/server/write-gate.errors.test.ts tests/tools/wire-contract.test.ts
git commit -m "feat(tools): dispatch a tool call to a handler over a shared context"
```

---

## Task 8: The reconcile handler, wired

**Files:**
- Create: `src/tools/reconciliation/run.ts`
- Modify: `src/tools/definitions/reconcile.ts`
- Test: `tests/tools/reconciliation/run.test.ts`
- Test: `tests/tools/reconciliation/run.errors.test.ts`
- Test: `tests/tools/reconciliation/wire.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 through 7, plus `reconcile` from `src/domain/reconcile/index.js` and `readWorkbookSnapshot` from `src/scan/workbook.js`.
- Produces:
  - `const RECONCILE_INPUT_SCHEMA` (the existing shape, moved so the handler can parse with it)
  - `function periodFromDate(date: Date): Period`
  - `function runReconcile(input: unknown, context: ToolContext, readWorkbook?): Promise<CallToolResult>`

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/reconciliation/run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { periodFromDate, runReconcile } from "../../../src/tools/reconciliation/run.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import type { ToolContext } from "../../../src/tools/context.js";
import type { WorkbookSnapshot } from "../../../src/domain/reconcile/index.js";
import type { ScanResult } from "../../../src/scan/run.js";

const WORKBOOK: WorkbookSnapshot = {
  rows: [{ client: "ACME", fields: { safety: true } }],
  rejectedRows: [],
  source: "/Trackers/Workbook.xlsx#Roster in Compliance Reports",
};

function contextWith(overrides: Partial<ToolContext> = {}, scan?: Partial<ScanResult>): ToolContext {
  const result: ScanResult = {
    snapshot: { files: [], folderPaths: [], scannedAt: "2026-09-14T09:00:00Z", searchCrossCheckIncluded: false },
    driveId: "drive-1",
    mode: "incremental",
    resynced: false,
    pages: 1,
    changesApplied: 0,
    graphRequests: 6,
    storeBatches: 0,
    unfilteredFileCount: 0,
    unfilteredFolderCount: 0,
    ...scan,
  };

  return createFakeToolContext({
    scans: { run: async () => ({ result, joined: false }) },
    ...overrides,
  });
}

describe("periodFromDate", () => {
  it("reads the month in UTC, so the report does not depend on the host's region", () => {
    expect(periodFromDate(new Date("2026-03-01T00:30:00Z"))).toEqual({ year: 2026, month: 3 });
    expect(periodFromDate(new Date("2026-12-31T23:59:59Z"))).toEqual({ year: 2026, month: 12 });
  });
});

describe("runReconcile", () => {
  it("returns a structured report and a text block", async () => {
    const result = await runReconcile({ profileId: "example" }, contextWith(), async () => WORKBOOK);

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { profileId: string };
    expect(structured.profileId).toBe("example");
    expect(JSON.stringify(result.content)).toContain('Profile "example"');
  });

  it("reads the workbook before scanning, so a bad mapping costs no enumeration", async () => {
    const order: string[] = [];
    const context = contextWith({
      scans: {
        run: async () => {
          order.push("scan");
          return {
            result: {
              snapshot: { files: [], folderPaths: [], scannedAt: "2026-09-14T09:00:00Z", searchCrossCheckIncluded: false },
              driveId: "drive-1",
              mode: "incremental" as const,
              resynced: false,
              pages: 1,
              changesApplied: 0,
              graphRequests: 1,
              storeBatches: 0,
              unfilteredFileCount: 0,
              unfilteredFolderCount: 0,
            },
            joined: false,
          };
        },
      },
    });

    await runReconcile({ profileId: "example" }, context, async () => {
      order.push("workbook");
      return WORKBOOK;
    });

    expect(order).toEqual(["workbook", "scan"]);
  });

  it("reports the Graph cost this call actually paid", async () => {
    const result = await runReconcile({ profileId: "example" }, contextWith(), async () => WORKBOOK);
    const structured = result.structuredContent as { provenance: { graphRequestsByThisCall: number } };

    expect(structured.provenance.graphRequestsByThisCall).toBe(6);
  });

  it("reports zero Graph requests for a call that joined a scan it did not start", async () => {
    const context = createFakeToolContext({
      scans: {
        run: async () => ({
          result: {
            snapshot: { files: [], folderPaths: [], scannedAt: "2026-09-14T09:00:00Z", searchCrossCheckIncluded: false },
            driveId: "drive-1",
            mode: "full" as const,
            resynced: false,
            pages: 1,
            changesApplied: 0,
            graphRequests: 42,
            storeBatches: 0,
            unfilteredFileCount: 0,
            unfilteredFolderCount: 0,
          },
          joined: true,
        }),
      },
    });

    const result = await runReconcile({ profileId: "example" }, context, async () => WORKBOOK);
    const structured = result.structuredContent as {
      provenance: { graphRequestsByThisCall: number; scanSharedWithConcurrentCall: boolean };
    };

    expect(structured.provenance.graphRequestsByThisCall).toBe(0);
    expect(structured.provenance.scanSharedWithConcurrentCall).toBe(true);
  });

  it("passes the clients argument through to the shaping filter", async () => {
    const result = await runReconcile(
      { profileId: "example", clients: ["ACME"] },
      contextWith(),
      async () => WORKBOOK,
    );
    const structured = result.structuredContent as { scope: { clients: string[] | null } };

    expect(structured.scope.clients).toEqual(["ACME"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools/reconciliation/run.test.ts`
Expected: FAIL, cannot resolve `../../../src/tools/reconciliation/run.js`.

- [ ] **Step 3: Write the composition root**

Create `src/tools/reconciliation/run.ts`:

```ts
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { reconcile, type Period, type WorkbookSnapshot } from "../../domain/reconcile/index.js";
import type { Profile } from "../../domain/profile/schema.js";
import type { GraphClient } from "../../graph/client.js";
import { readWorkbookSnapshot } from "../../scan/workbook.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { scanProvenance, shapeReport } from "./shape.js";
import { reconcileText } from "./text.js";

export const RECONCILE_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Configured profile to reconcile, for example \"example\"."),
  clients: z
    .array(z.string().min(1))
    .optional()
    .describe("Limit the report to these clients, for example [\"CLIENTA\"]. Omit to cover every client in the workbook."),
} satisfies z.ZodRawShape;

const InputObject = z.object(RECONCILE_INPUT_SCHEMA);

/**
 * The reference month the rolling window ends at, read in UTC.
 *
 * The engine takes this as an argument and never reads a clock, which is what
 * lets a report be reproduced from its own inputs. UTC rather than local time
 * because the host's timezone is not part of the answer and a report must not
 * depend on which region the container runs in. For a few hours around a month
 * boundary the window therefore advances before a negative-offset operator's
 * own calendar does, which the resolved window in the report makes visible.
 */
export function periodFromDate(date: Date): Period {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

type ReadWorkbook = (client: GraphClient, profile: Profile) => Promise<WorkbookSnapshot>;

/**
 * The tool's composition root: resolve the profile, read the workbook, scan the
 * repository, run the finished engine, and shape what comes back.
 *
 * The workbook is read before the scan deliberately. The two are independent
 * and could run concurrently, but a stale mapping is both the likeliest failure
 * of the pair and the cheapest to detect, and reading it first means an
 * operator whose mapping points at a renamed column learns that immediately
 * rather than after paying for a full library enumeration.
 */
export async function runReconcile(
  input: unknown,
  context: ToolContext,
  readWorkbook: ReadWorkbook = readWorkbookSnapshot,
): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { profileId: args.profileId };

  try {
    const profile = context.profiles.get(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    const workbook = await readWorkbook(context.graph, profile);
    const scan = await context.scans.run(profile);

    const report = reconcile(profile, workbook, scan.result.snapshot, periodFromDate(context.now()));
    const output = shapeReport(report, scanProvenance(scan.result, scan.joined), {
      ...(args.clients === undefined ? {} : { clients: args.clients }),
    });

    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [{ type: "text" as const, text: reconcileText(output).join("\n") }],
    };
  } catch (error) {
    // Logged before it is described, because `describeToolFailure` tells the
    // operator the full Graph response is in the server log and a message may
    // not promise what this function did not do.
    console.error(`reconcile_workbook_vs_repository failed for profile "${args.profileId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tools/reconciliation/run.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire the definition**

Replace `src/tools/definitions/reconcile.ts`:

```ts
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { RECONCILE_OUTPUT_SCHEMA } from "../reconciliation/output.js";
import { RECONCILE_INPUT_SCHEMA, runReconcile } from "../reconciliation/run.js";

export const reconcileWorkbookVsRepository: ToolDefinition = {
  name: "reconcile_workbook_vs_repository",
  kind: "read",
  title: "Reconcile workbook against repository",
  description: [
    "Compare what the tracking workbook says should exist against what the repository actually contains, and return a per-client gap report classifying every expected deliverable as compliant, misnamed, misplaced, both, or missing, plus any orphaned files and empty folders.",
    "This is the primary tool for compliance questions. Use it instead of inventory_tree whenever the question is whether required reports exist, because a folder can exist while its report is stored somewhere else entirely.",
    "Compliant deliverables are summarized in the per-client counts rather than listed one by one. The counts are complete and are the authoritative answer to whether a client is compliant.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: RECONCILE_INPUT_SCHEMA,
  outputSchema: RECONCILE_OUTPUT_SCHEMA,
  handler: runReconcile,
};
```

- [ ] **Step 6: Write the wire test**

Create `tests/tools/reconciliation/wire.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../../../src/mcp/build-server.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import { RECONCILE_OUTPUT_SCHEMA } from "../../../src/tools/reconciliation/output.js";

describe("reconcile_workbook_vs_repository over the wire", () => {
  it("reports a failure as a tool error the model can read, not a transport fault", async () => {
    // The fake context's scan coordinator rejects, so this exercises the whole
    // dispatch path including the error mapping.
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "reconcile_workbook_vs_repository",
        arguments: { profileId: "example" },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("declares an output schema the shaped report validates against", async () => {
    const { loadExpectedReport } = await import("../../domain/reconcile/fixtures/load.js");
    const { shapeReport } = await import("../../../src/tools/reconciliation/shape.js");

    const output = shapeReport(
      loadExpectedReport(),
      { scanMode: "full", resynced: false, graphRequestsByThisCall: 2, scanSharedWithConcurrentCall: false },
      {},
    );

    expect(() => z.object(RECONCILE_OUTPUT_SCHEMA).parse(output)).not.toThrow();
  });

  it("no longer advertises the stub output schema", async () => {
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const listed = (await client.listTools()).tools.find(
        (tool) => tool.name === "reconcile_workbook_vs_repository",
      );

      expect(Object.keys(listed?.outputSchema?.properties ?? {})).toContain("clients");
      expect(Object.keys(listed?.outputSchema?.properties ?? {})).not.toContain("stub");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
```

- [ ] **Step 7: Write the failing error-path tests**

Create `tests/tools/reconciliation/run.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runReconcile } from "../../../src/tools/reconciliation/run.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import { WorkbookMappingError } from "../../../src/workbook/read.js";
import { GraphRequestError } from "../../../src/graph/errors.js";

function textOf(result: Awaited<ReturnType<typeof runReconcile>>): string {
  return JSON.stringify(result.content);
}

describe("runReconcile failures", () => {
  it("names the configured profiles when asked for one that is not configured", async () => {
    const result = await runReconcile({ profileId: "nope" }, createFakeToolContext(), async () => {
      throw new Error("the workbook should never have been read");
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("example");
  });

  it("does not scan when the workbook read fails", async () => {
    let scanned = false;
    const context = createFakeToolContext({
      scans: {
        run: async () => {
          scanned = true;
          throw new Error("unreachable");
        },
      },
    });

    const result = await runReconcile({ profileId: "example" }, context, async () => {
      throw new WorkbookMappingError('The mapping names a column "Client Code" that the sheet does not have.');
    });

    expect(scanned).toBe(false);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Client Code");
  });

  it("reports a Graph failure by status and code without the response body", async () => {
    const context = createFakeToolContext({
      scans: {
        run: async () => {
          throw new GraphRequestError({
            method: "GET",
            path: "/drives/drive-1/root/delta",
            status: 429,
            body: JSON.stringify({ error: { code: "activityLimitReached", message: "DO-NOT-LEAK" } }),
          });
        },
      },
    });

    const result = await runReconcile({ profileId: "example" }, context, async () => ({
      rows: [],
      rejectedRows: [],
      source: "workbook",
    }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("activityLimitReached");
    expect(textOf(result)).not.toContain("DO-NOT-LEAK");
  });

  it("rejects an input with no profileId rather than reconciling a default", async () => {
    await expect(runReconcile({}, createFakeToolContext(), async () => ({
      rows: [],
      rejectedRows: [],
      source: "workbook",
    }))).rejects.toThrow();
  });
});
```

- [ ] **Step 8: Run every new test**

Run: `npx vitest run tests/tools/reconciliation/`
Expected: PASS across `shape`, `text`, `run` and `wire`.

If Step 9 of Task 7 found that an `isError` result is not exempt from output-schema validation, the first wire test's `expect(result.structuredContent).toBeUndefined()` becomes `expect(result.structuredContent).toEqual({ ok: false })`.

- [ ] **Step 9: Run the full gates**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass. `tests/tools/contract.test.ts` and `tests/tools/wire-contract.test.ts` cover the new schema with no edit; if either fails, the definition is wrong, not the test.

- [ ] **Step 10: Commit**

```bash
git add src/tools/reconciliation/run.ts src/tools/definitions/reconcile.ts tests/tools/reconciliation/
git commit -m "feat(tools): wire reconcile_workbook_vs_repository end to end"
```

---

## Task 9: Documentation and the Decision Record amendments

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/OPEN-ITEMS.md`
- Modify: `docs/SETUP.md`
- Modify: `docs/superpowers/specs/2026-09-11-repository-reconciliation-mcp-design.md`

No code, and no test beyond the hygiene suite, which emits one case per tracked text file and will pick these up on its own.

- [ ] **Step 1: Amend the Decision Record in `CLAUDE.md`**

In the "Excel as a database" paragraph, after the sentence ending "the mechanism does not fit the architecture", replace the closing sentence about a later phase with:

```
Amended 2026-09-14 for scans, not for Excel. The mechanism is now adopted in
`src/scan/coordinator.ts`, where it does fit: concurrent scans do not share a
session, they share a process-level store client and a persisted `deltaLink`,
both of which outlive the request. It exists for one failure: `runScan` answers a
delta resync by clearing the inventory and re-enumerating, and a concurrent call
reading it inside that window would report every file in the library as missing.
The Excel deferral stands unchanged.
```

- [ ] **Step 2: Record the phase 4 slice in `CLAUDE.md`**

In the Build Sequence, the phase 4 entry currently opens `4. **Read tools wired**, then **hosting**, ...`. Split the first clause out so the slice is legible, keeping the rest of that sentence intact:

```
4. **Read tools**, sliced. **4a: the tool execution layer and the first wired tool.** Complete,
   covered by fakes only. The handler contract and the per-process `ToolContext`, the profile
   registry loaded and validated at startup from `IW_PROFILE_DIR`, the in-process single-flight
   scan coordinator, and `reconcile_workbook_vs_repository` wired end to end with a real output
   schema. The other four read tools are still honest stubs and inherit the layer with no
   retrofit. No Graph call, no Excel call and no Azure Storage call has been made by this code,
   so the composed tool has never returned a report against a tenant. Then **hosting**, ...
```

Keep the existing remainder of the sentence, from `then **hosting**` onward, exactly as it is.

- [ ] **Step 3: Record the open items**

Append to `docs/OPEN-ITEMS.md`, in the register's existing register-entry voice:

- The cross-replica scan coordination gap: single-flight is in-process, so two replicas can both resync one drive and a call on either can read a half-rebuilt inventory. Hosting stays at one replica until phase 5 decides, and a lease in Azure Table is the option that fixes it at any replica count.
- This slice's live-verification status: the composed tool has never returned a report against a tenant, because neither of its inputs has ever run against one. Written in the same terms as the phase 2a and 2b-1 entries.
- Whichever answer Task 7 Step 9 produced about `isError` and output-schema validation, recorded as an observed fact with the SDK version it was observed against.

- [ ] **Step 4: Update `docs/SETUP.md`**

Add `IW_PROFILE_DIR` to the server's environment, and state that the server now also requires `IW_TENANT_ID`, `IW_CLIENT_ID`, `IW_CLIENT_SECRET` and, for anything but a local run, `IW_TABLE_CONNECTION_STRING`. Until this slice only the scan command read those, so an operator following the existing document would start a server that fails on its first tool call.

- [ ] **Step 5: Slice phase 4 in the parent spec**

In `docs/superpowers/specs/2026-09-11-repository-reconciliation-mcp-design.md`, amend the phase 4 entry to record the split, naming this slice's spec, and note that the MVP checkpoint is reached when this slice's tool is confirmed against real read-only data rather than when the slice merges.

- [ ] **Step 6: Run the full gates**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass. The hygiene suite's total grows by one case per new documentation file; confirm it did not shrink.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs: record the phase 4 slice and amend the single-flight decision"
```

---

## Finishing

Once Task 9 is committed, use `superpowers:finishing-a-development-branch`. The working agreement puts anything architectural on a feature branch with a PR and no auto-merge, and this slice amends the Decision Record, so it is a PR rather than a push to main.
