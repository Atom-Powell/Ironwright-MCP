# Workbook Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a real Excel workbook into a `WorkbookSnapshot`, so the reconciliation engine finally has both of its inputs.

**Architecture:** Three new modules plus one extension to an existing one. `src/graph/client.ts` gains POST and per-call headers, which Excel needs and nothing else has needed until now. `src/graph/excel.ts` carries no domain knowledge: open a non-persistent session, read a table range or a worksheet's used range, close it. `src/workbook/read.ts` is pure: a grid of cell values plus a profile's mapping becomes records and rejections, with no I/O, so every mapping rule is testable against fixtures. `src/scan/workbook.ts` composes them.

**Tech Stack:** TypeScript, Node 22+, ESM with NodeNext resolution, vitest, plain `fetch`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-14-workbook-snapshot-design.md`. It is binding where this plan and it disagree.

## Global Constraints

Every task's requirements implicitly include all of these.

- **No emojis or icons anywhere**, including logs and docs. **US English throughout.** This repo's prose avoids em dashes and en dashes, including in strings.
- **Comments explain why, not what.** `src/graph/` and `src/setup/` carry unusually dense rationale; match that register.
- **A function that cannot observe an outcome must not assert it.** This project has caught fifteen instances of the same defect in three days: a message correct clause by clause and false once assembled, or one asserting something the program did not observe. When you write or change anything an operator reads, read the assembled string across every combination of the fields that feed it, not clause by clause.
- **The domain layer stays pure.** Nothing in `src/domain/` may import anything this plan adds. Task 3 extends the lint rule to cover the new directory.
- **Imports carry the `.js` extension** (NodeNext), and `verbatimModuleSyntax` is on, so type-only imports must be written `import type`.
- **`noUncheckedIndexedAccess` is on.** An indexed read is `T | undefined` and must be narrowed. This matters more than usual here: the reader indexes into a grid of unknown shape on every row.
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
| `src/graph/client.ts` | The Graph HTTP front door | Add `post` and per-call headers |
| `src/graph/excel.ts` | Excel session lifecycle and range reads. No domain knowledge | Create |
| `src/workbook/read.ts` | Grid plus mapping to records and rejections. Pure, no I/O | Create |
| `src/scan/workbook.ts` | Composition: profile plus Graph to a `WorkbookSnapshot` | Create |
| `src/domain/reconcile/types.ts` | The engine's frozen contract | Add rejected rows to the snapshot and the report |
| `src/domain/reconcile/index.ts` | The engine's single entry | Carry rejections into the report |
| `eslint.config.js` | The purity fence | Deny `**/workbook/**` to the domain layer |

---

### Task 1: the Graph client learns POST and per-call headers

Excel needs both and nothing else has. Creating a session is `POST /workbook/createSession`, closing it is `POST /workbook/closeSession`, and every call in between carries a `workbook-session-id` header. `GraphClient` currently exposes `get<T>(pathOrUrl)` and nothing else.

This is a change to the module every other part of the Graph layer depends on, so the bar is that no existing caller changes behavior.

**Files:**
- Modify: `src/graph/client.ts`
- Test: `tests/graph/client.test.ts`, `tests/graph/client.errors.test.ts`

**Interfaces:**
- Consumes: `GraphRequestError` from `src/graph/errors.js`, `withRetry`/`isRetriableStatus`/`RetryPolicy` from `src/graph/retry.js`, `TokenProvider` from `src/graph/token.js`. All unchanged.
- Produces:
  ```ts
  export interface GraphClient {
    get<T>(pathOrUrl: string, headers?: Record<string, string>): Promise<T>;
    post<T>(pathOrUrl: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
    requests(): number;
  }
  ```
  `get`'s existing single-argument calls keep working unchanged. Every `SetupGraph` and scan caller is unaffected.

- [ ] **Step 1: Write the failing tests**

Add to `tests/graph/client.test.ts`:

```ts
  it("sends a POST with a JSON body and the bearer token", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response(JSON.stringify({ id: "session-1" }), { status: 200 });
      }) as typeof fetch,
    });

    const value = await client.post<{ id: string }>("/drives/d1/items/i1/workbook/createSession", {
      persistChanges: false,
    });

    expect(value.id).toBe("session-1");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    await expect(seen[0]?.text()).resolves.toBe(JSON.stringify({ persistChanges: false }));
  });

  it("sends per-call headers alongside the ones it always sets", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await client.get("/drives/d1/items/i1/workbook/tables/T/range", { "workbook-session-id": "s-1" });

    expect(seen[0]?.headers.get("workbook-session-id")).toBe("s-1");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer token-1");
  });

  it("omits a body and its content type when a POST has none", async () => {
    const seen: Request[] = [];
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response("", { status: 204 });
      }) as typeof fetch,
    });

    await client.post("/drives/d1/items/i1/workbook/closeSession", undefined, { "workbook-session-id": "s-1" });

    expect(seen[0]?.headers.get("content-type")).toBeNull();
  });
```

Add to `tests/graph/client.errors.test.ts`:

```ts
  it("names the method in a failed POST, not GET", async () => {
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => new Response(JSON.stringify({ error: { code: "itemNotFound" } }), { status: 404 })) as typeof fetch,
    });

    await expect(client.post("/drives/d1/items/i1/workbook/createSession", {})).rejects.toMatchObject({
      name: "GraphRequestError",
      method: "POST",
      status: 404,
    });
  });

  it("does not retry a POST that rejects at the transport, because it may have reached the server", async () => {
    let attempts = 0;
    const client = createGraphClient({
      tokenProvider: TOKEN,
      retry: defaultRetryPolicy({ maxAttempts: 4, sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => {
        attempts += 1;
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });

    await expect(client.post("/drives/d1/items/i1/workbook/createSession", {})).rejects.toThrow(/fetch failed/);
    expect(attempts).toBe(1);
  });

  it("names the method in the non-JSON refusal, which currently hard-codes GET", async () => {
    const client = createGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => new Response("<html>proxy</html>", { status: 200 })) as typeof fetch,
    });

    await expect(client.post("/drives/d1/items/i1/workbook/createSession", {})).rejects.toThrow(/Graph POST/);
  });

  it("still retries a POST that returns a retriable status", async () => {
    const statuses = [429, 200];
    let call = 0;
    const client = createGraphClient({
      tokenProvider: TOKEN,
      retry: defaultRetryPolicy({ sleep: async () => {}, now: () => 0 }),
      fetchImpl: (async () => {
        const status = statuses[call] ?? 200;
        call += 1;
        return new Response("{}", { status, headers: status === 429 ? { "retry-after": "0" } : {} });
      }) as typeof fetch,
    });

    await client.post("/drives/d1/items/i1/workbook/createSession", {});

    expect(client.requests()).toBe(2);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/graph/client.test.ts tests/graph/client.errors.test.ts`
Expected: FAIL, `client.post is not a function`.

- [ ] **Step 3: Implement**

Refactor the existing body into one shared request path so `get` and `post` cannot drift. The existing `get` behavior must not change: same URL handling, same label computation, same retry, same non-JSON refusal.

```ts
interface RequestOptions {
  method: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * A transport rejection means the request may or may not have reached the
   * server. Replaying a GET costs a duplicate read; replaying a POST can apply
   * a second mutation. So the thrown-error retry is offered to reads only, and
   * a POST that rejects surfaces immediately. Returned statuses are different:
   * a 429 or a 503 is the server declining to act, so both methods retry those.
   */
  retryTransportErrors: boolean;
}
```

Build one internal `request<T>(pathOrUrl, options)` carrying the current logic, then:

```ts
    async get<T>(pathOrUrl: string, headers?: Record<string, string>): Promise<T> {
      return request<T>(pathOrUrl, { method: "GET", retryTransportErrors: true, ...(headers === undefined ? {} : { headers }) });
    },

    async post<T>(pathOrUrl: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
      return request<T>(pathOrUrl, {
        method: "POST",
        retryTransportErrors: false,
        ...(body === undefined ? {} : { body }),
        ...(headers === undefined ? {} : { headers }),
      });
    },
```

Inside `send`, set `content-type: application/json` and serialize only when a body is present, and spread `options.headers` BEFORE the always-set ones, so `authorization`, `accept` and `content-type` cannot be shadowed by a per-call header. Later spread wins in an object literal, so the always-set headers have to come last to be the ones that survive a collision. A caller needing a different `accept` or `content-type` changes this function rather than passing a header, which is the deliberate trade: the alternative is a caller silently dropping the bearer token and getting an auth error with no indication why.

Two places currently hard-code the method and both are read by an operator. `GraphRequestError` is constructed with `method: "GET"`, and the non-JSON refusal message begins `Graph GET ${label}`. Both take `options.method`. A POST failure reporting itself as a GET is precisely the defect class this repo tracks: every clause true, the assembled sentence false.

`retryTransportErrors` is not a field `withRetry` reads. It is the fourth argument, the predicate that decides whether a thrown error is worth another attempt:

```ts
        options.retryTransportErrors ? isRetriableTransportError : () => false,
```

Leave the module-level `isRetriableTransportError` exactly as it is. It encodes which thrown errors are retriable at all, which is orthogonal to whether this method may be replayed, and conflating the two would change GET's behavior.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/graph/`
Expected: PASS, including every pre-existing client test unchanged.

- [ ] **Step 5: Run everything, then commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add src/graph/client.ts tests/graph
git commit -m "feat: let the Graph client POST and carry per-call headers"
```

---

### Task 2: the engine's contract carries rejected rows

The spec's decision that a row which cannot be read is rejected rather than aborting the report only means something if the rejection reaches the operator. That requires changing two types the engine froze in phase 3, and the golden fixture that pins its output.

**Files:**
- Modify: `src/domain/reconcile/types.ts`, `src/domain/reconcile/index.ts`
- Modify: `tests/domain/reconcile/fixtures/workbook.json`, `tests/domain/reconcile/fixtures/expected-report.json`
- Test: `tests/domain/reconcile/reconcile.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface RejectedWorkbookRow {
    /** 1-based row number in the sheet, so it matches what the operator sees. */
    row: number;
    /** The client the row named, when that cell was readable. */
    client?: string;
    /** Why it was refused, in terms an operator can act on. */
    reason: string;
  }
  ```
  `WorkbookSnapshot` gains `rejectedRows: RejectedWorkbookRow[]`. `ReconciliationReport` gains `rejectedWorkbookRows: RejectedWorkbookRow[]`.

- [ ] **Step 1: Write the failing test**

Add to `tests/domain/reconcile/reconcile.test.ts`:

```ts
  it("carries the workbook's rejected rows into the report, so an omission is visible where results are read", () => {
    const workbook = {
      rows: [{ client: "CLIENTA", fields: { monthlyTraining: true } }],
      source: "Tracker.xlsx",
      rejectedRows: [{ row: 7, client: "CLIENTB", reason: "effectiveFrom was not a date: \"15/08/2026\"" }],
    };

    const report = reconcile(profile, workbook, repository, { year: 2026, month: 9 });

    expect(report.rejectedWorkbookRows).toEqual([
      { row: 7, client: "CLIENTB", reason: "effectiveFrom was not a date: \"15/08/2026\"" },
    ]);
  });
```

Use whatever `profile` and `repository` fixtures that file already builds; do not invent new ones.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/domain/reconcile/reconcile.test.ts`
Expected: FAIL. The type does not have the field, so this fails at typecheck as well as at runtime.

- [ ] **Step 3: Extend the types**

In `src/domain/reconcile/types.ts`, add `RejectedWorkbookRow` with the doc comments from the Interfaces block above, add `rejectedRows` to `WorkbookSnapshot`, and add `rejectedWorkbookRows` to `ReconciliationReport`.

Put a comment on the report field explaining why it exists:

```ts
  /**
   * Rows the workbook reader could not turn into records. They live on the
   * report because a client silently missing from a compliance report is the
   * quiet incompleteness this engine exists to prevent, and a rejection that
   * reaches only a log is exactly that.
   */
  rejectedWorkbookRows: RejectedWorkbookRow[];
```

- [ ] **Step 4: Carry them through the engine**

In `src/domain/reconcile/index.ts`, copy `workbook.rejectedRows` onto the report beside `provenance`. The engine does not interpret them: it never saw the raw rows, and inventing an interpretation here would assert something it did not observe.

- [ ] **Step 5: Repair the callers the required field breaks**

`rejectedRows` is required, not optional. An optional field would let `src/scan/workbook.ts` forget to populate it with nothing to catch the omission, and the whole argument for this task is that a rejection must reach the report rather than a log.

The cost is that every existing `WorkbookSnapshot` literal stops typechecking. There are seven such files:

```
tests/domain/reconcile/expected.errors.test.ts
tests/domain/reconcile/expected.test.ts
tests/domain/reconcile/fixtures/load.ts
tests/domain/reconcile/period.errors.test.ts
tests/domain/reconcile/reconcile.parser-reuse.test.ts
tests/domain/reconcile/reconcile.test.ts
tests/domain/reconcile/workbook-rows.errors.test.ts
```

Add `rejectedRows: []` to each literal. This is mechanical and must stay mechanical: if fixing one of them seems to require changing what the test asserts, stop and report it rather than editing the assertion. `workbook-rows.errors.test.ts` in particular holds the duplicate-client refusal the spec calls out, and that behavior must not move.

Run `npm run typecheck` to enumerate them rather than trusting this list, which was taken by grep and can miss a literal built through a helper.

- [ ] **Step 6: Update the golden fixture**

`tests/domain/reconcile/fixtures/workbook.json` gains `"rejectedRows": []`, and `expected-report.json` gains `"rejectedWorkbookRows": []`. The golden report's existing content must not otherwise change: if any other field moves, stop and report it, because that means the engine's behavior changed when only its shape should have.

- [ ] **Step 7: Run everything, then commit**

```bash
npx vitest run tests/domain/
npm run lint && npm run typecheck && npm test && npm run build
git add src/domain tests/domain
git commit -m "feat: carry rejected workbook rows into the reconciliation report"
```

---

### Task 3: the pure reader

The mapping layer, and the heart of this phase. Pure, no I/O, so every rule below is testable against fixture grids with no Graph and no tenant.

**Files:**
- Create: `src/workbook/read.ts`
- Modify: `eslint.config.js`
- Test: `tests/workbook/read.test.ts`, `tests/workbook/read.errors.test.ts`, `tests/lint-guardrails.test.ts`

**Interfaces:**
- Consumes: `Profile` from `src/domain/profile/schema.js`, and `ClientRecord`, `RejectedWorkbookRow` from `src/domain/reconcile/index.js`. Import domain types from `index.js` only; the entry-point lint rule refuses any other path.
- Produces:
  ```ts
  export interface ReadResult {
    rows: ClientRecord[];
    rejectedRows: RejectedWorkbookRow[];
  }
  export class WorkbookMappingError extends Error {}
  export function readWorkbookGrid(grid: unknown[][], profile: Profile): ReadResult;
  export function excelSerialToIsoDate(serial: number): string | undefined;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/workbook/read.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { excelSerialToIsoDate, readWorkbookGrid } from "../../src/workbook/read.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import { readFileSync } from "node:fs";

const PROFILE = loadProfile(
  JSON.parse(readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8")),
);

// headerRow in the example profile is 1, so the header is the first row of the
// grid and every row after it is data.
const HEADER = ["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"];

describe("readWorkbookGrid", () => {
  it("maps each row by profile field name, not by spreadsheet header", () => {
    const result = readWorkbookGrid([HEADER, ["CLIENTA", true, false, 45231]], PROFILE);

    expect(result.rejectedRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.client).toBe("CLIENTA");
    expect(result.rows[0]?.fields.monthlyTraining).toBe(true);
    expect(result.rows[0]?.fields.quarterlyPhishing).toBe(false);
  });

  it("skips a row whose client cell is blank, because trailing empty rows are normal", () => {
    const result = readWorkbookGrid([HEADER, ["CLIENTA", true, false, 45231], ["", "", "", ""]], PROFILE);

    expect(result.rows).toHaveLength(1);
    expect(result.rejectedRows).toEqual([]);
  });

  it("ignores columns the mapping does not name", () => {
    const result = readWorkbookGrid(
      [[...HEADER, "Notes"], ["CLIENTA", true, false, 45231, "ignore me"]],
      PROFILE,
    );

    expect(result.rows[0]?.fields.Notes).toBeUndefined();
  });

  it("puts effectiveFrom on its own field rather than into fields", () => {
    const result = readWorkbookGrid([HEADER, ["CLIENTA", true, false, 45231]], PROFILE);

    expect(result.rows[0]?.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.rows[0]?.fields.effectiveFrom).toBeUndefined();
  });

  it("accepts an effectiveFrom that is already an ISO date string", () => {
    const result = readWorkbookGrid([HEADER, ["CLIENTA", true, false, "2026-08-15"]], PROFILE);

    expect(result.rows[0]?.effectiveFrom).toBe("2026-08-15");
    expect(result.rejectedRows).toEqual([]);
  });
});

describe("excelSerialToIsoDate", () => {
  it("converts the serial that is the Unix epoch", () => {
    // 25569 is the Excel serial for 1970-01-01, which is the anchor the
    // conversion is written around.
    expect(excelSerialToIsoDate(25569)).toBe("1970-01-01");
  });

  it("converts a modern serial", () => {
    expect(excelSerialToIsoDate(25570)).toBe("1970-01-02");
  });

  it("refuses a serial in Excel's 1900 range, where its phantom leap day makes the mapping ambiguous", () => {
    expect(excelSerialToIsoDate(59)).toBeUndefined();
    expect(excelSerialToIsoDate(60)).toBeUndefined();
  });
});
```

Create `tests/workbook/read.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readWorkbookGrid, WorkbookMappingError } from "../../src/workbook/read.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import { readFileSync } from "node:fs";

const PROFILE = loadProfile(
  JSON.parse(readFileSync(new URL("../../examples/profiles/example.json", import.meta.url), "utf8")),
);

const HEADER = ["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"];

describe("readWorkbookGrid failures", () => {
  it("fails the whole read when a mapped header is absent, because every row would be wrong", () => {
    const call = (): unknown => readWorkbookGrid([["Client", "Monthly Training"], ["CLIENTA", true]], PROFILE);

    expect(call).toThrow(WorkbookMappingError);
    expect(call).toThrow(/Quarterly Phishing/);
    expect(call).toThrow(/workbookMapping/);
  });

  it("names every missing header at once rather than one per run", () => {
    const call = (): unknown => readWorkbookGrid([["Client"], ["CLIENTA"]], PROFILE);

    expect(call).toThrow(/Monthly Training/);
    expect(call).toThrow(/Quarterly Phishing/);
  });

  it("fails the whole read when the grid has no header row at all", () => {
    expect(() => readWorkbookGrid([], PROFILE)).toThrow(WorkbookMappingError);
  });

  it("rejects one row for a malformed effectiveFrom and keeps the rest", () => {
    const result = readWorkbookGrid(
      [HEADER, ["CLIENTA", true, false, 45231], ["CLIENTB", true, false, "15/08/2026"]],
      PROFILE,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.client).toBe("CLIENTA");
    expect(result.rejectedRows).toHaveLength(1);
    expect(result.rejectedRows[0]?.client).toBe("CLIENTB");
    expect(result.rejectedRows[0]?.reason).toMatch(/15\/08\/2026/);
  });

  it("numbers a rejected row as the sheet numbers it, so an operator can find the cell", () => {
    const result = readWorkbookGrid(
      [HEADER, ["CLIENTA", true, false, 45231], ["CLIENTB", true, false, "nonsense"]],
      PROFILE,
    );

    // headerRow 1, one good row, so the bad one is sheet row 3.
    expect(result.rejectedRows[0]?.row).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/workbook/`
Expected: FAIL, cannot resolve `../../src/workbook/read.js`.

- [ ] **Step 3: Implement the reader**

```ts
// src/workbook/read.ts
import type { Profile } from "../domain/profile/schema.js";
import type { ClientRecord, RejectedWorkbookRow } from "../domain/reconcile/index.js";

/**
 * A mapping failure, not a data failure. The distinction is the load-bearing
 * rule of this module: a header the mapping names and the sheet does not have
 * makes every row wrong, so reporting fifty rejected rows would bury the real
 * cause, which is that the mapping is stale against a renamed column.
 */
export class WorkbookMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookMappingError";
  }
}

export interface ReadResult {
  rows: ClientRecord[];
  rejectedRows: RejectedWorkbookRow[];
}

/**
 * 25569 is the Excel serial for 1970-01-01, so the conversion is anchored on the
 * Unix epoch rather than on Excel's own 1899 epoch. Serials below 61 are refused
 * rather than converted: Excel models a 29 February 1900 that never existed, so
 * that range maps ambiguously, and no effective date in a tracking workbook is
 * in 1900.
 */
const UNIX_EPOCH_EXCEL_SERIAL = 25569;
const MILLISECONDS_PER_DAY = 86_400_000;
const FIRST_UNAMBIGUOUS_SERIAL = 61;

export function excelSerialToIsoDate(serial: number): string | undefined {
  if (!Number.isFinite(serial) || serial < FIRST_UNAMBIGUOUS_SERIAL) return undefined;

  const date = new Date((serial - UNIX_EPOCH_EXCEL_SERIAL) * MILLISECONDS_PER_DAY);
  if (Number.isNaN(date.getTime())) return undefined;

  return date.toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cellToField(value: unknown): string | number | boolean | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return null;
}

export function readWorkbookGrid(grid: unknown[][], profile: Profile): ReadResult {
  const headerRowIndex = profile.workbookMapping.headerRow - 1;
  const header = grid[headerRowIndex];
  if (header === undefined) {
    throw new WorkbookMappingError(
      `The workbook range has no row ${profile.workbookMapping.headerRow}, which the profile's ` +
        "workbookMapping names as the header row. Either the mapping points at the wrong sheet or table, " +
        "or the range came back empty.",
    );
  }

  const headerIndexByText = new Map<string, number>();
  header.forEach((cell, index) => {
    if (typeof cell === "string" && cell.trim().length > 0) headerIndexByText.set(cell.trim(), index);
  });

  const columnIndexByField = new Map<string, number>();
  const missing: string[] = [];
  for (const [field, headerText] of Object.entries(profile.workbookMapping.columns)) {
    const index = headerIndexByText.get(headerText);
    if (index === undefined) missing.push(headerText);
    else columnIndexByField.set(field, index);
  }

  if (missing.length > 0) {
    // Every missing header at once. Reporting the first only costs an operator
    // one failed run per renamed column, and a mapping usually goes stale in
    // batches when someone tidies a spreadsheet.
    throw new WorkbookMappingError(
      `The workbook has no column headed ${missing.map((text) => `"${text}"`).join(", ")} on row ` +
        `${profile.workbookMapping.headerRow}. The profile's workbookMapping names ${missing.length === 1 ? "it" : "them"}, ` +
        "so either a column was renamed in the workbook or the mapping was written against a different sheet.",
    );
  }

  const clientIndex = columnIndexByField.get("client") as number;
  const rows: ClientRecord[] = [];
  const rejectedRows: RejectedWorkbookRow[] = [];

  for (let index = headerRowIndex + 1; index < grid.length; index += 1) {
    const sheetRow = index + 1;
    const cells = grid[index];
    if (cells === undefined) continue;

    const clientCell = cells[clientIndex];
    const client = typeof clientCell === "string" ? clientCell.trim() : "";
    // A blank client cell is a trailing empty row, which every spreadsheet has.
    // It is not an error and must not be reported as one, or a workbook with
    // whitespace below its table would report dozens of rejections.
    if (client.length === 0) continue;

    const fields: Record<string, string | number | boolean | null> = {};
    let effectiveFrom: string | undefined;
    let rejection: string | undefined;

    for (const [field, columnIndex] of columnIndexByField) {
      if (field === "client") continue;
      const cell = cells[columnIndex];

      if (field === "effectiveFrom") {
        if (cell === undefined || cell === null || cell === "") continue;
        if (typeof cell === "number") {
          const converted = excelSerialToIsoDate(cell);
          if (converted === undefined) rejection = `effectiveFrom was not a usable date: ${JSON.stringify(cell)}`;
          else effectiveFrom = converted;
        } else if (typeof cell === "string" && ISO_DATE.test(cell.trim())) {
          effectiveFrom = cell.trim();
        } else {
          rejection = `effectiveFrom was not a date: ${JSON.stringify(cell)}`;
        }
        continue;
      }

      fields[field] = cellToField(cell);
    }

    if (rejection !== undefined) {
      rejectedRows.push({ row: sheetRow, client, reason: rejection });
      continue;
    }

    rows.push(effectiveFrom === undefined ? { client, fields } : { client, fields, effectiveFrom });
  }

  return { rows, rejectedRows };
}
```

- [ ] **Step 4: Extend the purity fence**

In `eslint.config.js`, add `"**/workbook/**"` to the `PURITY_PATTERNS` group and update its message to name the new layer. `src/workbook/` is a new impure layer and nothing currently stops the domain importing it.

Then add cases to `tests/lint-guardrails.test.ts`. That file lints synthetic source text at real paths rather than files on disk, through two helpers it already defines, `ruleIdsFor(filePath, code)` and `messagesFor(filePath, code)`. Add a case asserting a domain file importing `../../workbook/read.js` trips `no-restricted-imports`, and one asserting the message names the workbook layer. Follow the shape of the existing purity cases.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/workbook/ tests/lint-guardrails.test.ts`
Expected: PASS.

If the `excelSerialToIsoDate` anchor tests fail, do not adjust the expectation. Work out what the conversion actually produces for serial 25569 and report it: the anchor is chosen because 1970-01-01 is unambiguous, so a failure there means the formula is wrong, not the test.

- [ ] **Step 6: Run everything, then commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add src/workbook tests/workbook eslint.config.js tests/lint-guardrails.test.ts
git commit -m "feat: read a workbook grid into records and rejections"
```

---

### Task 4: the Excel session and the range read

**Files:**
- Create: `src/graph/excel.ts`
- Test: `tests/graph/excel.test.ts`, `tests/graph/excel.errors.test.ts`

**Interfaces:**
- Consumes: `GraphClient` with `get` and `post` (Task 1), `GraphRequestError` from `src/graph/errors.js`, `driveItemPath` from `src/graph/paths.js`.
- Produces:
  ```ts
  export interface WorkbookRange { values: unknown[][] }
  export async function readWorkbookRange(
    client: GraphClient,
    args: { driveId: string; workbookPath: string; source: { kind: "table" | "worksheet"; name: string } },
  ): Promise<unknown[][]>;
  ```
  It opens a session, reads, and closes it, so callers never see a session id.

- [ ] **Step 1: Write the failing tests**

Create `tests/graph/excel.test.ts`. Build a fake `GraphClient` recording every call as `method:path:sessionHeader`:

```ts
  it("opens a non-persistent session, reads a table's range, and closes it", async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, {
      post: { "/workbook/createSession": { id: "s-1" } },
      get: { "/workbook/tables/ClientRoster/range": { values: [["Client"], ["CLIENTA"]] } },
    });

    const values = await readWorkbookRange(client, {
      driveId: "d1",
      workbookPath: "/Trackers/Tracker.xlsx",
      source: { kind: "table", name: "ClientRoster" },
    });

    expect(values).toEqual([["Client"], ["CLIENTA"]]);
    expect(calls[0]).toContain("createSession");
    expect(calls[calls.length - 1]).toContain("closeSession");
  });

  it("sends persistChanges false, so the session cannot commit a change to the workbook", async () => {
    const bodies: unknown[] = [];
    // assert the createSession body is exactly { persistChanges: false }
  });

  it("carries the session id on the read and on the close", async () => {
    // assert both the range GET and the closeSession POST saw workbook-session-id: s-1
  });

  it("reads a worksheet's used range when the mapping names a worksheet", async () => {
    // assert the path contains /worksheets/Sheet1/usedRange
  });
```

Write those four out fully, following the fake-client convention in `tests/graph/drive.test.ts`.

Create `tests/graph/excel.errors.test.ts`:

```ts
  it("recreates an expired session once and retries the read", async () => {
    // First range GET throws GraphRequestError 404. Assert a second createSession
    // was posted, the read was retried, and the returned values are the retry's.
  });

  it("gives up when the read fails a second time on a fresh session", async () => {
    // Assert the error propagates rather than looping.
  });

  it("closes the session even when the read fails", async () => {
    // A leaked session holds a lock on the workbook until it expires, so the
    // close has to happen on the failure path too.
  });

  it("does not fail the read when closing the session fails", async () => {
    // The values are already in hand. A failed close is untidy, not a failure
    // of the operation the caller asked for.
  });
```

Write those four out fully too.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/graph/excel.test.ts tests/graph/excel.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/graph/excel.js`.

- [ ] **Step 3: Implement**

The workbook is addressed by path using `driveItemPath(driveId, workbookPath)`. It returns the colon-terminated form, for example `/drives/d1/root:/Trackers/Tracker.xlsx:`, so the workbook segment appends directly with no separator of your own:

```ts
const itemPath = driveItemPath(driveId, workbookPath); // ends in ":"
const createUrl = `${itemPath}/workbook/createSession`;
```

The endpoints:

- create: `POST {itemPath}/workbook/createSession` with `{ persistChanges: false }`
- table: `GET {itemPath}/workbook/tables/{name}/range`
- worksheet: `GET {itemPath}/workbook/worksheets/{name}/usedRange`
- close: `POST {itemPath}/workbook/closeSession`

Encode the table or worksheet name with `encodeURIComponent`, for the same reason `paths.ts` encodes each segment: a `#` or `?` in a sheet name truncates the URL.

Structure it so the close runs on both paths, in a `finally`, and so a failure to close is swallowed with a comment saying why. The expired-session retry is one retry, not a loop: a second 404 on a fresh session is a real failure and must surface.

Write the comment on `persistChanges: false` explaining that it is what makes the read-only guarantee structural rather than conventional.

- [ ] **Step 4: Run to verify they pass, then everything, then commit**

```bash
npx vitest run tests/graph/
npm run lint && npm run typecheck && npm test && npm run build
git add src/graph/excel.ts tests/graph/excel.test.ts tests/graph/excel.errors.test.ts
git commit -m "feat: read a workbook range through a non-persistent Excel session"
```

---

### Task 5: composition

**Files:**
- Create: `src/scan/workbook.ts`
- Test: `tests/scan/workbook.test.ts`

**Interfaces:**
- Consumes: `resolveDrive` from `src/graph/drive.js`, `readWorkbookRange` from `src/graph/excel.js`, `readWorkbookGrid` from `src/workbook/read.js`, `WorkbookSnapshot` from `src/domain/reconcile/index.js`, `Profile` from `src/domain/profile/schema.js`.
- Produces:
  ```ts
  export async function readWorkbookSnapshot(
    client: GraphClient,
    profile: Profile,
  ): Promise<WorkbookSnapshot>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
  it("resolves the drive, reads the range, and assembles a snapshot whose source names the workbook", async () => {
    const client = scriptedClient({
      "/sites/contoso.sharepoint.com:/sites/Example": { id: "site-1" },
      "/sites/site-1/drives?$select=id,name": { value: [{ id: "drive-1", name: "Compliance Reports" }] },
      // plus the createSession, range and closeSession responses
    });

    const snapshot = await readWorkbookSnapshot(client, PROFILE);

    expect(snapshot.source).toContain("Operational Tracking Workbook.xlsx");
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rejectedRows).toEqual([]);
  });

  it("carries the reader's rejections onto the snapshot", async () => {
    // one good row, one with a malformed effectiveFrom; assert rows 1, rejectedRows 1
  });
```

Write both out fully, following the scripted-client convention in `tests/scan/run.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/scan/workbook.test.ts`
Expected: FAIL, cannot resolve `../../src/scan/workbook.js`.

- [ ] **Step 3: Implement**

Resolve the drive from `profile.identity.siteUrl` and `profile.identity.library`, exactly as the repository scan does. Read the range. Run it through `readWorkbookGrid`. Assemble:

```ts
  return {
    rows: result.rows,
    rejectedRows: result.rejectedRows,
    source: `${profile.identity.workbookPath} in ${profile.identity.library}`,
  };
```

`source` is the report's provenance for where the expected state came from, so it names the workbook and its library rather than an opaque id.

- [ ] **Step 4: Run to verify it passes, then everything, then commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add src/scan/workbook.ts tests/scan/workbook.test.ts
git commit -m "feat: assemble a workbook snapshot from a profile"
```

---

### Task 6: the amendments

Four documents disagree with what this branch built. Until they are corrected, the next session reading them builds the wrong thing.

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-09-11-repository-reconciliation-mcp-design.md`, `docs/OPEN-ITEMS.md`

**Interfaces:**
- Consumes: the finished work.
- Produces: nothing in code.

- [ ] **Step 1: Amend the Decision Record**

`CLAUDE.md`'s Decision Record says "Excel as a database. Persistent workbook sessions, the session header on every call, explicit detection and recreation of expired sessions, and a sequential single-flight queue per workbook."

Two of those four are now wrong. Rewrite it to say sessions are non-persistent, because `persistChanges` is what makes a session write-capable and this server only reads a document the spec calls the customer's live operational authority. And say the single-flight queue is deferred, because it assumes a long-lived process holding sessions while this server builds a fresh one per request, so there is nothing to serialize. Keep the session header and the expired-session recreation, which are unchanged and correct. Date the amendment 2026-09-14.

- [ ] **Step 2: Amend the parent spec**

In the `graph-lib` paragraph, correct the same two claims the same way.

In the phase list, split phase 2b: the workbook snapshot is this work, the Microsoft Search cross-check is its own slice, and `$batch` moves to phase 6 where the write tools are its first caller.

- [ ] **Step 3: Close the bad-row question**

`docs/OPEN-ITEMS.md` has a section asking whether one bad workbook row should abort the whole reconciliation. Close it following that file's convention, a bold status line at the top with the original entry preserved below. The answer: it does not. The row is rejected, the rejection travels on the snapshot and onto the report, and it is visible where an operator reads results rather than only in a log.

- [ ] **Step 4: Record what is unverified**

Add to `docs/OPEN-ITEMS.md`, in the same terms the phase 2a entry uses: none of this has been run against a tenant, no Excel call has been made by this code, and the live verification needs a synthetic tracking workbook placed in the site alongside the synthetic library the seeder builds.

Do not write that anything was verified. Nothing in this branch will have been.

- [ ] **Step 5: Verify and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add CLAUDE.md docs
git commit -m "docs: amend the Excel decisions and close the bad-row question"
```

---

## Finishing the branch

After Task 6, use `superpowers:requesting-code-review` for a whole-branch review, then `superpowers:finishing-a-development-branch`.

Two things the review should weigh that no single task can see. Whether Task 1's client change altered behavior for any existing caller, since every Graph call in the project goes through it. And whether the reader's two failure kinds, a mapping error that fails everything and a cell error that rejects one row, are drawn in the right place once the whole path from Graph to report is visible.
