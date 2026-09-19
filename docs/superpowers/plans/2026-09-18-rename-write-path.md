# Phase 6a Rename Write Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give this server its first write, end to end: `generate_rename_plan` produces a reviewable persisted plan and `execute_rename_plan` applies it under per-item ETag preconditions with a reversal log.

**Architecture:** Four layers, each with one job. `src/graph/` gains a PATCH verb and two small driveItem operations over it. `src/store/` gains plan persistence in both implementations behind the existing conformance harness. `src/domain/rename/` holds the pure pairing and collision rules, with no I/O, so they are fixture-tested. `src/tools/rename/` composes those into the two tool handlers.

**Tech Stack:** TypeScript, Node, `@modelcontextprotocol/sdk` 1.30.0, Zod, `@azure/data-tables`, vitest.

## Global Constraints

Every task's requirements implicitly include all of these. They come from `CLAUDE.md` and from the spec at `docs/superpowers/specs/2026-09-18-rename-write-path-design.md`.

- **No em dashes and no en dashes anywhere**, including inside string literals, comments, docs and commit messages. A test enforces this across tracked TS, JS, JSON, Markdown and YAML.
- **No emojis or icons anywhere**, including logs and docs. **US English throughout.**
- **The domain layer is pure.** Nothing under `src/domain/` may perform I/O. Lint enforces it.
- **A function that cannot observe an outcome must not assert it.** Never write a message claiming something the code did not verify. This project produced that defect nine times.
- **Comments explain why, not what.** Around Graph quirks especially.
- **Counts are computed over the complete set before any truncation** and reported exactly. A listing may be a prefix; its count must not be.
- **Every tool input field carries a description containing the words "for example"**, enforced by `tests/tools/contract.test.ts`.
- **A tool's `inputSchema` must be a plain `z.object({...})`**, never a `ZodEffects` from `.refine()`. MCP SDK 1.30.0 advertises a refined schema with no properties at all. A cross-field rule goes in the handler plus a verbatim `inputConstraints` string repeated in the description.
- **Conventional commits.** One commit per task step group as the task says.
- **Test file naming:** happy-path assertions in `X.test.ts`, failure and edge assertions in `X.errors.test.ts`. `npm run test:errors` runs only the latter.
- Run `npm run lint`, `npm run typecheck` and `npm test` before every commit.

---

## File Structure

**Created:**

- `src/graph/rename.ts` : `renameDriveItem` and `readDriveItemEtag`, the two driveItem operations this phase needs, over the new PATCH verb.
- `src/domain/rename/plan.ts` : pure pairing of misnamed artifacts to canonical names, plus the two collision rules. No I/O.
- `src/tools/rename/output.ts` : both tools' output schemas and their TypeScript result types.
- `src/tools/rename/generate.ts` : the `generate_rename_plan` handler.
- `src/tools/rename/execute.ts` : the `execute_rename_plan` handler.
- `src/tools/rename/text.ts` : the human-readable rendering for both results.
- Their tests, mirroring the source paths under `tests/`.

**Modified:**

- `src/graph/client.ts` : `patch` added to `GraphClient`, `RequestOptions.method` widened.
- `src/store/types.ts` : plan types and two store methods.
- `src/store/memory.ts`, `src/store/table.ts` : the two implementations.
- `src/tools/definitions/generate-rename-plan.ts`, `src/tools/definitions/execute-rename-plan.ts` : real output schemas and handlers replacing the stubs.
- `scripts/seed-library.ts` : a second planted misnamed file, so the live sitting can prove one item refusing while others apply.

**One deviation from an existing convention, deliberate.** Every wired tool so far owns a directory of four files (`shape`, `run`, `output`, `text`). The two rename tools share one directory instead, because they share the plan shape: splitting them would put the plan's item type in one directory and its only other reader in another, and the first edit that touched one would have to remember the other.

---

## Task 1: The Graph PATCH verb and the two driveItem operations

**Files:**
- Modify: `src/graph/client.ts`
- Create: `src/graph/rename.ts`
- Test: `tests/graph/rename.test.ts`, `tests/graph/rename.errors.test.ts`
- Test: `tests/graph/client.test.ts` (add PATCH cases)

**Interfaces:**
- Consumes: `GraphClient`, `GraphRequestError` from `src/graph/errors.js`, `driveItemPath(driveId, libraryRelativePath)` from `src/graph/paths.js`.
- Produces:
  - `GraphClient.patch<T>(pathOrUrl: string, body: unknown, headers?: Record<string, string>): Promise<T>`
  - `type RenameOutcome = { kind: "renamed"; etag: string | undefined } | { kind: "precondition_failed" } | { kind: "not_found" }`
  - `renameDriveItem(client: Pick<GraphClient, "patch">, args: { driveId: string; path: string; newName: string; etag: string }): Promise<RenameOutcome>`
  - `type EtagLookup = { kind: "found"; etag: string | undefined } | { kind: "not_found" }`
  - `readDriveItemEtag(client: Pick<GraphClient, "get">, args: { driveId: string; path: string }): Promise<EtagLookup>`

- [ ] **Step 1: Write the failing test for the PATCH verb**

Add to `tests/graph/client.test.ts`. Follow the fake-fetch style already in that file, reusing its own helpers if it has them rather than the literal `Response` construction below.

```ts
it("sends a PATCH with a JSON body and the caller's if-match header", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "i1", eTag: '"{GUID},2"' }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = createGraphClient({ tokenProvider: { getToken: async () => "t" }, fetchImpl });
  const result = await client.patch<{ eTag: string }>(
    "/drives/d1/root:/a.xlsx:",
    { name: "b.xlsx" },
    { "if-match": '"{GUID},1"' },
  );

  expect(result.eTag).toBe('"{GUID},2"');
  expect(calls[0]?.init.method).toBe("PATCH");
  expect(calls[0]?.init.body).toBe(JSON.stringify({ name: "b.xlsx" }));
  const headers = calls[0]?.init.headers as Record<string, string>;
  expect(headers["if-match"]).toBe('"{GUID},1"');
  expect(headers["content-type"]).toBe("application/json");
});

it("does not replay a PATCH that rejected at the transport, since the mutation may already have applied", async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    throw new TypeError("network down");
  }) as unknown as typeof fetch;

  const client = createGraphClient({ tokenProvider: { getToken: async () => "t" }, fetchImpl });
  await expect(client.patch("/drives/d1/root:/a.xlsx:", { name: "b.xlsx" })).rejects.toThrow("network down");
  expect(attempts).toBe(1);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/graph/client.test.ts`
Expected: FAIL, `client.patch is not a function`.

- [ ] **Step 3: Add the verb to the client**

In `src/graph/client.ts`, widen the method union on `RequestOptions`:

```ts
interface RequestOptions {
  method: "GET" | "POST" | "PATCH";
```

Add the member to the `GraphClient` interface, directly under `post`:

```ts
  /**
   * The only mutating verb this server has. Required rather than optional on
   * the interface: a caller that had to branch on whether `patch` exists would
   * be deciding at runtime whether this deployment can write, and that decision
   * belongs to the registry's write gate, where it is reviewed once.
   */
  patch<T>(pathOrUrl: string, body: unknown, headers?: Record<string, string>): Promise<T>;
```

Add the implementation, directly under `post` in the returned object:

```ts
    async patch<T>(pathOrUrl: string, body: unknown, headers?: Record<string, string>): Promise<T> {
      // retryTransportErrors is false for the same reason it is false for POST:
      // a transport rejection leaves it unknown whether the request reached
      // Graph, and replaying a mutation that already applied is worse than
      // surfacing the failure. If-Match makes a blind replay merely refuse
      // rather than apply twice, but it would refuse with a 412, and a 412 is
      // reported to the operator as "this file changed since you planned it",
      // which would be a confident wrong answer about what happened.
      return request<T>(pathOrUrl, {
        method: "PATCH",
        retryTransportErrors: false,
        body,
        ...(headers === undefined ? {} : { headers }),
      });
    },
```

An `if-match` header supplied by a caller survives the header merge in `send`: only `authorization`, `accept` and `content-type` are written after the caller's spread.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/graph/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Repair every fake GraphClient the new member broke**

Run: `npm run typecheck`

It will name every object literal typed as `GraphClient` that now lacks `patch`. There are roughly sixteen across eleven files. **Do not work from a remembered list: the typechecker is the enumerator.** For each one it names, add this member beside the existing `post` stub, keeping that file's own counter variable name:

```ts
    patch: () => {
      requestCount += 1;
      return Promise.reject(new Error("this fake Graph client does not implement patch"));
    },
```

For a fake whose sibling methods do not increment a counter, drop the increment line and keep the rejection. **Do not give any fake a working `patch`.** A fake that silently accepts a write is how a suite comes to prove a mutation nobody made. The fakes in this repo reject on purpose, and the reasoning is written out at the top of `tests/tools/fake-context.ts`.

Run `npm run typecheck` again until it is clean.

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run typecheck && npm test
git add -A
git commit -m "feat(graph): add a PATCH verb that carries a caller's If-Match"
```

- [ ] **Step 7: Write the failing tests for the two driveItem operations**

Create `tests/graph/rename.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readDriveItemEtag, renameDriveItem } from "../../src/graph/rename.js";

describe("renameDriveItem", () => {
  it("addresses the item by path and sends the new name under the supplied etag", async () => {
    const calls: Array<{ path: string; body: unknown; headers?: Record<string, string> }> = [];
    const client = {
      patch: async <T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> => {
        calls.push({ path, body, ...(headers === undefined ? {} : { headers }) });
        return { eTag: '"{GUID},7"' } as unknown as T;
      },
    };

    const outcome = await renameDriveItem(client, {
      driveId: "d1",
      path: "2026/CLIENTA/01-January/old name.xlsx",
      newName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
      etag: '"{GUID},6"',
    });

    expect(outcome).toEqual({ kind: "renamed", etag: '"{GUID},7"' });
    expect(calls[0]?.path).toBe("/drives/d1/root:/2026/CLIENTA/01-January/old%20name.xlsx:");
    expect(calls[0]?.body).toEqual({ name: "2026-01_CLIENTA_MonthlyTraining.xlsx" });
    expect(calls[0]?.headers?.["if-match"]).toBe('"{GUID},6"');
  });

  it("reports a renamed item with no etag in the response rather than inventing one", async () => {
    const client = { patch: async <T>(): Promise<T> => ({}) as unknown as T };

    await expect(
      renameDriveItem(client, { driveId: "d1", path: "a.xlsx", newName: "b.xlsx", etag: "e" }),
    ).resolves.toEqual({ kind: "renamed", etag: undefined });
  });
});

describe("readDriveItemEtag", () => {
  it("selects only the etag and returns it", async () => {
    const calls: string[] = [];
    const client = {
      get: async <T>(path: string): Promise<T> => {
        calls.push(path);
        return { eTag: '"{GUID},3"' } as unknown as T;
      },
    };

    await expect(readDriveItemEtag(client, { driveId: "d1", path: "a/b.xlsx" })).resolves.toEqual({
      kind: "found",
      etag: '"{GUID},3"',
    });
    expect(calls[0]).toBe("/drives/d1/root:/a/b.xlsx:?$select=eTag");
  });
});
```

Create `tests/graph/rename.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readDriveItemEtag, renameDriveItem } from "../../src/graph/rename.js";
import { GraphRequestError } from "../../src/graph/errors.js";

function graphError(method: string, status: number): GraphRequestError {
  return new GraphRequestError({ method, path: "/drives/d1/root:/a.xlsx:", status, body: "{}" });
}

describe("renameDriveItem outcomes", () => {
  it("reports a 412 as a failed precondition rather than throwing", async () => {
    const client = { patch: <T>(): Promise<T> => Promise.reject(graphError("PATCH", 412)) };

    await expect(
      renameDriveItem(client, { driveId: "d1", path: "a.xlsx", newName: "b.xlsx", etag: "e" }),
    ).resolves.toEqual({ kind: "precondition_failed" });
  });

  it("reports a 404 as the item being gone rather than throwing", async () => {
    const client = { patch: <T>(): Promise<T> => Promise.reject(graphError("PATCH", 404)) };

    await expect(
      renameDriveItem(client, { driveId: "d1", path: "a.xlsx", newName: "b.xlsx", etag: "e" }),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("rethrows any other Graph failure, since only 412 and 404 are expected outcomes", async () => {
    const client = { patch: <T>(): Promise<T> => Promise.reject(graphError("PATCH", 403)) };

    await expect(
      renameDriveItem(client, { driveId: "d1", path: "a.xlsx", newName: "b.xlsx", etag: "e" }),
    ).rejects.toBeInstanceOf(GraphRequestError);
  });

  it("rethrows a non-Graph failure untouched", async () => {
    const client = { patch: <T>(): Promise<T> => Promise.reject(new TypeError("network down")) };

    await expect(
      renameDriveItem(client, { driveId: "d1", path: "a.xlsx", newName: "b.xlsx", etag: "e" }),
    ).rejects.toThrow("network down");
  });
});

describe("readDriveItemEtag outcomes", () => {
  it("reports a 404 as not found rather than throwing", async () => {
    const client = { get: <T>(): Promise<T> => Promise.reject(graphError("GET", 404)) };

    await expect(readDriveItemEtag(client, { driveId: "d1", path: "a.xlsx" })).resolves.toEqual({ kind: "not_found" });
  });

  it("reports a found item whose response carried no etag as found with none, not as missing", async () => {
    const client = { get: async <T>(): Promise<T> => ({}) as unknown as T };

    await expect(readDriveItemEtag(client, { driveId: "d1", path: "a.xlsx" })).resolves.toEqual({
      kind: "found",
      etag: undefined,
    });
  });

  it("rethrows any other Graph failure", async () => {
    const client = { get: <T>(): Promise<T> => Promise.reject(graphError("GET", 500)) };

    await expect(readDriveItemEtag(client, { driveId: "d1", path: "a.xlsx" })).rejects.toBeInstanceOf(GraphRequestError);
  });
});
```

- [ ] **Step 8: Run them and watch them fail**

Run: `npx vitest run tests/graph/rename`
Expected: FAIL, the module does not exist.

- [ ] **Step 9: Write `src/graph/rename.ts`**

```ts
import type { GraphClient } from "./client.js";
import { GraphRequestError } from "./errors.js";
import { driveItemPath } from "./paths.js";

/**
 * The three responses a rename can produce, kept apart rather than collapsed
 * into success-or-throw. A 412 and a 404 are expected outcomes of a plan
 * applied against a library other people also use, and an operator acts on
 * them differently: a 412 means re-plan, a 404 means the file moved or was
 * deleted. Turning either into an exception would make the executor catch its
 * own normal path.
 */
export type RenameOutcome =
  | { kind: "renamed"; etag: string | undefined }
  | { kind: "precondition_failed" }
  | { kind: "not_found" };

export type EtagLookup = { kind: "found"; etag: string | undefined } | { kind: "not_found" };

/**
 * An empty string is treated as absent. Graph does not return one, but an
 * empty etag is not a usable If-Match precondition either way, so collapsing
 * the two here means no caller downstream has to test for both.
 */
function etagOf(item: unknown): string | undefined {
  const value = (item as { eTag?: unknown }).eTag;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Renames one driveItem in place, addressed by path.
 *
 * The etag is supplied by the caller rather than read here. A verb that
 * fetched its own precondition would have a race inside it: the fetch and the
 * write would be two calls, and a change landing between them would satisfy a
 * precondition that no longer described what the caller decided to act on.
 *
 * The returned etag is the item's new one, which the caller needs because the
 * rename invalidated the old one. Graph's documented response to a driveItem
 * PATCH is the updated item, so it should be present. It is reported as
 * undefined rather than guessed when it is not, because a fabricated
 * precondition is worse than an absent one: a caller can fetch a missing etag,
 * but it cannot detect an invented one.
 */
export async function renameDriveItem(
  client: Pick<GraphClient, "patch">,
  args: { driveId: string; path: string; newName: string; etag: string },
): Promise<RenameOutcome> {
  try {
    const updated = await client.patch<unknown>(
      driveItemPath(args.driveId, args.path),
      { name: args.newName },
      { "if-match": args.etag },
    );
    return { kind: "renamed", etag: etagOf(updated) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 412) return { kind: "precondition_failed" };
    if (error instanceof GraphRequestError && error.status === 404) return { kind: "not_found" };
    throw error;
  }
}

/**
 * Reads one driveItem's current etag, which is what a plan captures as its
 * precondition.
 *
 * Path addressing does double duty here. The path contains the filename, so an
 * item renamed or moved since the last scan answers 404 rather than returning
 * an etag for a file that is no longer the one the plan means. That is why
 * nothing downstream needs a separate check that the name is still what the
 * inventory recorded.
 */
export async function readDriveItemEtag(
  client: Pick<GraphClient, "get">,
  args: { driveId: string; path: string },
): Promise<EtagLookup> {
  try {
    const item = await client.get<unknown>(`${driveItemPath(args.driveId, args.path)}?$select=eTag`);
    return { kind: "found", etag: etagOf(item) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 404) return { kind: "not_found" };
    throw error;
  }
}
```

- [ ] **Step 10: Run them and watch them pass**

Run: `npx vitest run tests/graph/rename`
Expected: PASS, all cases.

- [ ] **Step 11: Run the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/graph/rename.ts tests/graph/rename.test.ts tests/graph/rename.errors.test.ts
git commit -m "feat(graph): add rename and etag read over path-addressed driveItems"
```

---

## Task 2: Plan persistence in both state stores

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/memory.ts`
- Modify: `src/store/table.ts`
- Modify: `tests/store/conformance.ts`
- Modify: `tests/store/table.test.ts` (a third client at every construction)
- Test: `tests/store/plans.errors.test.ts`

**Interfaces:**
- Consumes: `inventoryPartitionKey`, `encodeRowKey` from `src/store/keys.js`; `TableClientLike`, `TableEntityLike`, `TableStateStoreClients` from `src/store/table.js`.
- Produces:
  - `type PlanExclusionReason = "target_path_already_occupied" | "two_files_share_one_target_name" | "no_etag_available" | "file_not_found_at_plan_time"`
  - `interface RenamePlanItem { path: string; currentName: string; targetName: string; targetPath: string; etag: string; client: string }`
  - `interface ExcludedPlanItem { path: string; currentName: string; targetName: string; client: string; reason: PlanExclusionReason }`
  - `interface StoredPlan { planId: string; profileId: string; kind: "rename"; driveId: string; createdAt: string; items: RenamePlanItem[]; excluded: ExcludedPlanItem[]; reverses?: string }`
  - `StateStore.savePlan(profileId: string, plan: StoredPlan): Promise<void>`
  - `StateStore.getPlan(profileId: string, planId: string): Promise<StoredPlan | undefined>`
  - `const MAX_PLAN_JSON_CHARS = 32000`
  - `class PlanTooLargeError extends Error` with readonly `planId: string` and `chars: number`

- [ ] **Step 1: Add the types, the cap and the two methods to `src/store/types.ts`**

Append to the file:

```ts
/**
 * Why a misnamed file the engine found is recorded in the plan as something
 * that will not be attempted.
 *
 * The first two are name collisions, neither resolvable without
 * `conflictBehavior`, which this phase deliberately does not build. The last
 * two come from the plan-time etag fetch: a file with no etag has no usable
 * precondition, and silently sending no `If-Match` for it would turn the item
 * carrying the least information into the only unguarded write in the batch.
 */
export type PlanExclusionReason =
  | "target_path_already_occupied"
  | "two_files_share_one_target_name"
  | "no_etag_available"
  | "file_not_found_at_plan_time";

export interface RenamePlanItem {
  /** Library-relative, no leading slash. The file as it stands now. */
  path: string;
  currentName: string;
  targetName: string;
  /** Library-relative path this item occupies once renamed. Always the same folder as `path`. */
  targetPath: string;
  /**
   * The `If-Match` precondition, fetched from Graph when the plan was
   * generated rather than read out of the inventory. The inventory is a delta
   * snapshot that may be hours old, so a precondition built on it would refuse
   * any change since the last scan rather than any change since the plan a
   * human actually read.
   */
  etag: string;
  client: string;
}

export interface ExcludedPlanItem {
  path: string;
  currentName: string;
  targetName: string;
  client: string;
  reason: PlanExclusionReason;
}

/**
 * A persisted plan. There is one entity type rather than two, because a
 * reversal log is a plan by the Decision Record's own words. Storing it as a
 * separate shape would let the reversal path drift from the forward path, and
 * rollback running through the same code is the whole point of the rule.
 */
export interface StoredPlan {
  planId: string;
  profileId: string;
  kind: "rename";
  driveId: string;
  createdAt: string;
  items: RenamePlanItem[];
  excluded: ExcludedPlanItem[];
  /** The plan id this one reverses. Absent on a forward plan. */
  reverses?: string;
}

/**
 * Azure Table caps a String property at 32768 characters. The margin below
 * that covers the rest of the entity, and the refusal is raised in this
 * codebase rather than left to the service, whose own error names neither the
 * plan nor a remedy.
 */
export const MAX_PLAN_JSON_CHARS = 32000;

export class PlanTooLargeError extends Error {
  readonly planId: string;
  readonly chars: number;

  constructor(planId: string, chars: number) {
    super(
      `Plan "${planId}" serializes to ${String(chars)} characters, more than the ` +
        `${String(MAX_PLAN_JSON_CHARS)} a single stored plan holds. Generate a narrower plan by naming fewer ` +
        "clients. Refused rather than truncated, because a plan missing items a reviewer saw is worse than no plan at all.",
    );
    this.name = "PlanTooLargeError";
    this.planId = planId;
    this.chars = chars;
  }
}
```

Add the two methods to the `StateStore` interface:

```ts
  /**
   * Writes a plan, replacing any plan already stored under that id. Replacing
   * rather than appending is what lets an executor correct a reversal entry's
   * etag as each rename lands: a rename changes the item's etag, so a reversal
   * log written before the first write and never touched again would have every
   * one of its items refused on its own stale precondition, and a rollback
   * would report a clean run having changed nothing.
   */
  savePlan(profileId: string, plan: StoredPlan): Promise<void>;
  getPlan(profileId: string, planId: string): Promise<StoredPlan | undefined>;
```

- [ ] **Step 2: Add the conformance cases both implementations must satisfy**

Append inside `stateStoreConformance` in `tests/store/conformance.ts`, and add `StoredPlan` to that file's type imports from `../../src/store/types.js`:

```ts
  it("returns no plan before one is stored", async () => {
    await expect(create().getPlan("example", "rnm-2026-09-18-a1b2")).resolves.toBeUndefined();
  });

  it("round-trips a plan with all of its items and exclusions", async () => {
    const store = create();
    const plan: StoredPlan = {
      planId: "rnm-2026-09-18-a1b2",
      profileId: "example",
      kind: "rename",
      driveId: "d1",
      createdAt: "2026-09-18T12:00:00Z",
      items: [
        {
          path: "2026/CLIENTA/01-January/wrong.xlsx",
          currentName: "wrong.xlsx",
          targetName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
          targetPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
          etag: '"{GUID},1"',
          client: "CLIENTA",
        },
      ],
      excluded: [
        {
          path: "2026/CLIENTB/01-January/other.xlsx",
          currentName: "other.xlsx",
          targetName: "2026-01_CLIENTB_MonthlyTraining.xlsx",
          client: "CLIENTB",
          reason: "target_path_already_occupied",
        },
      ],
    };

    await store.savePlan("example", plan);

    await expect(store.getPlan("example", plan.planId)).resolves.toEqual(plan);
  });

  it("keeps one profile's plans out of another profile's reach", async () => {
    const store = create();
    const plan: StoredPlan = {
      planId: "rnm-2026-09-18-a1b2",
      profileId: "example",
      kind: "rename",
      driveId: "d1",
      createdAt: "2026-09-18T12:00:00Z",
      items: [],
      excluded: [],
    };

    await store.savePlan("example", plan);

    await expect(store.getPlan("other", plan.planId)).resolves.toBeUndefined();
  });

  it("replaces a plan saved under the same id, which is how a reversal entry's etag is corrected", async () => {
    const store = create();
    const item = {
      path: "a.xlsx",
      currentName: "a.xlsx",
      targetName: "b.xlsx",
      targetPath: "b.xlsx",
      etag: "stale",
      client: "CLIENTA",
    };
    const plan: StoredPlan = {
      planId: "rev-2026-09-18-c3d4",
      profileId: "example",
      kind: "rename",
      driveId: "d1",
      createdAt: "2026-09-18T12:00:00Z",
      items: [item],
      excluded: [],
      reverses: "rnm-2026-09-18-a1b2",
    };

    await store.savePlan("example", plan);
    await store.savePlan("example", { ...plan, items: [{ ...item, etag: "fresh" }] });

    const stored = await store.getPlan("example", plan.planId);
    expect(stored?.items[0]?.etag).toBe("fresh");
    expect(stored?.reverses).toBe("rnm-2026-09-18-a1b2");
  });

  it("does not let a caller mutate a stored plan through the object it saved", async () => {
    // The Table implementation cannot be mutated this way, and a StateStore
    // caller must not be able to tell which implementation answered.
    const store = create();
    const plan: StoredPlan = {
      planId: "rnm-2026-09-18-a1b2",
      profileId: "example",
      kind: "rename",
      driveId: "d1",
      createdAt: "2026-09-18T12:00:00Z",
      items: [
        {
          path: "a.xlsx",
          currentName: "a.xlsx",
          targetName: "b.xlsx",
          targetPath: "b.xlsx",
          etag: "e1",
          client: "CLIENTA",
        },
      ],
      excluded: [],
    };

    await store.savePlan("example", plan);
    const firstItem = plan.items[0];
    if (firstItem !== undefined) firstItem.etag = "tampered";

    const stored = await store.getPlan("example", plan.planId);
    expect(stored?.items[0]?.etag).toBe("e1");
  });
```

- [ ] **Step 3: Run the conformance suite and watch both stores fail**

Run: `npx vitest run tests/store`
Expected: FAIL for both `memory.test.ts` and `table.test.ts`, `store.savePlan is not a function`.

- [ ] **Step 4: Implement plan persistence in the memory store**

In `src/store/memory.ts`, add a map beside the two existing ones:

```ts
  const plans = new Map<string, StoredPlan>();
```

and the two methods, using the same `inventoryPartitionKey` join every other method in this file uses, so an unsafe profile id is refused here too:

```ts
    async savePlan(profileId, plan) {
      // Cloned on the way in and out. Without it, a caller holding the object
      // it saved could mutate what the store later hands to someone else,
      // which the Table implementation cannot do, and a StateStore caller must
      // not be able to tell which implementation answered.
      plans.set(inventoryPartitionKey(profileId, plan.planId), structuredClone(plan));
    },

    async getPlan(profileId, planId) {
      const stored = plans.get(inventoryPartitionKey(profileId, planId));
      return stored === undefined ? undefined : structuredClone(stored);
    },
```

Add `StoredPlan` to this file's type imports.

- [ ] **Step 5: Run the memory store's conformance and watch it pass**

Run: `npx vitest run tests/store/memory.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement plan persistence in the Table store**

Azure Table has no array or nested-object property type, so `items` and `excluded` are stored as JSON strings.

In `src/store/table.ts`:

1. Add `plans: TableClientLike` to `TableStateStoreClients`.
2. Include it in `ensureTables`'s loop: `for (const client of [clients.deltaLinks, clients.inventory, clients.plans])`.
3. Add `plans: TableClient.fromConnectionString(connectionString, "Plans") as unknown as TableClientLike` to `tableStateStoreFromConnectionString`.
4. Add the two methods:

```ts
    async savePlan(profileId, plan) {
      const items = JSON.stringify(plan.items);
      const excluded = JSON.stringify(plan.excluded);
      const total = items.length + excluded.length;
      if (total > MAX_PLAN_JSON_CHARS) throw new PlanTooLargeError(plan.planId, total);

      await clients.plans.upsertEntity(
        {
          partitionKey: profileId,
          rowKey: encodeRowKey(plan.planId),
          planId: plan.planId,
          profileId: plan.profileId,
          kind: plan.kind,
          driveId: plan.driveId,
          createdAt: plan.createdAt,
          items,
          excluded,
          // Written only when present, so a forward plan's entity carries no
          // reverses key at all and the read below can use its absence. An
          // empty string would be indistinguishable from a reversal of a plan
          // whose id is the empty string.
          ...(plan.reverses === undefined ? {} : { reverses: plan.reverses }),
        },
        "Replace",
      );
    },

    async getPlan(profileId, planId) {
      try {
        const entity = await clients.plans.getEntity(profileId, encodeRowKey(planId));
        return {
          planId: String(entity.planId ?? planId),
          profileId: String(entity.profileId ?? profileId),
          kind: "rename",
          driveId: String(entity.driveId ?? ""),
          createdAt: String(entity.createdAt ?? ""),
          items: JSON.parse(String(entity.items ?? "[]")) as RenamePlanItem[],
          excluded: JSON.parse(String(entity.excluded ?? "[]")) as ExcludedPlanItem[],
          ...(typeof entity.reverses === "string" ? { reverses: entity.reverses } : {}),
        };
      } catch (error) {
        if (statusCodeOf(error) === 404) return undefined;
        throw error;
      }
    },
```

Add `ExcludedPlanItem`, `MAX_PLAN_JSON_CHARS`, `PlanTooLargeError`, `RenamePlanItem` and `StoredPlan` to this file's imports from `./types.js`. `PlanTooLargeError` and `MAX_PLAN_JSON_CHARS` are values, not types, so they go in the value import.

`tests/store/fake-table-client.ts` needs no change: `FakeTableClient` is a class instantiated once per table, and it serves any of them. What changes is every construction of `createTableStateStore({...})` in the tests, each of which gains `plans: new FakeTableClient()`. `npm run typecheck` names them all; do not work from a remembered list.

- [ ] **Step 7: Run the whole store suite and watch it pass**

Run: `npx vitest run tests/store`
Expected: PASS, both implementations. If `createTableStateStore` calls are still missing their third client, the typechecker names each one.

- [ ] **Step 8: Write the size-refusal test**

Create `tests/store/plans.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTableStateStore } from "../../src/store/table.js";
import { MAX_PLAN_JSON_CHARS, PlanTooLargeError, type StoredPlan } from "../../src/store/types.js";
import { FakeTableClient } from "./fake-table-client.js";

function fakeClients(): { deltaLinks: FakeTableClient; inventory: FakeTableClient; plans: FakeTableClient } {
  return { deltaLinks: new FakeTableClient(), inventory: new FakeTableClient(), plans: new FakeTableClient() };
}

function planWithItems(count: number): StoredPlan {
  return {
    planId: "rnm-2026-09-18-a1b2",
    profileId: "example",
    kind: "rename",
    driveId: "d1",
    createdAt: "2026-09-18T12:00:00Z",
    items: Array.from({ length: count }, (_value, index) => {
      const client = `CLIENT${String(index).padStart(3, "0")}`;
      return {
        path: `2026/${client}/01-January/a-fairly-long-original-filename.xlsx`,
        currentName: "a-fairly-long-original-filename.xlsx",
        targetName: `2026-01_${client}_MonthlyTraining.xlsx`,
        targetPath: `2026/${client}/01-January/2026-01_${client}_MonthlyTraining.xlsx`,
        etag: '"{01234567-89AB-CDEF-0123-456789ABCDEF},1"',
        client,
      };
    }),
    excluded: [],
  };
}

describe("stored plan size", () => {
  it("refuses a plan whose serialized items exceed what one entity holds, naming the plan and the remedy", async () => {
    // Sized well past the cap so the assertion does not depend on the exact
    // serialized length of one item, which a field rename would change.
    const store = createTableStateStore(fakeClients());
    const plan = planWithItems(300);

    await expect(store.savePlan("example", plan)).rejects.toBeInstanceOf(PlanTooLargeError);
    await expect(store.savePlan("example", plan)).rejects.toThrow(/naming fewer clients/);
  });

  it("accepts a plan comfortably inside the cap", async () => {
    const store = createTableStateStore(fakeClients());
    const plan = planWithItems(5);

    await store.savePlan("example", plan);
    await expect(store.getPlan("example", plan.planId)).resolves.toEqual(plan);
  });

  it("states the cap as a number the message and the constant agree on", () => {
    expect(new PlanTooLargeError("p1", 99999).message).toContain(String(MAX_PLAN_JSON_CHARS));
  });
});
```

- [ ] **Step 9: Run it and confirm it passes**

Run: `npx vitest run tests/store/plans.errors.test.ts`
Expected: PASS. If the 300-item plan happens to fall under the cap, raise the count until it does not. Do not lower the cap to make the test pass.

- [ ] **Step 10: Run the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/store tests/store
git commit -m "feat(store): persist rename plans and reversal logs in both implementations"
```

---
## Task 3: The pure pairing and collision rules

**Files:**
- Create: `src/domain/rename/plan.ts`
- Test: `tests/domain/rename/plan.test.ts`, `tests/domain/rename/plan.errors.test.ts`

This task adds no I/O and must not. `src/domain/` purity is lint-enforced.

**Interfaces:**
- Consumes: `ReconciliationReport`, `ArtifactFinding` from `src/domain/reconcile/index.js`.
- Produces:
  - `interface RenameCandidate { path: string; currentName: string; targetName: string; targetPath: string; client: string }`
  - `type CollisionReason = "target_path_already_occupied" | "two_files_share_one_target_name"`
  - `interface RenameCollision { path: string; currentName: string; targetName: string; client: string; reason: CollisionReason }`
  - `interface RenamePairing { candidates: RenameCandidate[]; collisions: RenameCollision[] }`
  - `pairMisnamedArtifacts(report: ReconciliationReport): RenamePairing`
  - `class MisnamedArtifactShapeError extends Error`

The two `CollisionReason` values are a subset of `PlanExclusionReason` from Task 2 on purpose: the domain knows only the two collisions, and the other two exclusion reasons are discovered by the etag fetch, which is I/O and belongs to Task 4.

- [ ] **Step 1: Write the failing tests**

Create `tests/domain/rename/plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pairMisnamedArtifacts } from "../../../src/domain/rename/plan.js";
import type { ArtifactFinding, ReconciliationReport } from "../../../src/domain/reconcile/index.js";

function report(artifacts: ArtifactFinding[], overrides: Partial<ReconciliationReport> = {}): ReconciliationReport {
  return {
    profileId: "example",
    window: { from: { year: 2026, month: 1 }, to: { year: 2026, month: 1 } },
    provenance: { scannedAt: "2026-09-18T12:00:00Z", searchCrossCheckIncluded: true, workbookSource: "w.xlsx" },
    artifacts,
    duplicates: [],
    orphans: [],
    emptyFolders: [],
    clients: [],
    rejectedWorkbookRows: [],
    ...overrides,
  };
}

function misnamed(client: string, currentName: string, expectedName: string): ArtifactFinding {
  const folder = `2026/${client}/01-January`;
  return {
    client,
    deliverable: "MonthlyTraining",
    period: { year: 2026, month: 1 },
    expectedPath: `${folder}/${expectedName}`,
    expectedName,
    state: "misnamed",
    matched: { path: `${folder}/${currentName}`, name: currentName, etag: "inventory-etag" },
  };
}

describe("pairMisnamedArtifacts", () => {
  it("pairs a misnamed file with its canonical name in the same folder", () => {
    const pairing = pairMisnamedArtifacts(
      report([misnamed("CLIENTA", "vendor training.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx")]),
    );

    expect(pairing.collisions).toEqual([]);
    expect(pairing.candidates).toEqual([
      {
        path: "2026/CLIENTA/01-January/vendor training.xlsx",
        currentName: "vendor training.xlsx",
        targetName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
        targetPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
        client: "CLIENTA",
      },
    ]);
  });

  it("ignores every artifact state other than misnamed", () => {
    const compliant: ArtifactFinding = {
      ...misnamed("CLIENTA", "a.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx"),
      state: "compliant",
    };
    const misplaced: ArtifactFinding = {
      ...misnamed("CLIENTB", "b.xlsx", "2026-01_CLIENTB_MonthlyTraining.xlsx"),
      state: "misnamed_and_misplaced",
    };
    const missing: ArtifactFinding = {
      client: "CLIENTC",
      deliverable: "MonthlyTraining",
      period: { year: 2026, month: 1 },
      expectedPath: "2026/CLIENTC/01-January/2026-01_CLIENTC_MonthlyTraining.xlsx",
      expectedName: "2026-01_CLIENTC_MonthlyTraining.xlsx",
      state: "missing",
    };

    const pairing = pairMisnamedArtifacts(report([compliant, misplaced, missing]));

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions).toEqual([]);
  });

  it("carries every client through, since scoping is the caller's job", () => {
    const pairing = pairMisnamedArtifacts(
      report([
        misnamed("CLIENTA", "a.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx"),
        misnamed("CLIENTB", "b.xlsx", "2026-01_CLIENTB_MonthlyTraining.xlsx"),
      ]),
    );

    expect(pairing.candidates.map((candidate) => candidate.client)).toEqual(["CLIENTA", "CLIENTB"]);
  });
});
```

Create `tests/domain/rename/plan.errors.test.ts`. Reuse the same two helpers by exporting them from the happy-path file, or duplicate them; duplication is acceptable here and the repo does it elsewhere, but exporting is cleaner:

```ts
import { describe, expect, it } from "vitest";
import { MisnamedArtifactShapeError, pairMisnamedArtifacts } from "../../../src/domain/rename/plan.js";
import type { ArtifactFinding, ReconciliationReport } from "../../../src/domain/reconcile/index.js";

function report(artifacts: ArtifactFinding[], overrides: Partial<ReconciliationReport> = {}): ReconciliationReport {
  return {
    profileId: "example",
    window: { from: { year: 2026, month: 1 }, to: { year: 2026, month: 1 } },
    provenance: { scannedAt: "2026-09-18T12:00:00Z", searchCrossCheckIncluded: true, workbookSource: "w.xlsx" },
    artifacts,
    duplicates: [],
    orphans: [],
    emptyFolders: [],
    clients: [],
    rejectedWorkbookRows: [],
    ...overrides,
  };
}

function misnamed(client: string, currentName: string, expectedName: string): ArtifactFinding {
  const folder = `2026/${client}/01-January`;
  return {
    client,
    deliverable: "MonthlyTraining",
    period: { year: 2026, month: 1 },
    expectedPath: `${folder}/${expectedName}`,
    expectedName,
    state: "misnamed",
    matched: { path: `${folder}/${currentName}`, name: currentName, etag: "inventory-etag" },
  };
}

describe("collisions", () => {
  it("excludes both files when two in one folder would take the same canonical name", () => {
    const first = misnamed("CLIENTA", "one.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");
    const second = misnamed("CLIENTA", "two.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");

    const pairing = pairMisnamedArtifacts(report([first, second]));

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions.map((collision) => collision.currentName).sort()).toEqual(["one.xlsx", "two.xlsx"]);
    for (const collision of pairing.collisions) {
      expect(collision.reason).toBe("two_files_share_one_target_name");
    }
  });

  it("excludes a file whose canonical name is already taken by a compliant file", () => {
    const candidate = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");
    const occupant: ArtifactFinding = {
      client: "CLIENTA",
      deliverable: "MonthlyTraining",
      period: { year: 2026, month: 2 },
      expectedPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
      expectedName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
      state: "compliant",
      matched: {
        path: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
        name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
        etag: "e2",
      },
    };

    const pairing = pairMisnamedArtifacts(report([candidate, occupant]));

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions[0]?.reason).toBe("target_path_already_occupied");
  });

  it("excludes a file whose canonical name is already taken by an orphan", () => {
    const candidate = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");

    const pairing = pairMisnamedArtifacts(
      report([candidate], {
        orphans: [
          {
            path: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
            name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
            kind: "unexpected",
          },
        ],
      }),
    );

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions[0]?.reason).toBe("target_path_already_occupied");
  });

  it("excludes a file whose canonical name is already taken by a duplicate in this library", () => {
    const candidate = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");

    const pairing = pairMisnamedArtifacts(
      report([candidate], {
        duplicates: [
          {
            path: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
            name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
            slot: { client: "CLIENTA", deliverable: "MonthlyTraining", period: { year: 2026, month: 1 } },
            state: "compliant",
          },
        ],
      }),
    );

    expect(pairing.collisions[0]?.reason).toBe("target_path_already_occupied");
  });

  it("does not treat a file in ANOTHER library as occupying the target path", () => {
    // A qualified path is relative to a library this plan does not write to,
    // so it cannot collide with anything here. Treating it as an occupant
    // would refuse a rename that is perfectly safe.
    const candidate = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");

    const pairing = pairMisnamedArtifacts(
      report([candidate], {
        duplicates: [
          {
            path: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
            name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
            slot: { client: "CLIENTA", deliverable: "MonthlyTraining", period: { year: 2026, month: 1 } },
            state: "compliant",
            library: "Archive",
          },
        ],
      }),
    );

    expect(pairing.collisions).toEqual([]);
    expect(pairing.candidates).toHaveLength(1);
  });
});

describe("shapes this function refuses rather than guesses at", () => {
  it("skips a misnamed artifact found in another library, since moving it is not a rename", () => {
    const foreign = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");
    const matched = foreign.matched;
    if (matched === undefined) throw new Error("fixture lost its match");
    const withLibrary: ArtifactFinding = { ...foreign, matched: { ...matched, library: "Archive" } };

    const pairing = pairMisnamedArtifacts(report([withLibrary]));

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions).toEqual([]);
  });

  it("skips a misnamed artifact carrying no matched file at all", () => {
    const unmatched: ArtifactFinding = {
      client: "CLIENTA",
      deliverable: "MonthlyTraining",
      period: { year: 2026, month: 1 },
      expectedPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
      expectedName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
      state: "misnamed",
    };

    expect(pairMisnamedArtifacts(report([unmatched])).candidates).toEqual([]);
  });

  it("refuses a misnamed artifact whose match is in a different folder from its expected path", () => {
    const wrongFolder: ArtifactFinding = {
      client: "CLIENTA",
      deliverable: "MonthlyTraining",
      period: { year: 2026, month: 1 },
      expectedPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
      expectedName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
      state: "misnamed",
      matched: { path: "2026/CLIENTA/02-February/wrong.xlsx", name: "wrong.xlsx", etag: "e1" },
    };

    expect(() => pairMisnamedArtifacts(report([wrongFolder]))).toThrow(MisnamedArtifactShapeError);
  });

  it("refuses a misnamed artifact whose current name already equals its expected name", () => {
    const sameName: ArtifactFinding = {
      client: "CLIENTA",
      deliverable: "MonthlyTraining",
      period: { year: 2026, month: 1 },
      expectedPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
      expectedName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
      state: "misnamed",
      matched: {
        path: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
        name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
        etag: "e1",
      },
    };

    expect(() => pairMisnamedArtifacts(report([sameName]))).toThrow(MisnamedArtifactShapeError);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/domain/rename`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write `src/domain/rename/plan.ts`**

```ts
import type { ArtifactFinding, ReconciliationReport } from "../reconcile/index.js";

export interface RenameCandidate {
  /** Library-relative, no leading slash. */
  path: string;
  currentName: string;
  targetName: string;
  /** Library-relative path this file occupies once renamed. Always in the same folder as `path`. */
  targetPath: string;
  client: string;
}

/**
 * The two collisions this phase can detect and cannot resolve. Both need
 * `conflictBehavior`, which the design deliberately holds back, so both are
 * recorded in the plan as items that will not be attempted rather than being
 * discovered as failures during a write.
 */
export type CollisionReason = "target_path_already_occupied" | "two_files_share_one_target_name";

export interface RenameCollision {
  path: string;
  currentName: string;
  targetName: string;
  client: string;
  reason: CollisionReason;
}

export interface RenamePairing {
  candidates: RenameCandidate[];
  collisions: RenameCollision[];
}

/**
 * A `misnamed` finding whose own fields contradict what `misnamed` means.
 *
 * Thrown rather than skipped. A skip would hide a change in the engine's own
 * contract behind a plan that merely looked short, and `misnamed` versus
 * `misnamed_and_misplaced` is exactly the distinction this function depends on.
 */
export class MisnamedArtifactShapeError extends Error {
  constructor(detail: string) {
    super(
      `A misnamed artifact finding has a shape a rename cannot act on: ${detail}. ` +
        "misnamed means the file is in the correct folder under an incorrect name, so its match must sit in " +
        "the folder its expected path names, under a different name. Refused rather than guessed at, because " +
        "guessing here would move a file rather than rename it.",
    );
    this.name = "MisnamedArtifactShapeError";
  }
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * Every library-relative path in this report that something already occupies.
 *
 * Built from the whole report rather than from the candidates, and always over
 * every client regardless of any scope the caller will apply afterwards: a plan
 * narrowed to one client must still refuse to rename a file onto a path another
 * client's file holds. Narrowing first is the same mistake `shapeReport` warns
 * against for orphans, in a place where the cost is a lost file rather than a
 * wrong count.
 *
 * Paths qualified by a `library` are excluded. Such a path is relative to a
 * library this plan does not write to, so it cannot collide with anything here,
 * and counting it would refuse a rename that is safe.
 */
function occupiedPaths(report: ReconciliationReport): Set<string> {
  const occupied = new Set<string>();

  for (const artifact of report.artifacts) {
    if (artifact.matched !== undefined && artifact.matched.library === undefined) {
      occupied.add(artifact.matched.path);
    }
  }
  for (const duplicate of report.duplicates) {
    if (duplicate.library === undefined) occupied.add(duplicate.path);
  }
  for (const orphan of report.orphans) {
    occupied.add(orphan.path);
  }

  return occupied;
}

function candidateFrom(artifact: ArtifactFinding): RenameCandidate | undefined {
  if (artifact.state !== "misnamed") return undefined;
  const matched = artifact.matched;
  // A misnamed finding with no match is not reachable from today's engine.
  // Skipped rather than refused, because unlike the two shapes below it names
  // no contradiction: there is simply nothing to rename.
  if (matched === undefined) return undefined;
  // A file found by the Microsoft Search cross-check lives in another library.
  // Putting it right is a move, which is phase 6b.
  if (matched.library !== undefined) return undefined;

  const folder = parentOf(matched.path);
  const expectedFolder = parentOf(artifact.expectedPath);
  if (folder !== expectedFolder) {
    throw new MisnamedArtifactShapeError(
      `"${matched.path}" sits in "${folder}" while its expected path "${artifact.expectedPath}" is in "${expectedFolder}"`,
    );
  }
  if (matched.name === artifact.expectedName) {
    throw new MisnamedArtifactShapeError(
      `"${matched.path}" already carries its expected name "${artifact.expectedName}"`,
    );
  }

  return {
    path: matched.path,
    currentName: matched.name,
    targetName: artifact.expectedName,
    // Derived from the match's own folder rather than taken from
    // expectedPath, so the two are proven equal by the guard above rather
    // than assumed equal here.
    targetPath: folder === "" ? artifact.expectedName : `${folder}/${artifact.expectedName}`,
    client: artifact.client,
  };
}

function collisionFrom(candidate: RenameCandidate, reason: CollisionReason): RenameCollision {
  return {
    path: candidate.path,
    currentName: candidate.currentName,
    targetName: candidate.targetName,
    client: candidate.client,
    reason,
  };
}

/**
 * Turns a reconciliation report into the from-and-to pairs a rename plan holds,
 * plus the pairs that cannot be attempted and why.
 *
 * Pure, and over the whole report. The caller narrows the result to the clients
 * it was asked about; this function must not, because the collision rules read
 * paths belonging to clients the caller may be excluding.
 */
export function pairMisnamedArtifacts(report: ReconciliationReport): RenamePairing {
  const occupied = occupiedPaths(report);

  const paired: RenameCandidate[] = [];
  for (const artifact of report.artifacts) {
    const candidate = candidateFrom(artifact);
    if (candidate !== undefined) paired.push(candidate);
  }

  const byTarget = new Map<string, RenameCandidate[]>();
  for (const candidate of paired) {
    const group = byTarget.get(candidate.targetPath);
    if (group === undefined) byTarget.set(candidate.targetPath, [candidate]);
    else group.push(candidate);
  }

  const candidates: RenameCandidate[] = [];
  const collisions: RenameCollision[] = [];

  for (const candidate of paired) {
    const sharing = byTarget.get(candidate.targetPath) ?? [];
    if (sharing.length > 1) {
      collisions.push(collisionFrom(candidate, "two_files_share_one_target_name"));
      continue;
    }
    // `!== candidate.path` rather than a bare membership test: the candidate's
    // own current path is in `occupied` by construction, and the target path
    // can never equal it, since a rename with the same name is refused above.
    // The comparison is kept anyway so a future change to that rule cannot
    // turn every candidate into a collision with itself.
    if (occupied.has(candidate.targetPath) && candidate.targetPath !== candidate.path) {
      collisions.push(collisionFrom(candidate, "target_path_already_occupied"));
      continue;
    }
    candidates.push(candidate);
  }

  return { candidates, collisions };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/domain/rename`
Expected: PASS, every case.

- [ ] **Step 5: Confirm the purity lint still holds**

Run: `npm run lint`
Expected: clean. If the domain purity rule complains, the module has imported something it must not; fix the import rather than the rule.

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/domain/rename tests/domain/rename
git commit -m "feat(domain): pair misnamed artifacts with canonical names and detect collisions"
```

---

## Task 4: Wire `generate_rename_plan`

**Files:**
- Create: `src/tools/rename/ids.ts`
- Create: `src/tools/rename/output.ts`
- Create: `src/tools/rename/generate.ts`
- Create: `src/tools/rename/text.ts`
- Modify: `src/tools/definitions/generate-rename-plan.ts`
- Test: `tests/tools/rename/generate.test.ts`, `tests/tools/rename/generate.errors.test.ts`

**Interfaces:**
- Consumes: `pairMisnamedArtifacts`, `MisnamedArtifactShapeError` (Task 3); `readDriveItemEtag` (Task 1); `StoredPlan`, `RenamePlanItem`, `ExcludedPlanItem`, `PlanTooLargeError` (Task 2); `ToolContext`, `describeToolFailure`, `FailureSubject`; `reconcile`, `periodFromDate` from `src/tools/reconciliation/run.js`; `readWorkbookSnapshot` from `src/scan/workbook.js`.
- Produces:
  - `newPlanId(prefix: "rnm" | "rev", now: Date, suffix?: () => string): string`
  - `const MAX_PLAN_ITEMS = 200`, `const MAX_PLAN_ITEMS_LISTED = 50`
  - `GENERATE_RENAME_PLAN_OUTPUT_SCHEMA` (a `z.ZodRawShape`) and `interface GenerateRenamePlanOutput`
  - `runGenerateRenamePlan(input: unknown, context: ToolContext, readWorkbook?, makePlanId?): Promise<CallToolResult>`
  - `generatePlanText(output: GenerateRenamePlanOutput): string[]`

- [ ] **Step 1: Write `src/tools/rename/ids.ts`**

```ts
import { randomUUID } from "node:crypto";

export type PlanIdPrefix = "rnm" | "rev";

/**
 * Eight hex characters rather than four.
 *
 * `savePlan` replaces whatever is stored under an id, which is what lets an
 * executor correct a reversal entry's etag. The same property makes a collision
 * silent and destructive: a second plan generated on the same day under the same
 * suffix would overwrite a plan a human had already reviewed, with nothing
 * raised anywhere. Four characters is 65536 values, which is inside birthday
 * range for a busy day; eight is not.
 */
export function newPlanId(prefix: PlanIdPrefix, now: Date, suffix: () => string = defaultSuffix): string {
  return `${prefix}-${now.toISOString().slice(0, 10)}-${suffix()}`;
}

function defaultSuffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}
```

- [ ] **Step 2: Write the shared test fixtures**

Both rename tool suites need the same fixtures, so they live in one file rather than being duplicated. Every constant in it is derived by hand from `examples/profiles/example.json`, which `createFakeToolContext` loads, and from that context's fixed clock of 2026-09-14.

Create `tests/tools/rename/fixtures.ts`:

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RepositoryFile, RepositorySnapshot, WorkbookSnapshot } from "../../../src/domain/reconcile/index.js";
import { GraphRequestError } from "../../../src/graph/errors.js";
import type { GraphClient } from "../../../src/graph/client.js";
import type { ScanResult } from "../../../src/scan/run.js";
import type { ToolContext } from "../../../src/tools/context.js";
import { createFakeToolContext, scanCoordinatorStub } from "../fake-context.js";

/**
 * Derived by hand from the example profile rather than computed, so a change to
 * that profile's taxonomy or template breaks these tests loudly instead of
 * letting them quietly agree with whatever the renderer now produces.
 *
 * The taxonomy is {year}/{client}/{month:02}-{monthName} and the template is
 * {year}-{month:02}_{client}_{deliverable}.xlsx, so September 2026 for ACME is
 * the folder and canonical name below. The misnamed name matches the profile's
 * own vendor-token recognizer, whose declared verdict is "misnamed"; that is
 * what makes the engine classify the file that way rather than as an
 * unrecognized orphan, and it is why an arbitrary wrong name would not work
 * here.
 */
export const FOLDER = "2026/ACME/09-September";
export const CANONICAL_NAME = "2026-09_ACME_MonthlyTraining.xlsx";
export const MISNAMED_NAME = "2026-09_ACME_VendorTraining.xlsx";
export const CANONICAL_PATH = `${FOLDER}/${CANONICAL_NAME}`;
export const MISNAMED_PATH = `${FOLDER}/${MISNAMED_NAME}`;
export const SCANNED_AT = "2026-09-14T09:00:00Z";

export function workbookFixture(clients: readonly string[] = ["ACME"]): WorkbookSnapshot {
  return {
    // monthlyTraining truthy is what makes the MonthlyTraining deliverable
    // apply; no effectiveFrom, so every month of the rolling window is owed.
    rows: clients.map((client) => ({ client, fields: { monthlyTraining: true } })),
    rejectedRows: [],
    source: "/Trackers/Operational Tracking Workbook.xlsx#ClientRoster",
  };
}

export function file(path: string, etag = "inventory-etag"): RepositoryFile {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), size: 1024, modified: SCANNED_AT, etag };
}

export function snapshot(files: RepositoryFile[], folderPaths: string[]): RepositorySnapshot {
  return { files, folderPaths, scannedAt: SCANNED_AT, searchCrossCheckIncluded: false };
}

/** One misnamed September file for ACME, and nothing else. */
export function snapshotWithMisnamedFile(): RepositorySnapshot {
  return snapshot([file(MISNAMED_PATH)], ["2026", "2026/ACME", FOLDER]);
}

export function misnamedPathFor(client: string): string {
  return `2026/${client}/09-September/2026-09_${client}_VendorTraining.xlsx`;
}

/** One misnamed September file for each named client. */
export function snapshotWithMisnamedFilePerClient(clients: readonly string[]): RepositorySnapshot {
  const folderPaths = new Set<string>(["2026"]);
  for (const client of clients) {
    folderPaths.add(`2026/${client}`);
    folderPaths.add(`2026/${client}/09-September`);
  }
  return snapshot(
    clients.map((client) => file(misnamedPathFor(client))),
    [...folderPaths],
  );
}

/** ACME's misnamed file alongside a file already sitting on its canonical path. */
export function snapshotWhereTargetIsOccupied(): RepositorySnapshot {
  return snapshot([file(MISNAMED_PATH), file(CANONICAL_PATH, "other-etag")], ["2026", "2026/ACME", FOLDER]);
}

export function scanResultFor(snapshotValue: RepositorySnapshot, driveId = "drive-1"): ScanResult {
  return {
    snapshot: snapshotValue,
    driveId,
    mode: "incremental",
    resynced: false,
    pages: 1,
    changesApplied: 0,
    graphRequests: 3,
    storeBatches: 0,
    unfilteredFileCount: snapshotValue.files.length,
    unfilteredFolderCount: snapshotValue.folderPaths.length,
  };
}

export function contextWith(graph: GraphClient, snapshotValue: RepositorySnapshot): ToolContext {
  const result = scanResultFor(snapshotValue);
  return createFakeToolContext({
    graph,
    scans: scanCoordinatorStub(() => Promise.resolve({ result, joined: false })),
  });
}

export function textOf(result: CallToolResult): string {
  return result.content.map((entry) => ("text" in entry ? entry.text : "")).join("\n");
}

/**
 * Answers the plan-time etag lookups and nothing else. A path maps to an etag
 * string, to `null` for an item Graph returns with no etag at all, or to a
 * number for a Graph status the lookup should fail with. A path with no entry
 * makes the fake throw, so a handler that reached for a call the test did not
 * intend fails loudly instead of receiving a plausible answer.
 *
 * Every method moves the same counter `requests()` reports, the way the real
 * client does. This project's sharpest phase 2 review finding was a cost
 * assertion measured against a counter that could not move.
 */
export function etagGraphClient(etagsByPath: Record<string, string | null | number>): GraphClient & {
  lookups: string[];
} {
  let requestCount = 0;
  const lookups: string[] = [];

  return {
    lookups,
    async get<T>(pathOrUrl: string): Promise<T> {
      requestCount += 1;
      const match = Object.entries(etagsByPath).find(([path]) =>
        pathOrUrl.includes(path.split("/").map(encodeURIComponent).join("/")),
      );
      if (match === undefined) throw new Error(`the fake etag client has no fixture for ${pathOrUrl}`);
      lookups.push(match[0]);
      if (typeof match[1] === "number") {
        throw new GraphRequestError({ method: "GET", path: pathOrUrl, status: match[1], body: "{}" });
      }
      return (match[1] === null ? {} : { eTag: match[1] }) as unknown as T;
    },
    post: () => {
      requestCount += 1;
      return Promise.reject(new Error("the fake etag client does not implement post"));
    },
    patch: () => {
      requestCount += 1;
      return Promise.reject(new Error("the fake etag client does not implement patch"));
    },
    getBytes: () => {
      requestCount += 2;
      return Promise.reject(new Error("the fake etag client does not implement getBytes"));
    },
    requests: () => requestCount,
  };
}
```

If `RepositoryFile` is not re-exported from `src/domain/reconcile/index.js`, import it from `src/domain/reconcile/types.js` instead; check which before writing the import.

- [ ] **Step 3: Write the failing tests for the handler**

Create `tests/tools/rename/generate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runGenerateRenamePlan } from "../../../src/tools/rename/generate.js";
import type { GenerateRenamePlanOutput } from "../../../src/tools/rename/output.js";
import {
  CANONICAL_NAME,
  CANONICAL_PATH,
  MISNAMED_PATH,
  contextWith,
  etagGraphClient,
  misnamedPathFor,
  snapshotWithMisnamedFile,
  snapshotWithMisnamedFilePerClient,
  workbookFixture,
} from "./fixtures.js";

function outputOf(result: Awaited<ReturnType<typeof runGenerateRenamePlan>>): GenerateRenamePlanOutput {
  return result.structuredContent as unknown as GenerateRenamePlanOutput;
}

describe("generate_rename_plan", () => {
  it("persists a plan pairing the misnamed file with its canonical name and a freshly fetched etag", async () => {
    const graph = etagGraphClient({ [MISNAMED_PATH]: '"{GUID},4"' });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const result = await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture());
    const output = outputOf(result);

    expect(result.isError).toBeUndefined();
    expect(output.itemCount).toBe(1);
    expect(output.items[0]?.path).toBe(MISNAMED_PATH);
    expect(output.items[0]?.targetName).toBe(CANONICAL_NAME);
    expect(output.items[0]?.targetPath).toBe(CANONICAL_PATH);
    expect(output.items[0]?.client).toBe("ACME");

    const stored = await context.store.getPlan("example", output.planId);
    expect(stored?.kind).toBe("rename");
    expect(stored?.driveId).toBe("drive-1");
    expect(stored?.reverses).toBeUndefined();
    expect(stored?.items[0]?.etag).toBe('"{GUID},4"');
  });

  it("uses the etag it fetched, not the one the inventory recorded", async () => {
    // The snapshot's own file carries "inventory-etag". A plan built on that
    // would refuse any change since the last scan rather than any change since
    // the plan a human read.
    const graph = etagGraphClient({ [MISNAMED_PATH]: '"{GUID},4"' });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const result = await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture());
    const stored = await context.store.getPlan("example", outputOf(result).planId);

    expect(stored?.items[0]?.etag).not.toBe("inventory-etag");
  });

  it("charges exactly one etag lookup per candidate and says so", async () => {
    const graph = etagGraphClient({ [MISNAMED_PATH]: '"{GUID},4"' });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const output = outputOf(
      await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture()),
    );

    expect(graph.lookups).toEqual([MISNAMED_PATH]);
    expect(output.etagLookupGraphRequests).toBe(1);
  });

  it("narrows the plan to the clients it was asked about", async () => {
    const clients = ["ACME", "BETACO"];
    const graph = etagGraphClient({
      [misnamedPathFor("ACME")]: '"{GUID},4"',
      [misnamedPathFor("BETACO")]: '"{GUID},5"',
    });
    const context = contextWith(graph, snapshotWithMisnamedFilePerClient(clients));

    const output = outputOf(
      await runGenerateRenamePlan({ profileId: "example", clients: ["ACME"] }, context, async () =>
        workbookFixture(clients),
      ),
    );

    expect(output.itemCount).toBe(1);
    expect(output.items[0]?.client).toBe("ACME");
    // Scoping happens after pairing, so only the in-scope candidate was fetched.
    expect(graph.lookups).toEqual([misnamedPathFor("ACME")]);
  });

  it("names plans with a prefix and date a caller can predict", async () => {
    const graph = etagGraphClient({ [MISNAMED_PATH]: '"{GUID},4"' });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const output = outputOf(
      await runGenerateRenamePlan(
        { profileId: "example" },
        context,
        async () => workbookFixture(),
        () => "rnm-2026-09-14-deadbeef",
      ),
    );

    expect(output.planId).toBe("rnm-2026-09-14-deadbeef");
  });
});
```

Create `tests/tools/rename/generate.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runGenerateRenamePlan } from "../../../src/tools/rename/generate.js";
import { MAX_PLAN_ITEMS, type GenerateRenamePlanOutput } from "../../../src/tools/rename/output.js";
import {
  MISNAMED_PATH,
  contextWith,
  etagGraphClient,
  misnamedPathFor,
  snapshotWhereTargetIsOccupied,
  snapshotWithMisnamedFile,
  snapshotWithMisnamedFilePerClient,
  textOf,
  workbookFixture,
} from "./fixtures.js";

function outputOf(result: Awaited<ReturnType<typeof runGenerateRenamePlan>>): GenerateRenamePlanOutput {
  return result.structuredContent as unknown as GenerateRenamePlanOutput;
}

describe("exclusions rather than attempts", () => {
  it("excludes a candidate whose canonical path is already occupied", async () => {
    // No lookup is expected for it, so the fake carries no fixture: reaching
    // Graph for an excluded item would fail this test rather than pass it.
    const graph = etagGraphClient({});
    const context = contextWith(graph, snapshotWhereTargetIsOccupied());

    const output = outputOf(
      await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture()),
    );

    expect(output.itemCount).toBe(0);
    expect(output.excludedCount).toBe(1);
    expect(output.excluded[0]?.reason).toBe("target_path_already_occupied");
    expect(graph.requests()).toBe(0);
  });

  it("excludes a candidate whose file is gone by plan time", async () => {
    const graph = etagGraphClient({ [MISNAMED_PATH]: 404 });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const output = outputOf(
      await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture()),
    );

    expect(output.itemCount).toBe(0);
    expect(output.excluded[0]?.reason).toBe("file_not_found_at_plan_time");
  });

  it("excludes a candidate whose item carries no etag rather than writing it unguarded", async () => {
    const graph = etagGraphClient({ [MISNAMED_PATH]: null });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const output = outputOf(
      await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture()),
    );

    expect(output.itemCount).toBe(0);
    expect(output.excluded[0]?.reason).toBe("no_etag_available");
  });
});

describe("refusals", () => {
  it("refuses a plan larger than one stored plan holds, before spending a single lookup", async () => {
    const clients = Array.from({ length: MAX_PLAN_ITEMS + 1 }, (_value, index) => `ACME${String(index).padStart(4, "0")}`);
    const graph = etagGraphClient({});
    const context = contextWith(graph, snapshotWithMisnamedFilePerClient(clients));

    const result = await runGenerateRenamePlan({ profileId: "example" }, context, async () =>
      workbookFixture(clients),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(String(MAX_PLAN_ITEMS));
    expect(textOf(result)).toContain("clients");
    expect(graph.requests()).toBe(0);
  });

  it("reports an unknown profile through the shared failure mapper", async () => {
    const context = contextWith(etagGraphClient({}), snapshotWithMisnamedFile());

    const result = await runGenerateRenamePlan({ profileId: "nope" }, context, async () => workbookFixture());

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("nope");
  });

  it("propagates an unexpected Graph failure from a lookup as a tool error, not as an exclusion", async () => {
    // Only 404 means "gone". A 500 is a failure this call cannot interpret,
    // and turning it into an exclusion would tell the operator the file has no
    // etag, which this code did not observe.
    const graph = etagGraphClient({ [MISNAMED_PATH]: 500 });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const result = await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture());

    expect(result.isError).toBe(true);
  });

  it("saves no plan at all when a lookup fails outright", async () => {
    // The id generator is injected so this assertion is about the plan that
    // WOULD have been saved. Without it the test would look up an id nothing
    // ever generated, and would pass no matter what the handler did.
    const graph = etagGraphClient({ [MISNAMED_PATH]: 500 });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    await runGenerateRenamePlan(
      { profileId: "example" },
      context,
      async () => workbookFixture(),
      () => "rnm-2026-09-14-deadbeef",
    );

    await expect(context.store.getPlan("example", "rnm-2026-09-14-deadbeef")).resolves.toBeUndefined();
  });
});
```

**A note for the reviewer of this task.** There is deliberately no test for a collision between two different clients. Under the example profile's taxonomy it cannot happen: `{client}` appears in both the folder path and the filename, so two clients can never render the same canonical path. `pairMisnamedArtifacts` still runs over the whole report before the caller narrows it, because a profile whose taxonomy or template omits `{client}` could collide across clients, and the domain tests in Task 3 cover that rule directly on synthetic reports where such a report can be constructed.

- [ ] **Step 4: Run them and watch them fail**

Run: `npx vitest run tests/tools/rename`
Expected: FAIL, the module does not exist.

- [ ] **Step 5: Write `src/tools/rename/output.ts`**

```ts
import { z } from "zod";
import type { PlanExclusionReason } from "../../store/types.js";

/**
 * The most items one generated plan holds. A plan larger than this cannot be
 * stored, since Azure Table caps a String property, and the refusal is raised
 * at generation time with a remedy a caller can act on rather than at the save,
 * where the message can only name characters.
 */
export const MAX_PLAN_ITEMS = 200;

/**
 * The most items and exclusions one response lists. The stored plan holds every
 * one of them; `itemCount` and `excludedCount` are computed before this cut, so
 * a reader always learns the true size even when the listing is a prefix.
 */
export const MAX_PLAN_ITEMS_LISTED = 50;

export const PLAN_EXCLUSION_REASONS = [
  "target_path_already_occupied",
  "two_files_share_one_target_name",
  "no_etag_available",
  "file_not_found_at_plan_time",
] as const;

export interface GenerateRenamePlanOutput {
  planId: string;
  profileId: string;
  library: string;
  driveId: string;
  createdAt: string;
  scannedAt: string;
  items: Array<{ path: string; currentName: string; targetName: string; targetPath: string; client: string }>;
  itemCount: number;
  itemsOmitted: number;
  excluded: Array<{ path: string; currentName: string; targetName: string; client: string; reason: PlanExclusionReason }>;
  excludedCount: number;
  excludedOmitted: number;
  workbookReadGraphRequestsByThisCall: number;
  etagLookupGraphRequests: number;
  scanGraphRequestsByThisCall: number;
  scanSharedWithConcurrentCall: boolean;
}

export const GENERATE_RENAME_PLAN_OUTPUT_SCHEMA = {
  planId: z.string().describe("The id execute_rename_plan consumes to apply this plan."),
  profileId: z.string().describe("The profile this plan was generated against."),
  library: z.string().describe("The document library named by the profile's identity."),
  driveId: z.string().describe("The drive every item in this plan is addressed within."),
  createdAt: z.string().describe("When this plan was generated."),
  scannedAt: z
    .string()
    .describe("When the underlying repository scan was taken. The plan's pairs reflect the library as of that scan."),
  items: z
    .array(
      z.object({
        path: z.string(),
        currentName: z.string(),
        targetName: z.string(),
        targetPath: z.string(),
        client: z.string(),
      }),
    )
    .describe(
      "What will be renamed, sorted by path. May be a prefix of the stored plan; see itemCount and itemsOmitted. " +
        "The stored plan holds every item regardless of what this listing shows.",
    ),
  itemCount: z.number().int().describe("Items in the stored plan. Computed before the listing above is cut."),
  itemsOmitted: z.number().int().describe("Items the listing above left out. Zero when the listing is complete."),
  excluded: z
    .array(
      z.object({
        path: z.string(),
        currentName: z.string(),
        targetName: z.string(),
        client: z.string(),
        reason: z.enum(PLAN_EXCLUSION_REASONS),
      }),
    )
    .describe(
      "Misnamed files this plan will NOT attempt, each with why. The first two reasons are name collisions this " +
        "server cannot resolve without a conflict behavior it deliberately does not implement; the last two mean " +
        "the file had no usable precondition when the plan was generated.",
    ),
  excludedCount: z.number().int().describe("Excluded items in the stored plan. Computed before the listing above is cut."),
  excludedOmitted: z.number().int().describe("Excluded items the listing above left out."),
  workbookReadGraphRequestsByThisCall: z
    .number()
    .int()
    .describe("What reading the workbook cost this call. A download costs two requests, not one."),
  etagLookupGraphRequests: z
    .number()
    .int()
    .describe(
      "One per candidate whose etag this call fetched, counted rather than measured against the shared request " +
        "counter, which a concurrent call also moves.",
    ),
  scanGraphRequestsByThisCall: z
    .number()
    .int()
    .describe("What the repository scan cost this call. Zero when this call joined a scan another call had started."),
  scanSharedWithConcurrentCall: z
    .boolean()
    .describe("True when this call awaited a scan another call had already started, which is the only reason the scan cost can be zero."),
} satisfies z.ZodRawShape;
```

- [ ] **Step 6: Write `src/tools/rename/generate.ts`**

```ts
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { reconcile, type WorkbookSnapshot } from "../../domain/reconcile/index.js";
import { pairMisnamedArtifacts, type RenameCandidate } from "../../domain/rename/plan.js";
import type { Profile } from "../../domain/profile/schema.js";
import type { GraphClient } from "../../graph/client.js";
import { readDriveItemEtag } from "../../graph/rename.js";
import { readWorkbookSnapshot } from "../../scan/workbook.js";
import type { ExcludedPlanItem, RenamePlanItem, StoredPlan } from "../../store/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { periodFromDate } from "../reconciliation/run.js";
import { newPlanId } from "./ids.js";
import { MAX_PLAN_ITEMS, MAX_PLAN_ITEMS_LISTED, type GenerateRenamePlanOutput } from "./output.js";
import { generatePlanText } from "./text.js";

export const GENERATE_RENAME_PLAN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Configured profile to plan against, for example \"example\"."),
  clients: z
    .array(z.string().min(1))
    .optional()
    .describe("Limit the plan to these clients, for example [\"CLIENTA\"]. Omit to cover every client in the workbook."),
} satisfies z.ZodRawShape;

const InputObject = z.object(GENERATE_RENAME_PLAN_INPUT_SCHEMA);

type ReadWorkbook = (client: GraphClient, profile: Profile) => Promise<WorkbookSnapshot>;

function comparePaths(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Generates a reviewable rename plan and persists it.
 *
 * It runs the reconciliation engine itself rather than reading a stored report,
 * because phase 4b deliberately declined to persist reports and `reconcile` is
 * the single public entry for a compliance verdict. Two tools deciding
 * independently what "misnamed" means is what that rule exists to prevent.
 */
export async function runGenerateRenamePlan(
  input: unknown,
  context: ToolContext,
  // Both injected only by tests. Production uses the real reader and real ids.
  readWorkbook: ReadWorkbook = readWorkbookSnapshot,
  makePlanId: () => string = () => newPlanId("rnm", context.now()),
): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "generate_rename_plan", profileId: args.profileId };

  try {
    const profile = context.profiles.get(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    // Bracketed the way every other tool brackets this counter: it lives on the
    // per-process client, so reading it raw would answer what the process has
    // spent since it started rather than what this call paid.
    const requestsBeforeWorkbook = context.graph.requests();
    const workbook = await readWorkbook(context.graph, profile);
    const workbookReadGraphRequestsByThisCall = context.graph.requests() - requestsBeforeWorkbook;

    const scan = await context.scans.run(profile);
    const report = reconcile(profile, workbook, scan.result.snapshot, periodFromDate(context.now()));

    // Paired over the whole report, then narrowed. The collision rules read
    // paths belonging to clients a scoped call is excluding, and a plan that
    // renamed a file onto a path another client's file holds would lose one of
    // them.
    const pairing = pairMisnamedArtifacts(report);
    const scope = args.clients === undefined ? undefined : new Set(args.clients);
    const candidates = scope === undefined ? pairing.candidates : pairing.candidates.filter((c) => scope.has(c.client));
    const collisions = scope === undefined ? pairing.collisions : pairing.collisions.filter((c) => scope.has(c.client));

    if (candidates.length > MAX_PLAN_ITEMS) {
      // Refused before the fetch loop, so a plan that cannot be stored costs no
      // Graph requests at all.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `This would plan ${String(candidates.length)} renames, more than the ${String(MAX_PLAN_ITEMS)} one ` +
              "stored plan holds. Narrow it by naming clients in the clients argument and generate one plan per " +
              "group. Nothing was fetched and no plan was saved.",
          },
        ],
      };
    }

    const items: RenamePlanItem[] = [];
    const excluded: ExcludedPlanItem[] = collisions.map((collision) => ({
      path: collision.path,
      currentName: collision.currentName,
      targetName: collision.targetName,
      client: collision.client,
      reason: collision.reason,
    }));

    for (const candidate of candidates) {
      // Fetched now rather than read from the inventory. The inventory's etag
      // comes from a delta snapshot that may be hours old and is recorded as
      // `item.eTag ?? ""`, so it can be empty; this fetch measures the window
      // that matters, generate to execute, and has no empty-string hole. The
      // same call confirms the file is still at that path under that name,
      // because path addressing puts the filename in the URL.
      const lookup = await readDriveItemEtag(context.graph, { driveId: scan.result.driveId, path: candidate.path });
      if (lookup.kind === "not_found") {
        excluded.push(excludedFrom(candidate, "file_not_found_at_plan_time"));
        continue;
      }
      if (lookup.etag === undefined) {
        excluded.push(excludedFrom(candidate, "no_etag_available"));
        continue;
      }
      items.push({ ...candidate, etag: lookup.etag });
    }

    const plan: StoredPlan = {
      planId: makePlanId(),
      profileId: args.profileId,
      kind: "rename",
      driveId: scan.result.driveId,
      createdAt: context.now().toISOString(),
      items: [...items].sort(comparePaths),
      excluded: [...excluded].sort(comparePaths),
    };
    await context.store.savePlan(args.profileId, plan);

    const output: GenerateRenamePlanOutput = {
      planId: plan.planId,
      profileId: plan.profileId,
      library: profile.identity.library,
      driveId: plan.driveId,
      createdAt: plan.createdAt,
      scannedAt: report.provenance.scannedAt,
      items: plan.items.slice(0, MAX_PLAN_ITEMS_LISTED).map((item) => ({
        path: item.path,
        currentName: item.currentName,
        targetName: item.targetName,
        targetPath: item.targetPath,
        client: item.client,
      })),
      itemCount: plan.items.length,
      itemsOmitted: Math.max(0, plan.items.length - MAX_PLAN_ITEMS_LISTED),
      excluded: plan.excluded.slice(0, MAX_PLAN_ITEMS_LISTED),
      excludedCount: plan.excluded.length,
      excludedOmitted: Math.max(0, plan.excluded.length - MAX_PLAN_ITEMS_LISTED),
      workbookReadGraphRequestsByThisCall,
      // Counted, not bracketed. The request counter lives on a process-level
      // client a concurrent call also moves, so a bracket around this loop
      // would attribute another call's requests to this one. One lookup is
      // issued per candidate, so the count is exact by construction.
      etagLookupGraphRequests: candidates.length,
      scanGraphRequestsByThisCall: scan.joined ? 0 : scan.result.graphRequests,
      scanSharedWithConcurrentCall: scan.joined,
    };

    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [{ type: "text" as const, text: generatePlanText(output).join("\n") }],
    };
  } catch (error) {
    // Logged before it is described, because `describeToolFailure` tells the
    // operator the full Graph response is in the server log, and a message must
    // not promise what this function did not do.
    console.error(`generate_rename_plan failed for profile "${args.profileId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}

function excludedFrom(candidate: RenameCandidate, reason: ExcludedPlanItem["reason"]): ExcludedPlanItem {
  return {
    path: candidate.path,
    currentName: candidate.currentName,
    targetName: candidate.targetName,
    client: candidate.client,
    reason,
  };
}
```

- [ ] **Step 7: Write `src/tools/rename/text.ts` (the generate half)**

```ts
import type { GenerateRenamePlanOutput } from "./output.js";

/**
 * Every line states something the output actually carries. Nothing here infers
 * what will happen when the plan runs: the plan's preconditions are checked at
 * execution, and a line here promising success would be exactly the message
 * this project produced nine times, correct on its own and wrong about what
 * the program did.
 */
export function generatePlanText(output: GenerateRenamePlanOutput): string[] {
  const lines = [
    `Plan ${output.planId} for profile "${output.profileId}", library "${output.library}".`,
    `${String(output.itemCount)} ${output.itemCount === 1 ? "rename" : "renames"} planned, ` +
      `${String(output.excludedCount)} excluded.`,
    `Based on a repository scan taken at ${output.scannedAt}.`,
  ];

  for (const item of output.items) {
    lines.push(`  ${item.path} -> ${item.targetName}`);
  }
  if (output.itemsOmitted > 0) {
    lines.push(`  ...and ${String(output.itemsOmitted)} more, all of them in the stored plan.`);
  }

  for (const item of output.excluded) {
    lines.push(`  excluded: ${item.path} (${item.reason})`);
  }
  if (output.excludedOmitted > 0) {
    lines.push(`  ...and ${String(output.excludedOmitted)} more exclusions, all of them in the stored plan.`);
  }

  lines.push(
    `Graph requests: ${String(output.workbookReadGraphRequestsByThisCall)} for the workbook, ` +
      `${String(output.scanGraphRequestsByThisCall)} for the scan, ` +
      `${String(output.etagLookupGraphRequests)} for the etag lookups.`,
  );
  lines.push(`Review this plan, then apply it with execute_rename_plan. It runs as a dry run unless confirm is true.`);

  return lines;
}
```

- [ ] **Step 8: Replace the stub in `src/tools/definitions/generate-rename-plan.ts`**

```ts
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { z } from "zod";
import { GENERATE_RENAME_PLAN_INPUT_SCHEMA, runGenerateRenamePlan } from "../rename/generate.js";
import { GENERATE_RENAME_PLAN_OUTPUT_SCHEMA } from "../rename/output.js";

export const generateRenamePlan: ToolDefinition = {
  name: "generate_rename_plan",
  kind: "plan",
  title: "Generate a rename plan",
  description: [
    "Produce a reviewable plan that renames files violating the profile's filename standard, one entry per file, each recording the current name, the proposed name, and the file's ETag fetched at plan time.",
    "Files whose canonical name is already taken, or that two files would both claim, are recorded as excluded rather than attempted.",
    "Returns a plan id that execute_rename_plan consumes. Review the plan before executing it.",
    SAFETY_SENTENCES.plan,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(GENERATE_RENAME_PLAN_INPUT_SCHEMA),
  outputSchema: GENERATE_RENAME_PLAN_OUTPUT_SCHEMA,
  handler: runGenerateRenamePlan,
};
```

- [ ] **Step 9: Run the tool suites and watch them pass**

Run: `npx vitest run tests/tools`
Expected: PASS, including `contract.test.ts` and `wire-contract.test.ts`, which now assert the real output schema reaches a client.

- [ ] **Step 10: Run the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/tools tests/tools
git commit -m "feat(tools): wire generate_rename_plan onto the execution layer"
```

---
## Task 5: Wire `execute_rename_plan`

**Files:**
- Modify: `src/tools/rename/output.ts` (add the execute half)
- Modify: `src/tools/rename/text.ts` (add the execute half)
- Create: `src/tools/rename/execute.ts`
- Modify: `src/tools/definitions/execute-rename-plan.ts`
- Test: `tests/tools/rename/execute.test.ts`, `tests/tools/rename/execute.errors.test.ts`

**Interfaces:**
- Consumes: `renameDriveItem`, `readDriveItemEtag` (Task 1); `StoredPlan`, `RenamePlanItem` (Task 2); `newPlanId`, `MAX_PLAN_ITEMS_LISTED` (Task 4).
- Produces:
  - `type RenameItemOutcome = "renamed" | "would_rename" | "changed_since_plan" | "not_found" | "failed"`
  - `EXECUTE_RENAME_PLAN_OUTPUT_SCHEMA`, `interface ExecuteRenamePlanOutput`
  - `runExecuteRenamePlan(input: unknown, context: ToolContext, makePlanId?): Promise<CallToolResult>`
  - `executePlanText(output: ExecuteRenamePlanOutput): string[]`

**The input gains a `profileId` the stub did not have.** The store partitions plans by profile, and a tool that searched every profile's partition for a plan id would be doing a scan to avoid one required argument. The handler also checks that the stored plan agrees with the profile it was asked for, which a partitioned read makes redundant today and would catch a store defect tomorrow.

**There is no second write gate in this handler, on purpose.** `selectTools` omits every `kind: "write"` tool from the registry when writes are disabled, and `src/tools/registry.ts` says in so many words that the predicate has exactly one definition so a security boundary cannot drift. A handler-level re-check would be that second definition.

- [ ] **Step 1: Add the execute output types to `src/tools/rename/output.ts`**

```ts
export const RENAME_ITEM_OUTCOMES = [
  "renamed",
  "would_rename",
  "changed_since_plan",
  "not_found",
  "failed",
] as const;

export type RenameItemOutcome = (typeof RENAME_ITEM_OUTCOMES)[number];

export interface RenameItemResult {
  path: string;
  currentName: string;
  targetName: string;
  targetPath: string;
  client: string;
  outcome: RenameItemOutcome;
}

export interface ExecuteRenamePlanOutput {
  planId: string;
  profileId: string;
  library: string;
  dryRun: boolean;
  results: RenameItemResult[];
  resultCount: number;
  resultsOmitted: number;
  counts: { renamed: number; wouldRename: number; changedSincePlan: number; notFound: number; failed: number };
  excluded: Array<{ path: string; currentName: string; targetName: string; client: string; reason: PlanExclusionReason }>;
  excludedCount: number;
  excludedOmitted: number;
  /** Absent on a dry run, which changes nothing and therefore writes no reversal log. */
  reversalPlanId?: string;
  reversalEntriesNotRefreshed: number;
  graphRequests: number;
}

export const EXECUTE_RENAME_PLAN_OUTPUT_SCHEMA = {
  planId: z.string().describe("The plan this call applied or previewed."),
  profileId: z.string().describe("The profile the plan belongs to."),
  library: z.string().describe("The document library named by the profile's identity."),
  dryRun: z
    .boolean()
    .describe(
      "True when nothing was changed. A dry run contacts Graph not at all, so it cannot tell whether a file has " +
        "changed since the plan was generated: outcomes of changed_since_plan and not_found can only appear in a " +
        "confirmed run.",
    ),
  results: z
    .array(
      z.object({
        path: z.string(),
        currentName: z.string(),
        targetName: z.string(),
        targetPath: z.string(),
        client: z.string(),
        outcome: z.enum(RENAME_ITEM_OUTCOMES),
      }),
    )
    .describe(
      "One entry per item in the plan, sorted by path. renamed means the file was renamed; would_rename means a " +
        "dry run reached it and stopped; changed_since_plan means its ETag precondition was refused and the file " +
        "was left untouched; not_found means nothing is at that path any more; failed means Graph answered with " +
        "something other than those two, and the server log carries it. May be a prefix; see resultCount.",
    ),
  resultCount: z.number().int().describe("Items in the plan. Computed before the listing above is cut."),
  resultsOmitted: z.number().int().describe("Items the listing above left out."),
  counts: z
    .object({
      renamed: z.number().int(),
      wouldRename: z.number().int(),
      changedSincePlan: z.number().int(),
      notFound: z.number().int(),
      failed: z.number().int(),
    })
    .describe("Computed over every item in the plan, before the listing above is cut. Never abridged."),
  excluded: z
    .array(
      z.object({
        path: z.string(),
        currentName: z.string(),
        targetName: z.string(),
        client: z.string(),
        reason: z.enum(PLAN_EXCLUSION_REASONS),
      }),
    )
    .describe(
      "Items the plan recorded at generation time as ones it would not attempt, carried here so an operator " +
        "reading this report does not have to hold the plan open beside it to learn why a file they expected to " +
        "be renamed was not.",
    ),
  excludedCount: z.number().int().describe("Excluded items in the plan. Computed before the listing above is cut."),
  excludedOmitted: z.number().int().describe("Excluded items the listing above left out."),
  reversalPlanId: z
    .string()
    .optional()
    .describe(
      "The plan id that undoes this run, written before the first rename. Absent on a dry run, which changes " +
        "nothing to reverse. Apply it with this same tool to roll back.",
    ),
  reversalEntriesNotRefreshed: z
    .number()
    .int()
    .describe(
      "Renames that succeeded but whose reversal entry could not be given the file's new ETag. Replaying the " +
        "reversal will refuse those items on their own precondition rather than undo them, so they need a fresh " +
        "plan. Zero is the normal result.",
    ),
  graphRequests: z
    .number()
    .int()
    .describe("What this call itself paid. Zero on a dry run, which contacts Graph not at all."),
} satisfies z.ZodRawShape;
```

- [ ] **Step 2: Add the execute fixtures to `tests/tools/rename/fixtures.ts`**

Appended to the file Task 4 created, so both suites share one set. `execute_rename_plan` never scans, so these need no snapshot or scan coordinator, only a store holding a plan and a Graph client that applies renames.

```ts
import type { StoredPlan } from "../../../src/store/types.js";

export const ITEM_A = {
  path: "2026/ACME/01-January/wrong-a.xlsx",
  currentName: "wrong-a.xlsx",
  targetName: "2026-01_ACME_MonthlyTraining.xlsx",
  targetPath: "2026/ACME/01-January/2026-01_ACME_MonthlyTraining.xlsx",
  etag: '"{GUID},1"',
  client: "ACME",
};

export const ITEM_B = {
  path: "2026/BETACO/01-January/wrong-b.xlsx",
  currentName: "wrong-b.xlsx",
  targetName: "2026-01_BETACO_MonthlyTraining.xlsx",
  targetPath: "2026/BETACO/01-January/2026-01_BETACO_MonthlyTraining.xlsx",
  etag: '"{GUID},2"',
  client: "BETACO",
};

export function planWith(items: StoredPlan["items"], excluded: StoredPlan["excluded"] = []): StoredPlan {
  return {
    planId: "rnm-2026-09-18-a1b2c3d4",
    profileId: "example",
    kind: "rename",
    driveId: "drive-1",
    createdAt: "2026-09-18T12:00:00Z",
    items,
    excluded,
  };
}

export interface RenameCall {
  path: string;
  name: string;
  ifMatch: string | undefined;
}

export interface RenamingClientOptions {
  /** Library-relative path to the Graph status its PATCH answers with. Absent means success. */
  patchStatuses?: Record<string, number>;
  /** False makes the PATCH response carry no etag, forcing the follow-up read. */
  etagOnPatchResponse?: boolean;
  /** A Graph status for the follow-up etag read, so the unrefreshable case can be exercised. */
  etagLookupStatus?: number;
}

/**
 * Applies renames into nothing at all: it records the calls and answers with a
 * fresh etag each time. That is enough, because what these tests assert is what
 * this server sent and what it recorded, never what SharePoint then held.
 * Proving the latter is the live sitting's job and no fake can stand in for it.
 *
 * Every method moves the same counter `requests()` reports, the way the real
 * client does.
 */
export function renamingGraphClient(options: RenamingClientOptions = {}): GraphClient & { calls: RenameCall[] } {
  const patchStatuses = options.patchStatuses ?? {};
  const etagOnPatchResponse = options.etagOnPatchResponse ?? true;
  const calls: RenameCall[] = [];
  let requestCount = 0;
  let version = 100;

  function encoded(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  return {
    calls,
    async get<T>(pathOrUrl: string): Promise<T> {
      requestCount += 1;
      if (options.etagLookupStatus !== undefined) {
        throw new GraphRequestError({ method: "GET", path: pathOrUrl, status: options.etagLookupStatus, body: "{}" });
      }
      version += 1;
      return { eTag: `"{GUID},${String(version)}"` } as unknown as T;
    },
    post: () => {
      requestCount += 1;
      return Promise.reject(new Error("the fake renaming client does not implement post"));
    },
    async patch<T>(pathOrUrl: string, body: unknown, headers?: Record<string, string>): Promise<T> {
      requestCount += 1;
      calls.push({ path: pathOrUrl, name: (body as { name: string }).name, ifMatch: headers?.["if-match"] });

      const failing = Object.entries(patchStatuses).find(([path]) => pathOrUrl.includes(encoded(path)));
      if (failing !== undefined) {
        throw new GraphRequestError({ method: "PATCH", path: pathOrUrl, status: failing[1], body: "{}" });
      }
      version += 1;
      return (etagOnPatchResponse ? { eTag: `"{GUID},${String(version)}"` } : {}) as unknown as T;
    },
    getBytes: () => {
      requestCount += 2;
      return Promise.reject(new Error("the fake renaming client does not implement getBytes"));
    },
    requests: () => requestCount,
  };
}
```

- [ ] **Step 3: Write the failing tests**

Create `tests/tools/rename/execute.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runExecuteRenamePlan } from "../../../src/tools/rename/execute.js";
import { createFakeToolContext } from "../fake-context.js";
import type { ExecuteRenamePlanOutput } from "../../../src/tools/rename/output.js";
import { ITEM_A, ITEM_B, planWith, renamingGraphClient } from "./fixtures.js";

const PLAN_ID = "rnm-2026-09-18-a1b2c3d4";
const REVERSAL_ID = "rev-2026-09-18-ffffffff";

function outputOf(result: Awaited<ReturnType<typeof runExecuteRenamePlan>>): ExecuteRenamePlanOutput {
  return result.structuredContent as unknown as ExecuteRenamePlanOutput;
}

describe("execute_rename_plan dry run", () => {
  it("contacts Graph not at all and reports every item as would_rename", async () => {
    const graph = renamingGraphClient();
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));

    const output = outputOf(await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID }, context));

    expect(output.dryRun).toBe(true);
    expect(output.counts.wouldRename).toBe(2);
    expect(output.counts.renamed).toBe(0);
    expect(output.graphRequests).toBe(0);
    expect(graph.calls).toEqual([]);
  });

  it("writes no reversal log, since it changed nothing to reverse", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const output = outputOf(await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID }, context));

    expect(output.reversalPlanId).toBeUndefined();
  });

  it("says in its own prose that it checked no preconditions", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const result = await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID }, context);
    const text = result.content.map((entry) => ("text" in entry ? entry.text : "")).join("\n");

    expect(text).toContain("contacted Graph not at all");
  });

  it("carries the plan's own exclusions into the report", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan(
      "example",
      planWith(
        [ITEM_A],
        [
          {
            path: "2026/ACME/02-February/other.xlsx",
            currentName: "other.xlsx",
            targetName: "2026-02_ACME_MonthlyTraining.xlsx",
            client: "ACME",
            reason: "target_path_already_occupied",
          },
        ],
      ),
    );

    const output = outputOf(await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID }, context));

    expect(output.excludedCount).toBe(1);
    expect(output.excluded[0]?.reason).toBe("target_path_already_occupied");
  });
});

describe("execute_rename_plan confirmed run", () => {
  it("renames each item under its own if-match and reports what it did", async () => {
    const graph = renamingGraphClient();
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.dryRun).toBe(false);
    expect(output.counts.renamed).toBe(2);
    expect(graph.calls.map((call) => call.name)).toEqual([ITEM_A.targetName, ITEM_B.targetName]);
    expect(graph.calls.map((call) => call.ifMatch)).toEqual([ITEM_A.etag, ITEM_B.etag]);
    expect(output.graphRequests).toBe(2);
  });

  it("writes a reversal log that is a valid plan with the pairs inverted", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.reversalPlanId).toBe(REVERSAL_ID);
    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.reverses).toBe(PLAN_ID);
    expect(reversal?.items[0]?.path).toBe(ITEM_A.targetPath);
    expect(reversal?.items[0]?.currentName).toBe(ITEM_A.targetName);
    expect(reversal?.items[0]?.targetName).toBe(ITEM_A.currentName);
    expect(reversal?.items[0]?.targetPath).toBe(ITEM_A.path);
  });

  it("writes the reversal log BEFORE the first rename, so a crash mid-apply still has one", async () => {
    // Proven by ordering rather than asserted: the fake's first PATCH reads the
    // store, and the reversal must already be there when it does.
    const graph = renamingGraphClient();
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    let reversalExistedAtFirstPatch: boolean | undefined;
    const originalPatch = graph.patch.bind(graph);
    graph.patch = async <T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> => {
      reversalExistedAtFirstPatch ??= (await context.store.getPlan("example", REVERSAL_ID)) !== undefined;
      return originalPatch<T>(path, body, headers);
    };

    await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID);

    expect(reversalExistedAtFirstPatch).toBe(true);
  });

  it("gives each reversal entry the file's NEW etag, so replaying it is not refused on a stale precondition", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan("example", planWith([ITEM_A]));

    await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID);

    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.items[0]?.etag).not.toBe(ITEM_A.etag);
    expect(reversal?.items[0]?.etag).toMatch(/^"\{GUID\},\d+"$/);
  });

  it("falls back to a metadata read when the PATCH response carries no etag, and charges for it", async () => {
    const graph = renamingGraphClient({ etagOnPatchResponse: false });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.graphRequests).toBe(2);
    expect(output.reversalEntriesNotRefreshed).toBe(0);
    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.items[0]?.etag).not.toBe(ITEM_A.etag);
  });
});
```

Create `tests/tools/rename/execute.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runExecuteRenamePlan } from "../../../src/tools/rename/execute.js";
import { createFakeToolContext } from "../fake-context.js";
import type { ExecuteRenamePlanOutput } from "../../../src/tools/rename/output.js";
import { ITEM_A, ITEM_B, planWith, renamingGraphClient } from "./fixtures.js";

const PLAN_ID = "rnm-2026-09-18-a1b2c3d4";
const REVERSAL_ID = "rev-2026-09-18-ffffffff";

function outputOf(result: Awaited<ReturnType<typeof runExecuteRenamePlan>>): ExecuteRenamePlanOutput {
  return result.structuredContent as unknown as ExecuteRenamePlanOutput;
}

function textOf(result: Awaited<ReturnType<typeof runExecuteRenamePlan>>): string {
  return result.content.map((entry) => ("text" in entry ? entry.text : "")).join("\n");
}

describe("per-item refusals", () => {
  it("skips only the item whose precondition failed and still applies the rest", async () => {
    const graph = renamingGraphClient({ patchStatuses: { [ITEM_A.path]: 412 } });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.counts.changedSincePlan).toBe(1);
    expect(output.counts.renamed).toBe(1);
    expect(output.results.find((entry) => entry.path === ITEM_A.path)?.outcome).toBe("changed_since_plan");
    expect(output.results.find((entry) => entry.path === ITEM_B.path)?.outcome).toBe("renamed");
  });

  it("reports an item that is no longer there as not_found and keeps going", async () => {
    const graph = renamingGraphClient({ patchStatuses: { [ITEM_A.path]: 404 } });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.counts.notFound).toBe(1);
    expect(output.counts.renamed).toBe(1);
  });

  it("records an unexpected Graph failure as failed and still applies the rest", async () => {
    // Abandoning the run would discard the report, which is the operator's
    // only account of which renames already applied; the reversal log alone
    // does not say which of its entries are live.
    const graph = renamingGraphClient({ patchStatuses: { [ITEM_A.path]: 500 } });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));

    const result = await runExecuteRenamePlan(
      { profileId: "example", planId: PLAN_ID, confirm: true },
      context,
      () => REVERSAL_ID,
    );
    const output = outputOf(result);

    expect(result.isError).toBeUndefined();
    expect(output.counts.failed).toBe(1);
    expect(output.counts.renamed).toBe(1);
  });

  it("leaves a reversal entry on its stale etag when no fresh one could be read, and counts it", async () => {
    // The PATCH answers with no etag and the follow-up read answers 404, which
    // is what someone renaming the file again between the two looks like.
    const graph = renamingGraphClient({ etagOnPatchResponse: false, etagLookupStatus: 404 });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.counts.renamed).toBe(1);
    expect(output.reversalEntriesNotRefreshed).toBe(1);
    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.items[0]?.etag).toBe(ITEM_A.etag);
  });

  it("says in its prose that an unrefreshed reversal entry will refuse rather than undo", async () => {
    const graph = renamingGraphClient({ etagOnPatchResponse: false, etagLookupStatus: 404 });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const result = await runExecuteRenamePlan(
      { profileId: "example", planId: PLAN_ID, confirm: true },
      context,
      () => REVERSAL_ID,
    );

    expect(textOf(result)).toContain("refuse those items");
  });
});

describe("refusals before anything is attempted", () => {
  it("refuses a plan id that is not stored, naming the profile and the tool that makes one", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });

    const result = await runExecuteRenamePlan(
      { profileId: "example", planId: "rnm-2026-09-18-nosuch01", confirm: true },
      context,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("rnm-2026-09-18-nosuch01");
    expect(textOf(result)).toContain("example");
    expect(textOf(result)).toContain("generate_rename_plan");
  });

  it("refuses an unknown profile through the shared failure mapper", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });

    const result = await runExecuteRenamePlan({ profileId: "nope", planId: PLAN_ID }, context);

    expect(result.isError).toBe(true);
  });
});
```

If any assertion in these files does not compile, fix the test rather than widening the code to accept it.

- [ ] **Step 4: Run them and watch them fail**

Run: `npx vitest run tests/tools/rename/execute`
Expected: FAIL, the module does not exist.

- [ ] **Step 5: Write `src/tools/rename/execute.ts`**

```ts
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readDriveItemEtag, renameDriveItem } from "../../graph/rename.js";
import type { RenamePlanItem, StoredPlan } from "../../store/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { newPlanId } from "./ids.js";
import {
  MAX_PLAN_ITEMS_LISTED,
  type ExecuteRenamePlanOutput,
  type RenameItemOutcome,
  type RenameItemResult,
} from "./output.js";
import { executePlanText } from "./text.js";

export const EXECUTE_RENAME_PLAN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Profile the plan was generated against, for example \"example\"."),
  planId: z
    .string()
    .min(1)
    .describe("Plan id returned by generate_rename_plan, for example \"rnm-2026-09-18-a1b2c3d4\"."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Set true to apply the plan for real, for example true. Leave false or omit for a dry run."),
} satisfies z.ZodRawShape;

const InputObject = z.object(EXECUTE_RENAME_PLAN_INPUT_SCHEMA);

function comparePaths(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * The inverse of a forward plan, ready before the first write.
 *
 * Each entry carries the forward item's PRE-rename etag, which is stale for the
 * inverse operation by construction: the rename it undoes has not happened yet,
 * and when it does it will change the etag. The executor overwrites each entry
 * as its rename lands. An entry that never gets overwritten keeps the stale
 * value and is refused on replay, which is the safe direction: a stale
 * precondition declines to act, where an absent one would rename whatever
 * happens to be sitting at that path.
 */
function reversalItemsFor(items: readonly RenamePlanItem[]): RenamePlanItem[] {
  return items.map((item) => ({
    path: item.targetPath,
    currentName: item.targetName,
    targetName: item.currentName,
    targetPath: item.path,
    etag: item.etag,
    client: item.client,
  }));
}

/**
 * Applies a rename plan, or previews it.
 *
 * There is one loop, not two. A dry run walks the same items in the same order
 * and makes the same per-item decision about what to send; the PATCH is the
 * only thing it does not do. A separately implemented preview would be a second
 * executor, and the two would disagree exactly when it mattered.
 */
export async function runExecuteRenamePlan(
  input: unknown,
  context: ToolContext,
  // Injected only by tests. Production always generates a fresh id.
  makeReversalPlanId: () => string = () => newPlanId("rev", context.now()),
): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "execute_rename_plan", profileId: args.profileId };

  try {
    const profile = context.profiles.get(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    const plan = await context.store.getPlan(args.profileId, args.planId);
    if (plan === undefined || plan.profileId !== args.profileId) {
      // The second half of that condition cannot fire through a partitioned
      // read today. It is checked anyway, because the alternative to a refusal
      // here is applying one profile's plan against another profile's library.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `No plan "${args.planId}" is stored for profile "${args.profileId}". Generate one with ` +
              "generate_rename_plan and pass the id it returns. Nothing was changed.",
          },
        ],
      };
    }

    const sorted = [...plan.items].sort(comparePaths);
    const results: RenameItemResult[] = [];
    let graphRequests = 0;
    let reversalEntriesNotRefreshed = 0;
    let reversalPlanId: string | undefined;

    if (!args.confirm) {
      for (const item of sorted) results.push(resultFor(item, "would_rename"));
    } else {
      const reversal: StoredPlan = {
        planId: makeReversalPlanId(),
        profileId: args.profileId,
        kind: "rename",
        driveId: plan.driveId,
        createdAt: context.now().toISOString(),
        items: reversalItemsFor(sorted),
        excluded: [],
        reverses: plan.planId,
      };
      // Written before the first rename, so a crash mid-apply still leaves
      // something to roll back with. It necessarily over-covers at this point,
      // listing inverses for renames that have not happened; replaying one of
      // those finds nothing at the source path and reports it, which is how the
      // over-coverage corrects itself through the same machinery.
      await context.store.savePlan(args.profileId, reversal);
      reversalPlanId = reversal.planId;

      for (const [index, item] of sorted.entries()) {
        let outcome: RenameItemOutcome;
        try {
          const renamed = await renameDriveItem(context.graph, {
            driveId: plan.driveId,
            path: item.path,
            newName: item.targetName,
            etag: item.etag,
          });
          graphRequests += 1;

          if (renamed.kind === "precondition_failed") {
            outcome = "changed_since_plan";
          } else if (renamed.kind === "not_found") {
            outcome = "not_found";
          } else {
            outcome = "renamed";
            let fresh = renamed.etag;
            if (fresh === undefined) {
              // Graph's documented PATCH response is the updated item, so this
              // branch should not run. It exists because "should" is not
              // "does", and this project has paid once for designing against
              // an API surface nobody had called.
              const lookup = await readDriveItemEtag(context.graph, {
                driveId: plan.driveId,
                path: item.targetPath,
              });
              graphRequests += 1;
              fresh = lookup.kind === "found" ? lookup.etag : undefined;
            }
            if (fresh === undefined) {
              reversalEntriesNotRefreshed += 1;
            } else {
              const entry = reversal.items[index];
              if (entry !== undefined) reversal.items[index] = { ...entry, etag: fresh };
              // Saved per item rather than once at the end. A single save at
              // the end would lose every correction to a crash, which is the
              // failure the early write exists to survive.
              await context.store.savePlan(args.profileId, reversal);
            }
          }
        } catch (error) {
          // Recorded and continued rather than rethrown. Rethrowing would
          // discard the report, which is the operator's only account of which
          // renames already applied; the reversal log alone does not say which
          // of its entries are live.
          console.error(`execute_rename_plan could not rename "${item.path}" under plan "${plan.planId}"`, error);
          graphRequests += 1;
          outcome = "failed";
        }
        results.push(resultFor(item, outcome));
      }
    }

    const excluded = [...plan.excluded].sort(comparePaths);
    const output: ExecuteRenamePlanOutput = {
      planId: plan.planId,
      profileId: plan.profileId,
      library: profile.identity.library,
      dryRun: !args.confirm,
      results: results.slice(0, MAX_PLAN_ITEMS_LISTED),
      resultCount: results.length,
      resultsOmitted: Math.max(0, results.length - MAX_PLAN_ITEMS_LISTED),
      counts: {
        renamed: countOf(results, "renamed"),
        wouldRename: countOf(results, "would_rename"),
        changedSincePlan: countOf(results, "changed_since_plan"),
        notFound: countOf(results, "not_found"),
        failed: countOf(results, "failed"),
      },
      excluded: excluded.slice(0, MAX_PLAN_ITEMS_LISTED),
      excludedCount: excluded.length,
      excludedOmitted: Math.max(0, excluded.length - MAX_PLAN_ITEMS_LISTED),
      ...(reversalPlanId === undefined ? {} : { reversalPlanId }),
      reversalEntriesNotRefreshed,
      graphRequests,
    };

    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [{ type: "text" as const, text: executePlanText(output).join("\n") }],
    };
  } catch (error) {
    console.error(`execute_rename_plan failed for profile "${args.profileId}" and plan "${args.planId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}

function resultFor(item: RenamePlanItem, outcome: RenameItemOutcome): RenameItemResult {
  return {
    path: item.path,
    currentName: item.currentName,
    targetName: item.targetName,
    targetPath: item.targetPath,
    client: item.client,
    outcome,
  };
}

function countOf(results: readonly RenameItemResult[], outcome: RenameItemOutcome): number {
  return results.filter((result) => result.outcome === outcome).length;
}
```

- [ ] **Step 6: Add the execute half of `src/tools/rename/text.ts`**

```ts
/**
 * Says what happened and nothing more. In particular the dry-run line states
 * that no precondition was checked, because a dry run contacts Graph not at
 * all: a reader who took a clean preview as a guarantee that every rename will
 * apply would be reading an assertion this code never made.
 */
export function executePlanText(output: ExecuteRenamePlanOutput): string[] {
  const lines = output.dryRun
    ? [
        `Dry run of plan ${output.planId} against library "${output.library}". Nothing was changed.`,
        `${String(output.counts.wouldRename)} ${output.counts.wouldRename === 1 ? "rename" : "renames"} would be attempted.`,
        "This preview contacted Graph not at all, so it did not check whether any file has changed since the plan " +
          "was generated. Those refusals can only appear in a confirmed run.",
      ]
    : [
        `Applied plan ${output.planId} against library "${output.library}".`,
        `${String(output.counts.renamed)} renamed, ${String(output.counts.changedSincePlan)} refused because the ` +
          `file changed since the plan, ${String(output.counts.notFound)} no longer at the planned path, ` +
          `${String(output.counts.failed)} failed.`,
      ];

  for (const result of output.results) {
    lines.push(`  ${result.path} -> ${result.targetName} (${result.outcome})`);
  }
  if (output.resultsOmitted > 0) {
    lines.push(`  ...and ${String(output.resultsOmitted)} more, all of them counted above.`);
  }

  for (const item of output.excluded) {
    lines.push(`  excluded at plan time: ${item.path} (${item.reason})`);
  }
  if (output.excludedOmitted > 0) {
    lines.push(`  ...and ${String(output.excludedOmitted)} more exclusions, all of them counted above.`);
  }

  if (output.reversalPlanId !== undefined) {
    lines.push(`Reversal plan ${output.reversalPlanId}. Apply it with this same tool to roll this run back.`);
  }
  if (output.reversalEntriesNotRefreshed > 0) {
    lines.push(
      `${String(output.reversalEntriesNotRefreshed)} reversal ${output.reversalEntriesNotRefreshed === 1 ? "entry" : "entries"} ` +
        "could not be given the file's new ETag, so replaying the reversal will refuse those items rather than " +
        "undo them. Generate a fresh plan for those files.",
    );
  }
  lines.push(`Graph requests: ${String(output.graphRequests)}.`);

  return lines;
}
```

Add the `ExecuteRenamePlanOutput` import to the top of that file.

- [ ] **Step 7: Replace the stub in `src/tools/definitions/execute-rename-plan.ts`**

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { EXECUTE_RENAME_PLAN_INPUT_SCHEMA, runExecuteRenamePlan } from "../rename/execute.js";
import { EXECUTE_RENAME_PLAN_OUTPUT_SCHEMA } from "../rename/output.js";

export const executeRenamePlan: ToolDefinition = {
  name: "execute_rename_plan",
  kind: "write",
  title: "Execute a rename plan",
  description: [
    "Apply a previously generated rename plan by its plan id, writing a reversal log before any change so the batch can be rolled back through this same tool.",
    "Each rename carries the ETag recorded at plan time, so a file edited since planning is reported as skipped rather than overwritten, and every untouched file still applies.",
    "Runs as a dry run unless confirm is true. A dry run contacts Graph not at all, so it cannot report which files have changed since the plan was generated.",
    SAFETY_SENTENCES.destructiveWrite,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(EXECUTE_RENAME_PLAN_INPUT_SCHEMA),
  outputSchema: EXECUTE_RENAME_PLAN_OUTPUT_SCHEMA,
  handler: runExecuteRenamePlan,
};
```

- [ ] **Step 8: Run everything and watch it pass**

Run: `npx vitest run tests/tools`
Expected: PASS, including the contract and wire-contract suites.

- [ ] **Step 9: Run the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/tools tests/tools
git commit -m "feat(tools): wire execute_rename_plan with per-item preconditions and a reversal log"
```

---

## Task 6: A second planted misnamed file, and the documentation this phase owes

**Files:**
- Modify: `scripts/seed-library.ts`
- Modify: `tests/scripts/seed-library.test.ts`
- Modify: `tests/scripts/seed/expected.test.ts`
- Modify: `docs/SETUP.md`
- Modify: `docs/OPEN-ITEMS.md`
- Modify: `CLAUDE.md`

**Why the seeder changes.** It plants exactly one misnamed file today. The merge gate for this phase has to show one item refusing on its ETag while the others still apply, and with a single item there are no others. Two is the smallest number that makes that observable.

**Interfaces:**
- Produces: `MISNAMED_FILE_CLIENTS: readonly string[]`, replacing `MISNAMED_FILE_CLIENT: string`.

- [ ] **Step 1: Write the failing test for a second planted misnamed file**

In `tests/scripts/seed-library.test.ts`, change the existing single-file assertion (near line 294) to cover every planted client. Read the surrounding test first and keep its style:

```ts
  it("plants one misnamed file per client in the planted set, each replacing that client's compliant file", () => {
    const plan = buildSeedPlan(profile, options);

    for (const client of MISNAMED_FILE_CLIENTS) {
      const compliant = `2026/${client}/01-January/2026-01_${client}_MonthlyTraining.xlsx`;
      const misnamed = `2026/${client}/01-January/2026-01_${client}_VendorTraining.xlsx`;

      expect(plan.tree.filePaths, `${client} still carries its compliant file`).not.toContain(compliant);
      expect(plan.tree.filePaths, `${client} has no misnamed file`).toContain(misnamed);
    }
    expect(MISNAMED_FILE_CLIENTS.length).toBeGreaterThan(1);
  });
```

Update that file's import from `MISNAMED_FILE_CLIENT` to `MISNAMED_FILE_CLIENTS`, and do the same in `tests/scripts/seed/expected.test.ts`, where the two uses become:

```ts
    const misnamed = report().artifacts.filter(
      (a) => MISNAMED_FILE_CLIENTS.includes(a.client) && a.state === "misnamed",
    );
    expect(misnamed).toHaveLength(MISNAMED_FILE_CLIENTS.length);
```

and

```ts
    const planted = new Set([ABSENT_CLIENT, MISSING_FILE_CLIENT, ...MISNAMED_FILE_CLIENTS]);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/scripts`
Expected: FAIL, `MISNAMED_FILE_CLIENTS` is not exported.

- [ ] **Step 3: Generalize the plant in `scripts/seed-library.ts`**

Replace the constant:

```ts
/**
 * More than one, deliberately. A single misnamed file cannot demonstrate the
 * property the write path most needs shown: one item refused on its own ETag
 * precondition while every other item in the same batch still applies. With one
 * file there is no "every other item".
 */
export const MISNAMED_FILE_CLIENTS = ["Client08", "Client09"] as const;
```

Update the floor, which is still derived rather than hardcoded:

```ts
const MINIMUM_CLIENT_COUNT_FOR_PLANTED_DRIFT = Math.max(
  clientIndexFromPlantedName(MISSING_FILE_CLIENT),
  ...MISNAMED_FILE_CLIENTS.map(clientIndexFromPlantedName),
);
```

Update the refusal message to name the whole set:

```ts
      `discrepancy set, which names ${MISSING_FILE_CLIENT} and ${MISNAMED_FILE_CLIENTS.join(", ")}. Got ` +
```

Replace the single `replacedFrom` and `replacedTo` pair with a map built over the set, keeping the per-path presence check that comment explains is load bearing:

```ts
  const renames = new Map<string, string>();
  for (const client of MISNAMED_FILE_CLIENTS) {
    const from = plantedPath(profile, year, client, MISNAMED_FILE_MONTH, monthlyToken);
    const to = plantedPath(profile, year, client, MISNAMED_FILE_MONTH, MISNAMED_DELIVERABLE_TOKEN);
    // Checked individually and by path presence, for the reason the original
    // comment gives: a map lookup that finds nothing is a silent no-op, and a
    // length check on the result cannot see a rename that did not happen.
    if (!base.filePaths.includes(from)) {
      throw new Error(
        `${from} is not in the tree buildSeedTree produced, so the misnamed-file plant for ${client} cannot ` +
          `rename it to ${to}. clientCount and month are both guaranteed in range here, so the profile's naming ` +
          "template and this seed's planted set must have diverged.",
      );
    }
    renames.set(from, to);
  }
```

and the file list becomes:

```ts
  const filePaths = base.filePaths
    .filter((path) => path !== omitted)
    .map((path) => renames.get(path) ?? path);
```

Fix every remaining reference the typechecker names.

- [ ] **Step 4: Run the seeder tests and watch them pass**

Run: `npx vitest run tests/scripts`
Expected: PASS. The floor is unchanged at 9 because `Client09` is still the highest planted index, so no existing `clientCount` becomes invalid.

- [ ] **Step 5: Document the third table in `docs/SETUP.md`**

Find where that document lists the storage tables this server creates (`DeltaLinks` and `Inventory`) and add `Plans` alongside them, with one sentence: it holds generated rename plans and the reversal logs that undo them, both under the same entity shape, and it is created on first use like the other two.

- [ ] **Step 6: Record what this phase has and has not proved in `docs/OPEN-ITEMS.md`**

Add a dated entry under the live-verification section. Say exactly this much and no more, because none of it has run yet:

- Phase 6a is the first write path this server has. As of this commit it is covered by fakes only. No rename has been applied to a real SharePoint library, no reversal log has been replayed, and no real 412 has been observed.
- Every fake in this suite rejects `patch` except the two written for the rename tests, which apply renames into memory. A fake proves the code does what its author believed Graph does. The ETag precondition in particular is a claim about Graph's behavior on a `driveItem` PATCH that this project has never made.
- The merge gate is the full loop against the sandbox tenant: generate, dry run, execute, confirm the renames in SharePoint, roll back through the reversal log, confirm the library is byte for byte where it started, then edit one file between generating and executing and confirm that item alone is refused while the others apply.

- [ ] **Step 7: Add the phase 6a entry to the Build Sequence in `CLAUDE.md`**

Add a phase 6 entry after phase 5, describing 6a as built and covered by fakes only, naming what it delivers and what it deliberately leaves to 6b and 6c: moves, `replicate_template`, `$batch` and `conflictBehavior`. State plainly that the live sitting has not run.

Per the Working Agreement, the sitting's own record and the correction of this entry happen together in one commit, which is the controller's to make after the gate runs. This step writes the entry that says the sitting is still owed; it does not claim one happened.

- [ ] **Step 8: Run the gates and commit**

```bash
npm run lint && npm run typecheck && npm test
git add scripts tests/scripts docs CLAUDE.md
git commit -m "feat(seed): plant a second misnamed file, and record what phase 6a has not proved"
```

---

## What the controller owes after the last task

Not a task, and not the implementer's work. Recorded here so it is not lost.

1. Run the whole-branch review on the most capable model. Every phase since phase 2 has had its Criticals found at joins no single task owned, and this branch has more joins than most: the etag's journey from the plan-time fetch through the store, into the PATCH header, and back out into a reversal entry crosses all four layers and no task sees it end to end.
2. Run the live sitting on the sandbox tenant, the full loop in the spec's verification section. This is the first time this project will write to a real SharePoint library.
3. Record the sitting in `docs/OPEN-ITEMS.md` and correct the Build Sequence entry in `CLAUDE.md` **in the same commit**, per the Working Agreement.
