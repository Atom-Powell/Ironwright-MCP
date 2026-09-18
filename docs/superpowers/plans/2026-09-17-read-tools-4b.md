# Phase 4b Read Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `inventory_tree`, `query_repository` and `validate_structure` onto the phase 4a execution layer, and widen the tool contract so an input schema can carry an object-level refinement.

**Architecture:** Each tool is a composition root under `src/tools/<tool>/` with `run.ts`, `shape.ts` and `text.ts`, exactly matching `src/tools/reconciliation/`. `inventory_tree` and `validate_structure` scan through the existing `ScanCoordinator`; `query_repository` reads the persisted inventory and issues no Graph request at all. No new compliance logic is written: the existing pure domain functions are reused.

**Tech Stack:** TypeScript, Node 22, Zod 3.25, `@modelcontextprotocol/sdk`, Vitest.

**Binding spec:** `docs/superpowers/specs/2026-09-17-read-tools-4b-design.md`. Where this plan and that spec disagree, the spec wins.

## Global Constraints

- No emojis or icons anywhere, including logs, tests and docs. US English throughout.
- No em dashes or en dashes anywhere in the repo, including inside string literals. A test enforces this across tracked TypeScript, JavaScript, JSON, Markdown and YAML.
- Comments explain why, not what.
- The domain layer is pure. No I/O. Enforced by lint.
- A function that cannot observe an outcome must not assert it. Every operator-facing sentence is asserted in tests against the structure it describes.
- Every tool carries a Zod input schema with real constraints and worked examples, an `outputSchema` with `structuredContent`, and all four annotations set explicitly.
- Totals are computed over the complete result set before truncation and reported exactly. A truncated listing always states how many items were omitted.
- Caps, as named constants exported from the module that uses them: `MAX_INVENTORY_ITEMS = 500`, `MAX_QUERY_FINDINGS = 200`, `MAX_CLIENT_DETAIL = 50`, `RECENT_REPORTS_LIMIT = 50`.
- Every tool output carries `scannedAt` and `graphRequests`.
- Gates before every commit: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`.

---

## File Structure

**Created**

- `src/tools/inventory/{run,shape,text,output}.ts` and its tests
- `src/tools/query/{run,shape,text,output}.ts` and its tests
- `src/tools/validate/{run,shape,text,output}.ts` and its tests
- `src/domain/structure/conform.ts`, the pure taxonomy conformance checker

**Modified**

- `src/tools/types.ts`, the contract
- `src/mcp/build-server.ts`, schema pass-through
- All ten files in `src/tools/definitions/`
- `src/tools/errors.ts`, `FailureSubject.tool`
- `src/tools/reconciliation/run.ts`, the one existing call site of `FailureSubject`
- `src/store/{types,memory,table}.ts`, `getScannedDrives`
- `src/scan/snapshot.ts`, export `withinSubPath`
- `tests/tools/contract.test.ts`, the refinement rule

---

### Task 1: Widen the tool input contract

**Files:**
- Modify: `src/tools/types.ts`
- Modify: `src/mcp/build-server.ts:46`
- Modify: all ten files in `src/tools/definitions/`
- Test: `tests/tools/contract.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ToolDefinition.inputSchema: z.ZodTypeAny` and `ToolDefinition.inputConstraints?: string`. Every later task's definition file wraps its fields in `z.object({...})`.

`outputSchema` stays `z.ZodRawShape` and is not touched by this task.

- [ ] **Step 1: Write the failing test**

Append to `tests/tools/contract.test.ts`:

```typescript
import { z } from "zod";
import { ALL_TOOLS } from "../../src/tools/registry.js";
import type { ToolDefinition } from "../../src/tools/types.js";

/**
 * A refinement does not survive conversion to JSON Schema, so a caller and the
 * model driving it never see it. An unstated one is a rejection the caller
 * could not have predicted, which is why the prose is mandatory rather than
 * encouraged.
 */
function isRefined(schema: z.ZodTypeAny): boolean {
  return !(schema instanceof z.ZodObject);
}

describe("input schema contract", () => {
  it("every tool's input schema is an object, refined or plain", () => {
    for (const tool of ALL_TOOLS) {
      const base = tool.inputSchema instanceof z.ZodEffects ? tool.inputSchema.innerType() : tool.inputSchema;
      expect(base, `${tool.name} input schema must be an object`).toBeInstanceOf(z.ZodObject);
    }
  });

  it("a refined input schema states its constraint in the description", () => {
    for (const tool of ALL_TOOLS) {
      if (!isRefined(tool.inputSchema)) continue;
      expect(tool.inputConstraints, `${tool.name} is refined and must set inputConstraints`).toBeTruthy();
      expect(tool.description).toContain(tool.inputConstraints as string);
    }
  });

  it("the refinement rule actually fails a refined tool that omits the prose", () => {
    const bad: ToolDefinition = {
      name: "fixture_tool",
      kind: "read",
      title: "Fixture",
      description: "A fixture with no constraint prose.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({ a: z.string().optional(), b: z.string().optional() }).refine((v) => v.a !== undefined || v.b !== undefined),
      outputSchema: { ok: z.boolean() },
    };
    expect(isRefined(bad.inputSchema)).toBe(true);
    expect(bad.inputConstraints).toBeUndefined();
  });
});
```

The third test exists because no tool in this phase is refined, so without a fixture the rule would pass vacuously and nobody would learn it is broken until phase 6.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tools/contract.test.ts`
Expected: FAIL. `inputConstraints` does not exist on `ToolDefinition`, and the definitions are raw shapes rather than objects.

- [ ] **Step 3: Widen the contract**

In `src/tools/types.ts`, replace the `inputSchema` line and add the new field:

```typescript
  /**
   * A full schema rather than a raw shape, because a raw shape is a bag of
   * per-field schemas and structurally cannot express a constraint spanning
   * two fields. `generate_move_plan` needs one: nothing otherwise enforces
   * that `scopeValue` is present when `scope` is `client` or `deliverable`.
   * The SDK accepts either form, so this passes straight through.
   */
  inputSchema: z.ZodTypeAny;
  /**
   * The cross-field constraint, in the words the description uses. Required
   * when `inputSchema` carries a refinement and meaningless otherwise, because
   * a refinement is invisible in the JSON Schema the caller receives.
   */
  inputConstraints?: string;
```

Change the import at the top of that file from `import type { z }` to `import { z }` is NOT needed; `z.ZodTypeAny` is a type, so `import type { z } from "zod";` still works.

- [ ] **Step 4: Convert all ten definitions**

In each file under `src/tools/definitions/`, wrap the existing object literal:

```typescript
  inputSchema: z.object({
    profileId: z.string().min(1).describe("Configured profile to inventory, for example \"example\"."),
    subPath: z
      .string()
      .optional()
      .describe("Library-relative path to limit the scan, for example \"2026/CLIENTA\". Omit to scan the whole library."),
  }),
```

Every field keeps its existing schema and its existing `.describe` text verbatim. This is a mechanical wrap and nothing inside the braces changes.

`src/tools/reconciliation/run.ts` exports `RECONCILE_INPUT_SCHEMA` as a raw shape and builds `InputObject` from it. Leave that export alone; `src/tools/definitions/reconcile.ts` wraps it as `z.object(RECONCILE_INPUT_SCHEMA)`, so the handler and the definition keep one source of truth.

- [ ] **Step 5: Pass it through in build-server**

`src/mcp/build-server.ts:46` already reads `inputSchema: tool.inputSchema` and needs no change. If TypeScript complains at the `registerTool` call, the SDK's `InputArgs` accepts `AnySchema`, so widen the generic rather than casting the value.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS, including every pre-existing contract assertion unchanged. Those assertions passing untouched is the check that the rewrite of the seven definitions not otherwise being edited was mechanical.

- [ ] **Step 7: Commit**

```bash
git add src/tools/types.ts src/tools/definitions src/mcp/build-server.ts tests/tools/contract.test.ts
git commit -m "feat(tools): accept a full input schema so a refinement is expressible"
```

---

### Task 2: Stop the shared failure mapper claiming every tool reconciles

**Files:**
- Modify: `src/tools/errors.ts`
- Modify: `src/tools/reconciliation/run.ts`
- Test: `tests/tools/errors.test.ts`, `tests/tools/errors.errors.test.ts`

**Interfaces:**
- Produces: `FailureSubject { tool: string; profileId: string; siteUrl?: string; library?: string }`. Every later task constructs one with `tool` set to its own registered tool name.

- [ ] **Step 1: Write the failing test**

Add to `tests/tools/errors.test.ts`:

```typescript
it("names the tool that failed rather than assuming reconciliation", () => {
  const error = new GraphRequestError("GET", "/drives/x/root/delta", 503, undefined, "");
  const message = describeToolFailure(error, { tool: "inventory_tree", profileId: "example" });

  expect(message).toContain("inventory_tree");
  expect(message).not.toContain("reconciling");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tools/errors.test.ts`
Expected: FAIL. The message reads "while reconciling profile \"example\"".

- [ ] **Step 3: Add the field and use it**

In `src/tools/errors.ts`, add to `FailureSubject`:

```typescript
export interface FailureSubject {
  /**
   * The failing tool's own registered name. Required rather than optional
   * because this mapper is shared, and a message that names the wrong
   * operation is the defect class this project produced nine times in phase 1:
   * correct on its own, wrong about what the program actually did.
   */
  tool: string;
  profileId: string;
  siteUrl?: string;
  library?: string;
}
```

Then in the `GraphRequestError` branch, replace `while reconciling profile` with:

```typescript
      `${error.code === undefined ? "" : ` (${error.code})`}, while serving ${subject.tool} for profile ` +
      `"${subject.profileId}". ` +
```

- [ ] **Step 4: Update the one existing call site**

In `src/tools/reconciliation/run.ts`, change the subject construction to:

```typescript
  const subject: FailureSubject = { tool: "reconcile_workbook_vs_repository", profileId: args.profileId };
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS. Existing assertions that looked for "reconciling" must be updated to the new sentence, and the reconcile message still names reconciliation because the tool name carries it.

- [ ] **Step 6: Commit**

```bash
git add src/tools/errors.ts src/tools/reconciliation/run.ts tests/tools
git commit -m "fix(tools): name the failing tool instead of asserting it was reconciling"
```

---

### Task 3: Let the store answer which drives a profile has scanned

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/memory.ts`
- Modify: `src/store/table.ts`
- Test: `tests/store/conformance.ts`

**Interfaces:**
- Produces: `StateStore.getScannedDrives(profileId: string): Promise<ScannedDrive[]>` where `ScannedDrive = { driveId: string; lastScanAt: string }`. Task 5 is its only consumer.

- [ ] **Step 1: Write the failing test**

Add to the shared suite in `tests/store/conformance.ts`, so both implementations are held to it:

```typescript
it("returns nothing for a profile that has never been scanned", async () => {
  const store = await makeStore();
  expect(await store.getScannedDrives("never-scanned")).toEqual([]);
});

it("returns each scanned drive with the time it was last scanned", async () => {
  const store = await makeStore();
  await store.setDeltaLink("example", "drive-1", "link-1", "2026-09-17T10:00:00.000Z");
  await store.setDeltaLink("example", "drive-2", "link-2", "2026-09-17T11:00:00.000Z");

  const drives = await store.getScannedDrives("example");

  expect(drives).toHaveLength(2);
  expect(drives).toContainEqual({ driveId: "drive-1", lastScanAt: "2026-09-17T10:00:00.000Z" });
  expect(drives).toContainEqual({ driveId: "drive-2", lastScanAt: "2026-09-17T11:00:00.000Z" });
});

it("does not leak one profile's drives into another's", async () => {
  const store = await makeStore();
  await store.setDeltaLink("example", "drive-1", "link-1", "2026-09-17T10:00:00.000Z");
  await store.setDeltaLink("other", "drive-9", "link-9", "2026-09-17T10:00:00.000Z");

  expect(await store.getScannedDrives("example")).toEqual([
    { driveId: "drive-1", lastScanAt: "2026-09-17T10:00:00.000Z" },
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/store`
Expected: FAIL. `getScannedDrives` is not a function.

- [ ] **Step 3: Declare it**

In `src/store/types.ts`:

```typescript
export interface ScannedDrive {
  driveId: string;
  lastScanAt: string;
}
```

and on `StateStore`:

```typescript
  /**
   * Every drive this profile has scanned to completion, with the time of that
   * scan. Reads the partition `setDeltaLink` already writes, so nothing new is
   * persisted. It exists so a tool serving an answer from the stored inventory
   * can find the drive without calling `resolveDrive`, which would be a Graph
   * request and would cost `query_repository` the zero-request promise its own
   * description makes.
   */
  getScannedDrives(profileId: string): Promise<ScannedDrive[]>;
```

- [ ] **Step 4: Implement it in memory**

In `src/store/memory.ts`, the delta links are held in a map. Add:

```typescript
    async getScannedDrives(profileId: string): Promise<ScannedDrive[]> {
      const drives: ScannedDrive[] = [];
      for (const [key, value] of deltaLinks) {
        const separator = key.indexOf("\u0000");
        if (key.slice(0, separator) !== profileId) continue;
        drives.push({ driveId: key.slice(separator + 1), lastScanAt: value.lastScanAt });
      }
      return drives;
    },
```

Match the existing key encoding in that file rather than assuming the NUL separator above; if the file keys its map differently, use its own helper.

- [ ] **Step 5: Implement it against Table Storage**

In `src/store/table.ts`, the `deltaLinks` table is partitioned by `profileId` and each entity carries `driveId` and `lastScanAt`, so this is a single-partition query using the existing `partitionFilter` helper:

```typescript
    async getScannedDrives(profileId: string): Promise<ScannedDrive[]> {
      const drives: ScannedDrive[] = [];
      for await (const entity of clients.deltaLinks.listEntities({
        queryOptions: { filter: partitionFilter(profileId) },
      })) {
        if (typeof entity.driveId !== "string" || typeof entity.lastScanAt !== "string") continue;
        drives.push({ driveId: entity.driveId, lastScanAt: entity.lastScanAt });
      }
      return drives;
    },
```

The two type guards skip an entity written by an older build rather than crashing the read, which matters because this table survives a deployment.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS for both implementations from the one shared suite.

- [ ] **Step 7: Commit**

```bash
git add src/store tests/store
git commit -m "feat(store): expose which drives a profile has scanned"
```

---

### Task 4: `inventory_tree`

**Files:**
- Create: `src/tools/inventory/output.ts`, `shape.ts`, `text.ts`, `run.ts`
- Modify: `src/scan/snapshot.ts`, export `withinSubPath`
- Modify: `src/tools/definitions/inventory-tree.ts`
- Test: `tests/tools/inventory/{shape,text,run}.test.ts`

**Interfaces:**
- Consumes: `FailureSubject` with `tool` from Task 2; `z.object(...)` input schemas from Task 1.
- Produces: `runInventoryTree(input: unknown, context: ToolContext): Promise<CallToolResult>`, attached as the definition's `handler`.

- [ ] **Step 1: Export the sub-path test rather than copying it**

In `src/scan/snapshot.ts`, change `function withinSubPath` to `export function withinSubPath`. Its doc comment already explains why a segment-boundary test is required instead of `startsWith`, and that reason applies identically here. Copying the function would give the repository two definitions of the same trap.

- [ ] **Step 2: Write the failing shape test**

`tests/tools/inventory/shape.test.ts`:

```typescript
import { shapeInventory, MAX_INVENTORY_ITEMS } from "../../../src/tools/inventory/shape.js";

const snapshot = {
  files: [
    { path: "2026/CLIENTA/report.docx", name: "report.docx", size: 12, modified: "2026-09-01T00:00:00.000Z", etag: "a" },
    { path: "2026/CLIENTB/report.docx", name: "report.docx", size: 30, modified: "2026-09-02T00:00:00.000Z", etag: "b" },
  ],
  folderPaths: ["2026", "2026/CLIENTA", "2026/CLIENTB"],
  scannedAt: "2026-09-17T00:00:00.000Z",
  searchCrossCheckIncluded: false,
};

it("counts the whole library and lists all of it when under the cap", () => {
  const output = shapeInventory("example", snapshot, undefined, 4, {});

  expect(output.totals).toEqual({ files: 2, folders: 3, bytes: 42 });
  expect(output.listing).toEqual({ returned: 5, omitted: 0, cap: MAX_INVENTORY_ITEMS, truncated: false });
});

it("narrows to a sub-path on segment boundaries, not string prefixes", () => {
  const withSibling = {
    ...snapshot,
    files: [
      ...snapshot.files,
      { path: "2026/CLIENTAB/report.docx", name: "report.docx", size: 5, modified: "2026-09-03T00:00:00.000Z", etag: "c" },
    ],
    folderPaths: [...snapshot.folderPaths, "2026/CLIENTAB"],
  };

  const output = shapeInventory("example", withSibling, "2026/CLIENTA", 4, {});

  expect(output.totals).toEqual({ files: 1, folders: 1, bytes: 12 });
  expect(output.items.map((item) => item.path)).not.toContain("2026/CLIENTAB/report.docx");
});

it("keeps the totals exact when the listing truncates", () => {
  const output = shapeInventory("example", snapshot, undefined, 4, { maxItems: 2 });

  expect(output.totals).toEqual({ files: 2, folders: 3, bytes: 42 });
  expect(output.listing).toEqual({ returned: 2, omitted: 3, cap: 2, truncated: true });
  expect(output.items).toHaveLength(2);
});

it("omits size for a folder rather than reporting zero", () => {
  const output = shapeInventory("example", snapshot, undefined, 4, {});
  const folder = output.items.find((item) => item.kind === "folder");

  expect(folder).toBeDefined();
  expect(folder).not.toHaveProperty("size");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/tools/inventory/shape.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Write the output types**

`src/tools/inventory/output.ts`:

```typescript
import { z } from "zod";

export const MAX_INVENTORY_ITEMS = 500;

export const INVENTORY_OUTPUT_SCHEMA = {
  profileId: z.string(),
  library: z.string(),
  subPath: z.string().optional(),
  scannedAt: z.string(),
  totals: z.object({ files: z.number(), folders: z.number(), bytes: z.number() }),
  items: z.array(
    z.object({
      path: z.string(),
      name: z.string(),
      kind: z.enum(["file", "folder"]),
      size: z.number().optional(),
      modified: z.string(),
    }),
  ),
  listing: z.object({
    returned: z.number(),
    omitted: z.number(),
    cap: z.number(),
    truncated: z.boolean(),
  }),
  graphRequests: z.number(),
};

const OutputObject = z.object(INVENTORY_OUTPUT_SCHEMA);
export type InventoryToolOutput = z.infer<typeof OutputObject>;
```

- [ ] **Step 5: Write the shaping module**

`src/tools/inventory/shape.ts`:

```typescript
import type { RepositorySnapshot } from "../../domain/reconcile/index.js";
import { withinSubPath } from "../../scan/snapshot.js";
import { MAX_INVENTORY_ITEMS, type InventoryToolOutput } from "./output.js";

export { MAX_INVENTORY_ITEMS };

export interface InventoryShapeOptions {
  /** Overridden only by tests, so the truncation rule runs on a small fixture. */
  maxItems?: number;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Totals come from the full filtered set and the listing is cut afterwards, in
 * that order. Counting what survived the cut and presenting it as a count of
 * what exists is the substitution this project treats as its worst failure,
 * and it is one line away at every truncation site.
 */
export function shapeInventory(
  profileId: string,
  snapshot: RepositorySnapshot,
  subPath: string | undefined,
  graphRequests: number,
  options: InventoryShapeOptions,
): InventoryToolOutput {
  const cap = options.maxItems ?? MAX_INVENTORY_ITEMS;
  const keep = (path: string): boolean =>
    subPath === undefined || subPath.length === 0 || withinSubPath(path, subPath);

  // A cross-library file carries `library` and was found by the Search
  // cross-check in a different library, so it is not part of this library's
  // tree and must not be counted as though it were.
  const files = snapshot.files.filter((file) => file.library === undefined && keep(file.path));
  const folders = snapshot.folderPaths.filter(keep);

  const items = [
    ...files.map((file) => ({
      path: file.path,
      name: file.name,
      kind: "file" as const,
      size: file.size,
      modified: file.modified,
    })),
    ...folders.map((path) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      kind: "folder" as const,
      modified: snapshot.scannedAt,
    })),
  ].sort((a, b) => compareStrings(a.path, b.path));

  const listed = items.slice(0, cap);

  return {
    profileId,
    library: "",
    ...(subPath === undefined ? {} : { subPath }),
    scannedAt: snapshot.scannedAt,
    totals: {
      files: files.length,
      folders: folders.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
    },
    items: listed,
    listing: { returned: listed.length, omitted: items.length - listed.length, cap, truncated: listed.length < items.length },
    graphRequests,
  };
}
```

`library` is filled by `run.ts`, which is what holds the profile. The empty string here is replaced before the value leaves the tool; the test asserts the run-level value, not this one.

A folder has no modified date of its own in the snapshot, so it reports the scan time. The test in Step 2 asserts a folder carries no `size`; add one asserting `modified` equals `scannedAt` for a folder so the substitution is stated rather than assumed.

- [ ] **Step 6: Run the shape tests**

Run: `npx vitest run tests/tools/inventory/shape.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing text test**

`tests/tools/inventory/text.test.ts`:

```typescript
import { inventoryText } from "../../../src/tools/inventory/text.js";

const truncated = {
  profileId: "example",
  library: "Documents",
  subPath: "2026/CLIENTA",
  scannedAt: "2026-09-17T00:00:00.000Z",
  totals: { files: 900, folders: 120, bytes: 1024 },
  items: [],
  listing: { returned: 500, omitted: 520, cap: 500, truncated: true },
  graphRequests: 4,
};

it("reports the true totals and says what was left out", () => {
  const lines = inventoryText(truncated).join("\n");

  expect(lines).toContain("900 files");
  expect(lines).toContain("120 folders");
  expect(lines).toContain("520");
  expect(lines).toContain("subPath");
  expect(lines).toContain("2026/CLIENTA");
});

it("does not claim a complete listing when the listing was cut", () => {
  const lines = inventoryText(truncated).join("\n").toLowerCase();
  expect(lines).not.toContain("complete listing");
});

it("says nothing about truncation when nothing was truncated", () => {
  const whole = { ...truncated, listing: { returned: 20, omitted: 0, cap: 500, truncated: false } };
  expect(inventoryText(whole).join("\n")).not.toContain("omitted");
});
```

- [ ] **Step 8: Write the text module**

`src/tools/inventory/text.ts` returns `string[]`, one sentence per line, naming the library, the sub-path when one was given, the exact totals, the Graph cost, and, only when `listing.truncated`, how many items were omitted and that `subPath` narrows the request.

- [ ] **Step 9: Run the text tests**

Run: `npx vitest run tests/tools/inventory/text.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the run composition and its test**

`src/tools/inventory/run.ts` mirrors `src/tools/reconciliation/run.ts`: parse the input with the definition's own schema, resolve the profile, call `context.scans.run(profile)`, shape with `scan.joined ? 0 : scan.result.graphRequests`, set `library` from `profile.identity.library`, and return `structuredContent` plus the text block. The `catch` logs first, then returns `isError` with `describeToolFailure(error, { tool: "inventory_tree", profileId, siteUrl, library })`.

`tests/tools/inventory/run.test.ts` uses `tests/tools/fake-context.ts` and asserts: an unknown `profileId` returns `isError` with the registry's message; a joined scan reports `graphRequests: 0`; a `subPath` matching nothing returns zeroed totals and is not an error.

- [ ] **Step 11: Attach the handler**

In `src/tools/definitions/inventory-tree.ts`, replace `STUB_OUTPUT_SCHEMA` with `INVENTORY_OUTPUT_SCHEMA` and add `handler: runInventoryTree`.

- [ ] **Step 12: Run the whole suite and commit**

Run: `npm run lint && npm run typecheck && npm run build && npm test`

```bash
git add src/tools/inventory src/tools/definitions/inventory-tree.ts src/scan/snapshot.ts tests/tools/inventory
git commit -m "feat(tools): wire inventory_tree with honest truncation"
```

---

### Task 5: `query_repository`

**Files:**
- Create: `src/tools/query/output.ts`, `shape.ts`, `text.ts`, `run.ts`
- Modify: `src/tools/definitions/query-repository.ts`
- Test: `tests/tools/query/{shape,text,run}.test.ts`

**Interfaces:**
- Consumes: `StateStore.getScannedDrives` from Task 3; `assembleSnapshot` from `src/scan/snapshot.ts`; `findEmptyFolders` from `src/domain/reconcile/empty-folders.js`; `createFileParser` from `src/domain/reconcile/parse.js`.
- Produces: `runQueryRepository(input: unknown, context: ToolContext): Promise<CallToolResult>`.

- [ ] **Step 1: Narrow the published enum**

In `src/tools/definitions/query-repository.ts` the enum becomes:

```typescript
    question: z
      .enum(["empty_folders", "naming_violations", "recent_reports"])
      .describe("Which stored question to answer, for example \"empty_folders\"."),
```

and the description's first sentence becomes:

```
"Answer operational questions from the stored repository index: empty folders, files whose names do not meet the standard, and recently modified reports."
```

The second sentence keeps its existing zero-cost claim, which this task makes true.

- [ ] **Step 2: Write the failing run test**

`tests/tools/query/run.test.ts`:

```typescript
it("fails rather than reporting zero findings when nothing has been scanned", async () => {
  const context = makeFakeContext({ scannedDrives: [] });

  const result = await runQueryRepository({ profileId: "example", question: "empty_folders" }, context);

  expect(result.isError).toBe(true);
  expect(String(result.content[0].text)).toContain("inventory_tree");
  expect(String(result.content[0].text)).toContain("reconcile_workbook_vs_repository");
});

it("issues no Graph request for any question", async () => {
  const context = makeFakeContext({ scannedDrives: [{ driveId: "d1", lastScanAt: "2026-09-17T00:00:00.000Z" }] });

  for (const question of ["empty_folders", "naming_violations", "recent_reports"] as const) {
    const result = await runQueryRepository({ profileId: "example", question }, context);
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { graphRequests: number }).graphRequests).toBe(0);
  }

  expect(context.graph.requests()).toBe(0);
});

it("uses the most recently scanned drive when a profile has more than one", async () => {
  const context = makeFakeContext({
    scannedDrives: [
      { driveId: "old", lastScanAt: "2026-09-01T00:00:00.000Z" },
      { driveId: "new", lastScanAt: "2026-09-17T00:00:00.000Z" },
    ],
  });

  await runQueryRepository({ profileId: "example", question: "empty_folders" }, context);

  expect(context.store.lastListedDrive).toBe("new");
});
```

`makeFakeContext` gains a `scannedDrives` option and a `lastListedDrive` spy; extend `tests/tools/fake-context.ts` rather than writing a second fake.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/tools/query/run.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Write the answerers**

`src/tools/query/run.ts`:

```typescript
export const RECENT_REPORTS_LIMIT = 50;

/**
 * No Graph client is touched on any path through this function. The drive id
 * comes from the store rather than from `resolveDrive`, which is the whole
 * reason `getScannedDrives` exists.
 */
async function loadSnapshot(context: ToolContext, profile: Profile) {
  const drives = await context.store.getScannedDrives(profile.profileId);
  if (drives.length === 0) throw new NeverScannedError(profile.profileId);

  // A profile names one library, so more than one row means the profile was
  // repointed after a scan. The newest wins and the response names the drive
  // it used, because mixing two libraries' inventories would be worse than
  // either choice.
  const chosen = [...drives].sort((a, b) => (a.lastScanAt < b.lastScanAt ? 1 : -1))[0]!;
  const records = await context.store.listInventory(profile.profileId, chosen.driveId);
  return { snapshot: assembleSnapshot(records, chosen.lastScanAt), driveId: chosen.driveId };
}
```

`NeverScannedError` is declared in this file and its message names both `inventory_tree` and `reconcile_workbook_vs_repository` as the ways to populate the index. `describeToolFailure` passes an unrecognized error's message through unchanged, so no change to `src/tools/errors.ts` is needed.

The three answerers each return `Finding[]` where `Finding = { path: string; name: string; modified?: string; detail: string }`:

```typescript
function emptyFolders(snapshot: RepositorySnapshot): Finding[] {
  return findEmptyFolders(snapshot).map((path) => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    detail: "No file or deeper folder sits under this folder.",
  }));
}

function namingViolations(profile: Profile, snapshot: RepositorySnapshot): Finding[] {
  const parse = createFileParser(profile);
  return snapshot.files
    .filter((file) => file.library === undefined)
    .filter((file) => !parse(file).recognized)
    .map((file) => ({
      path: file.path,
      name: file.name,
      modified: file.modified,
      detail: `This name does not match the profile's filename template "${profile.naming.template}" or any of its ${profile.naming.recognizers.length} recognizers.`,
    }));
}

function recentReports(profile: Profile, snapshot: RepositorySnapshot): Finding[] {
  const parse = createFileParser(profile);
  return snapshot.files
    .filter((file) => file.library === undefined)
    .map((file) => ({ file, parsed: parse(file) }))
    .filter((entry) => entry.parsed.recognized)
    .sort((a, b) => (a.file.modified < b.file.modified ? 1 : -1))
    .slice(0, RECENT_REPORTS_LIMIT)
    .map((entry) => ({
      path: entry.file.path,
      name: entry.file.name,
      modified: entry.file.modified,
      detail: `Parsed as the ${(entry.parsed as ParsedFileRecognized).deliverable} deliverable.`,
    }));
}
```

Cross-library files are excluded from all three for the reason `empty-folders.ts` already documents: the cross-check supplies candidates for expected artifacts, never facts about this library's contents.

- [ ] **Step 5: Shape, text, and the output schema**

`src/tools/query/output.ts` declares `MAX_QUERY_FINDINGS = 200` and the output schema from the spec. `shape.ts` applies the cap with exact totals, identically to Task 4. `text.ts` names the question, the finding count, the snapshot time and its age in whole minutes at `context.now()`, and states that the answer cost no Graph requests and is as current as that scan.

`tests/tools/query/text.test.ts` asserts the age sentence against a fixed `now`, and asserts the text never says "current" without naming the scan time.

- [ ] **Step 6: Attach the handler and run everything**

Replace `STUB_OUTPUT_SCHEMA` with `QUERY_OUTPUT_SCHEMA` and add `handler: runQueryRepository`.

Run: `npm run lint && npm run typecheck && npm run build && npm test`

- [ ] **Step 7: Commit**

```bash
git add src/tools/query src/tools/definitions/query-repository.ts tests/tools
git commit -m "feat(tools): wire query_repository as a zero-request index reader"
```

---

### Task 6: The pure taxonomy conformance checker

**Files:**
- Create: `src/domain/structure/conform.ts`
- Test: `tests/domain/structure/conform.test.ts`

**Interfaces:**
- Produces: `buildTaxonomyMatcher(profile: Profile): (relativePath: string) => boolean`, true when the path matches the taxonomy for its depth. Task 7 is its only consumer.

This file is in the domain layer, so it performs no I/O.

- [ ] **Step 1: Write the failing test**

`tests/domain/structure/conform.test.ts`, against a profile whose `taxonomy.segments` is `["{year}", "{client}", "{month:02}"]` and whose deliverables carry tokens `TRAINING` and `SAFETY`:

```typescript
it("accepts a path that matches every segment to its depth", () => {
  const matches = buildTaxonomyMatcher(profile);
  expect(matches("2026")).toBe(true);
  expect(matches("2026/CLIENTA")).toBe(true);
  expect(matches("2026/CLIENTA/09")).toBe(true);
});

it("rejects a segment that is not the right shape", () => {
  const matches = buildTaxonomyMatcher(profile);
  expect(matches("twenty-twenty-six")).toBe(false);
  expect(matches("2026/CLIENTA/13")).toBe(false);
  expect(matches("2026/CLIENTA/September")).toBe(false);
});

it("rejects a path deeper than the taxonomy allows", () => {
  expect(buildTaxonomyMatcher(profile)("2026/CLIENTA/09/extra")).toBe(false);
});

it("anchors each segment so a longer segment cannot pass", () => {
  expect(buildTaxonomyMatcher(profile)("2026x/CLIENTA")).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/domain/structure/conform.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement it**

```typescript
import { TOKEN_PATTERN } from "../profile/placeholders.js";
import { MONTH_NAMES } from "../reconcile/months.js";
import type { Profile } from "../profile/schema.js";

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One pattern per placeholder, matching exactly what `render.ts` can produce
 * for that token and nothing else. `{client}` is the exception: the renderer
 * emits a client's own name and this checker is asked about clients it has not
 * been given, so it accepts any segment that is not empty and holds no
 * separator.
 */
function patternFor(token: string, deliverableTokens: readonly string[]): string {
  switch (token) {
    case "year":
      return "\\d{4}";
    case "month":
      return "(?:[1-9]|1[0-2])";
    case "month:02":
      return "(?:0[1-9]|1[0-2])";
    case "monthName":
      return `(?:${MONTH_NAMES.join("|")})`;
    case "deliverable":
      return `(?:${deliverableTokens.map(escapeLiteral).join("|")})`;
    case "client":
      return "[^/]+";
    default:
      // The profile validator rejects unknown tokens against this same set, so
      // reaching here is an upstream bug rather than a bad profile.
      throw new Error(`unknown placeholder {${token}}`);
  }
}

function segmentRegex(segment: string, deliverableTokens: readonly string[]): RegExp {
  let source = "";
  let cursor = 0;
  for (const match of segment.matchAll(TOKEN_PATTERN)) {
    source += escapeLiteral(segment.slice(cursor, match.index));
    source += patternFor(match[1] ?? "", deliverableTokens);
    cursor = (match.index ?? 0) + match[0].length;
  }
  source += escapeLiteral(segment.slice(cursor));
  return new RegExp(`^${source}$`);
}

export function buildTaxonomyMatcher(profile: Profile): (relativePath: string) => boolean {
  const deliverableTokens = profile.deliverables.map((deliverable) => deliverable.token);
  const patterns = profile.taxonomy.segments.map((segment) => segmentRegex(segment, deliverableTokens));

  return (relativePath: string): boolean => {
    const segments = relativePath.split("/");
    if (segments.length === 0 || segments.length > patterns.length) return false;
    return segments.every((segment, index) => patterns[index]!.test(segment));
  };
}
```

Every segment pattern is anchored with `^` and `$`, which is what stops "2026x" passing the `{year}` segment.

- [ ] **Step 4: Run the tests and commit**

Run: `npx vitest run tests/domain/structure && npm run lint`

```bash
git add src/domain/structure tests/domain/structure
git commit -m "feat(domain): add a pure taxonomy conformance matcher"
```

---

### Task 7: `validate_structure`

**Files:**
- Create: `src/tools/validate/output.ts`, `shape.ts`, `text.ts`, `run.ts`
- Modify: `src/tools/definitions/validate-structure.ts`
- Test: `tests/tools/validate/{shape,text,run}.test.ts`

**Interfaces:**
- Consumes: `buildTaxonomyMatcher` from Task 6; `createFileParser`; `FailureSubject` with `tool`.
- Produces: `runValidateStructure(input: unknown, context: ToolContext): Promise<CallToolResult>`.

- [ ] **Step 1: Correct the published description**

In `src/tools/definitions/validate-structure.ts`, the first sentence becomes:

```
"Check one or more clients against the profile's folder taxonomy and filename standard, returning compliant, non-compliant, or missing along with the specific folders and files responsible for the verdict."
```

which is unchanged, and the `clients` field description becomes:

```
"Clients to validate, for example [\"CLIENTA\"]. Omit to validate every client folder present in the library."
```

The change from "every client in the workbook" is required: this tool does not read the workbook.

Add a third sentence to the description, before the safety sentence:

```
"It reports whether what exists is shaped correctly, not whether everything that should exist is present; use reconcile_workbook_vs_repository for that, because only the workbook says what is owed."
```

- [ ] **Step 2: Write the failing shape test**

`tests/tools/validate/shape.test.ts` asserts, against a fixture snapshot:

- a client whose folders all match the taxonomy and whose files all parse is `compliant` with both detail lists empty;
- a client with one folder that matches no taxonomy path is `non_compliant` and that folder appears in `nonConformingFolders`;
- a client with one unparseable file is `non_compliant` and that file appears in `nonConformingFiles` with a reason naming the template;
- a client named in `clients` with no folder at all is `missing`;
- a client not named and not present does not appear at all;
- `totals` counts every client evaluated even when the client listing truncates;
- a client with 60 non-conforming files lists 50 and reports `nonConformingFilesOmitted: 10`.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/tools/validate/shape.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement the shaping**

`src/tools/validate/output.ts` declares `MAX_CLIENT_DETAIL = 50` and the output schema from the spec. `src/tools/validate/shape.ts`:

```typescript
/**
 * The client of a library-relative path, taken as the segment at the index the
 * taxonomy puts `{client}` in. A taxonomy with no `{client}` segment has no
 * per-client structure to validate, which `run.ts` refuses before reaching
 * here rather than returning an empty report that reads like a clean bill.
 */
export function clientSegmentIndex(profile: Profile): number {
  return profile.taxonomy.segments.findIndex((segment) => segment.includes("{client}"));
}
```

For each client in scope, collect the folders and files whose path's client segment equals that client, test each folder with the matcher from Task 6, parse each file with `createFileParser`, and assign the verdict by the spec's three rules. Truncate each detail list at `MAX_CLIENT_DETAIL` with its own omitted count, and truncate the client list at the same constant with the shared `listing` block. Totals count every client evaluated, before either truncation.

- [ ] **Step 5: Write the text module and its test**

`src/tools/validate/text.ts` states the counts by verdict, names the clients that are not compliant, and, when any list truncated, says so. Its test asserts the summary against a shaped output where a truncated detail list would tempt a wrong sentence, specifically a client with 60 non-conforming files whose summary must not say "60 listed".

- [ ] **Step 6: Write the run composition and its test**

`src/tools/validate/run.ts` parses input, resolves the profile, refuses with a clear message when `clientSegmentIndex(profile) < 0`, runs the coordinator scan, shapes, and returns. The `catch` uses `{ tool: "validate_structure", ... }`.

`tests/tools/validate/run.test.ts` asserts: a profile whose taxonomy has no `{client}` segment returns `isError` naming the taxonomy; a named client absent from the library is `missing`; an omitted `clients` argument evaluates every client folder present and never returns `missing`.

- [ ] **Step 7: Attach the handler, run everything, commit**

Run: `npm run lint && npm run typecheck && npm run build && npm test`

```bash
git add src/tools/validate src/tools/definitions/validate-structure.ts tests/tools/validate
git commit -m "feat(tools): wire validate_structure as a conformance check"
```

---

### Task 8: Record the phase honestly

**Files:**
- Modify: `docs/OPEN-ITEMS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the coverage section**

Add a section to `docs/OPEN-ITEMS.md` titled "Phase 4b: covered only by fakes, 2026-09-17" stating that no call in this phase has reached a tenant, listing exactly what the unit tests cover, and naming the three checks the live sitting must run, copied from the spec's "Verification before merge".

- [ ] **Step 2: Update the build sequence**

In `CLAUDE.md`, phase 4's entry changes from "1 of 5 wired" to name 4a and 4b, with `describe_workbook` called out as 4c and still unwired. Do not claim live verification.

- [ ] **Step 3: Commit**

```bash
git add docs/OPEN-ITEMS.md CLAUDE.md
git commit -m "docs: record phase 4b coverage and its unrun live checks"
```

---

## Self-Review

**Spec coverage.** The contract change is Task 1. The `describeToolFailure` correction is Task 2. The new store method is Task 3. The three tools are Tasks 4, 5 and 7, with Task 6 supplying the pure checker Task 7 needs. The shared rules on truncation, `scannedAt`, `graphRequests` and audited prose are in the Global Constraints and repeated in each tool's steps. "Verification before merge" is Task 8 plus the live sitting itself, which is the controller's to run before the branch merges and is not a task here because it needs a tenant.

**Placeholder scan.** Tasks 4, 5 and 7 describe `text.ts` in prose rather than giving its full source. That is deliberate and bounded: the tests that pin each one are specified exactly, including the sentences that must and must not appear, so the implementer has a falsifiable target rather than a blank. Every other code step carries real code.

**Type consistency.** `FailureSubject` gains `tool` in Task 2 and every later `catch` sets it. `ScannedDrive` is declared in Task 3 and consumed only in Task 5. `buildTaxonomyMatcher` is produced in Task 6 and consumed only in Task 7. `withinSubPath` is exported in Task 4 and used only there. The three cap constants are declared in the `output.ts` of their own tool and re-exported from `shape.ts` where the tests import them.

**One known gap, stated rather than hidden.** Task 5's `recentReports` reads `entry.parsed.deliverable` through a cast to `ParsedFileRecognized`. The filter immediately above it guarantees the narrowing, but TypeScript does not carry that through a `.filter` on a mapped object. The implementer should replace the cast with a type predicate on the filter if one reads cleanly, and the reviewer should reject the cast if it is load-bearing anywhere else.
