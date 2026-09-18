# Phase 4c describe_workbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `describe_workbook`, the last read tool, so a human can write a `workbookMapping` from observed evidence rather than by opening the file and counting columns.

**Architecture:** One tool with two modes over the existing xlsx bytes reader. A new pure introspection module enumerates a workbook's sheets and tables; a new pure module detects a header row and describes columns; the tool layer composes them in the same `run`/`shape`/`text`/`output` shape the three tools wired in phase 4b use. Server config gains the granted site, which is what lets the tool drop a `siteUrl` input the permission model cannot honor.

**Tech Stack:** TypeScript, Node 22, Zod 3.25, `@modelcontextprotocol/sdk`, Vitest.

**Binding spec:** `docs/superpowers/specs/2026-09-18-describe-workbook-design.md`, which carries two amendments made while this plan was written. Where this plan and that spec disagree, the spec wins.

## Global Constraints

- No emojis or icons anywhere, including logs, tests and docs. US English throughout.
- No em dashes or en dashes anywhere in the repo, including inside string literals. A test enforces this across tracked TypeScript, JavaScript, JSON, Markdown and YAML.
- Comments explain why, not what.
- The domain and workbook layers are pure. No I/O.
- A function that cannot observe an outcome must not assert it. This applies to tests: a test that cannot observe a thing must not assert it.
- Totals are computed over the complete set before truncation and reported exactly. A truncated listing always states how many items were omitted and, when a narrowing lever exists, names it.
- Every operator-facing sentence is asserted in tests against its WHOLE sentence, with fixture figures pairwise distinct so a transposition between any two fails.
- A top-level Zod refinement on a tool input schema is banned by contract test. If a cross-field constraint is needed, enforce it in the handler's own parse and state it in `inputConstraints` and the description.
- Every tool output carries `graphRequests`. Failures map through `describeToolFailure` with this tool's own name.
- Caps as named constants exported from the module that applies each: `MAX_SHEETS_LISTED = 200`, `MAX_TABLES_LISTED = 200`, `MAX_COLUMNS_DESCRIBED = 100`, `MAX_COLUMN_SAMPLES = 5`, `HEADER_SCAN_ROWS = 20`.
- Nothing claims live tenant verification until the sitting has run.
- Gates before every commit: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`.

---

## File Structure

**Created**

- `src/workbook/introspect.ts`, pure enumeration of a workbook's sheets and tables
- `src/workbook/describe.ts`, pure header detection and column description over a grid
- `src/tools/describe/{run,shape,text,output}.ts`
- Tests mirroring each

**Modified**

- `src/config.ts`, the granted site
- `src/server/main.ts`, passing it through
- `src/profiles/registry.ts`, the startup site check
- `src/workbook/xlsx.ts`, exporting helpers rather than duplicating them
- `src/workbook/sheet.ts`, `columnIndexToLabel`
- `src/tools/definitions/describe-workbook.ts`

---

### Task 1: The granted site becomes server configuration

**Files:**
- Modify: `src/config.ts`
- Modify: `src/server/main.ts`
- Modify: `src/profiles/registry.ts`
- Test: `tests/config.test.ts`, `tests/config.errors.test.ts`, `tests/profiles/registry.test.ts`

**Interfaces:**
- Produces: `loadGrantedSiteUrl(env: NodeJS.ProcessEnv): string`, and `createProfileRegistry` gaining a required `grantedSiteUrl` argument. Task 5 consumes the config value; nothing else does.

- [ ] **Step 1: Write the failing tests**

In `tests/config.test.ts`:

```typescript
it("reads the granted site from IW_SITE_URL", () => {
  expect(loadGrantedSiteUrl({ IW_SITE_URL: "https://contoso.sharepoint.com/sites/Ops" })).toBe(
    "https://contoso.sharepoint.com/sites/Ops",
  );
});

it("refuses a missing granted site by naming the variable and where it comes from", () => {
  expect(() => loadGrantedSiteUrl({})).toThrow(/IW_SITE_URL/);
  expect(() => loadGrantedSiteUrl({})).toThrow(/npm run setup/);
});
```

In `tests/profiles/registry.test.ts`:

```typescript
it("refuses a profile whose site disagrees with the granted site", () => {
  const profile = { ...validProfile, identity: { ...validProfile.identity, siteUrl: "https://contoso.sharepoint.com/sites/Other" } };

  expect(() => createProfileRegistry([profile], "https://contoso.sharepoint.com/sites/Ops")).toThrow(
    /"example".*sites\/Other.*sites\/Ops/s,
  );
});

it("accepts a profile whose site matches, ignoring a trailing slash", () => {
  const profile = { ...validProfile, identity: { ...validProfile.identity, siteUrl: "https://contoso.sharepoint.com/sites/Ops/" } };

  expect(() => createProfileRegistry([profile], "https://contoso.sharepoint.com/sites/Ops")).not.toThrow();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/config.test.ts tests/profiles/registry.test.ts`
Expected: FAIL, `loadGrantedSiteUrl` is not exported and the registry takes one argument.

- [ ] **Step 3: Add the loader**

In `src/config.ts`, beside `loadGraphCredentials`:

```typescript
/**
 * Required rather than optional, and required for more than this tool. A
 * server that does not know which site its Sites.Selected grant covers cannot
 * check a profile against it, so a profile pointed at the wrong site fails as
 * a 403 on its first Graph call, which is the misleading failure the setup
 * command was already corrected for once.
 */
export function loadGrantedSiteUrl(env: NodeJS.ProcessEnv): string {
  const value = env.IW_SITE_URL;
  if (!present(value)) {
    throw new Error(
      "Missing required environment variable: IW_SITE_URL. This is the site the server's Sites.Selected " +
        "grant covers, and npm run setup takes it as --site. The server cannot validate a profile, or " +
        "answer which site it can reach, without it.",
    );
  }
  return value;
}
```

- [ ] **Step 4: Check profiles against it**

In `src/profiles/registry.ts`, take the granted site and compare per profile. Normalize by trimming one trailing slash and lowercasing, because a site URL is case insensitive in practice and an operator pasting from a browser often carries the slash:

```typescript
function sameSite(a: string, b: string): boolean {
  const normalize = (value: string): string => value.trim().replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}
```

A mismatch throws at construction, naming the profile id, the site the profile asks for and the site the grant covers. Startup already fails loudly on an invalid profile, so this joins that path rather than adding a new one.

- [ ] **Step 5: Thread it through main**

`src/server/main.ts` calls `loadGrantedSiteUrl(process.env)` alongside the credentials it already loads and passes the value to the registry. The startup line it already prints gains the site, because an operator reading one line should be able to tell which tenant and site this process serves.

- [ ] **Step 6: Run the suite and commit**

Run: `npm run lint && npm run typecheck && npm run build && npm test`

```bash
git add src/config.ts src/server/main.ts src/profiles/registry.ts tests/config.test.ts tests/config.errors.test.ts tests/profiles/registry.test.ts
git commit -m "feat(config): require the granted site and check profiles against it"
```

---

### Task 2: Enumerate a workbook's sheets and tables

**Files:**
- Create: `src/workbook/introspect.ts`
- Modify: `src/workbook/xlsx.ts`, exporting helpers
- Modify: `src/workbook/sheet.ts`, adding `columnIndexToLabel`
- Test: `tests/workbook/introspect.test.ts`, `tests/workbook/sheet.test.ts`

**Interfaces:**
- Produces:

```typescript
export interface SheetSummary { name: string; usedRange?: string; rows: number; columns: number }
export interface TableSummary { name: string; sheet: string; ref: string; rows: number; columns: number; hasHeaderRow: boolean }
export interface WorkbookInventory { sheets: SheetSummary[]; tables: TableSummary[] }
export function readWorkbookInventory(bytes: Uint8Array): WorkbookInventory
```

Task 5 is its only consumer. `columnIndexToLabel(index: number): string` is consumed by Task 4.

- [ ] **Step 1: Write the failing test for the column label**

`tests/workbook/sheet.test.ts`:

```typescript
it("turns a one-based column index into its spreadsheet label", () => {
  expect(columnIndexToLabel(1)).toBe("A");
  expect(columnIndexToLabel(26)).toBe("Z");
  expect(columnIndexToLabel(27)).toBe("AA");
  expect(columnIndexToLabel(52)).toBe("AZ");
  expect(columnIndexToLabel(703)).toBe("AAA");
});

it("round trips against columnLabelToIndex", () => {
  for (const label of ["A", "Q", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]) {
    expect(columnIndexToLabel(columnLabelToIndex(label))).toBe(label);
  }
});
```

- [ ] **Step 2: Implement it**

```typescript
/**
 * The inverse of columnLabelToIndex, and tested as a round trip against it so
 * the two cannot drift. Spreadsheet columns are bijective base 26 rather than
 * ordinary base 26, which is why the index is decremented before each digit
 * instead of after.
 */
export function columnIndexToLabel(index: number): string {
  let remaining = index;
  let label = "";
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    label = String.fromCharCode(65 + digit) + label;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return label;
}
```

- [ ] **Step 3: Export what introspection needs instead of copying it**

`src/workbook/xlsx.ts` already holds `parseRelationships`, `resolveRelativeTarget`, `findTables`, `findOwningWorksheetPart`, `parseTableRange`, `requirePart` and the `SHEET_ENTRY_PATTERN`. Export them rather than writing a second copy in the new module. Two copies of the rule for resolving a relative part target is exactly the drift this project's shared-helper rule exists to prevent.

Add a doc comment on the export boundary saying these are exported for introspection and remain implementation detail of the workbook layer, not public API of the server.

- [ ] **Step 4: Write the failing introspection test**

`tests/workbook/introspect.test.ts`, against hand-built xlsx bytes using the same fixture helpers phase 2b-2 established:

```typescript
it("lists every worksheet with its used range and size", () => {
  const inventory = readWorkbookInventory(workbookWithTwoSheets());

  expect(inventory.sheets).toEqual([
    { name: "Tracking", usedRange: "A1:D12", rows: 12, columns: 4 },
    { name: "Notes", usedRange: "A1:A3", rows: 3, columns: 1 },
  ]);
});

it("lists every table with its owning sheet, bounds and whether it declares a header row", () => {
  const inventory = readWorkbookInventory(workbookWithTable());

  expect(inventory.tables).toEqual([
    { name: "ClientTable", sheet: "Tracking", ref: "A1:D12", rows: 12, columns: 4, hasHeaderRow: true },
  ]);
});

it("reports a table declaring no header row as such rather than assuming one", () => {
  expect(readWorkbookInventory(workbookWithHeaderlessTable()).tables[0]?.hasHeaderRow).toBe(false);
});

it("reports a sheet with no cells as empty rather than failing", () => {
  expect(readWorkbookInventory(workbookWithEmptySheet()).sheets[0]).toEqual({ name: "Blank", rows: 0, columns: 0 });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run tests/workbook/introspect.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 6: Implement the enumeration**

`src/workbook/introspect.ts` reads the same zip parts `parseWorkbookGrid` reads, then:

- Sheets: walk the `<sheets>` section of `xl/workbook.xml`, and for each entry resolve its relationship to a worksheet part. Read that part's `<dimension ref="...">` for the used range. `rows` and `columns` come from parsing that ref with the exported `parseTableRange`, which is a range parser rather than a table-specific one despite its name. A sheet part with no `<dimension>` reports no `usedRange` and zero size rather than guessing.
- Tables: `findTables` for name, ref and part; `findOwningWorksheetPart` for the part that holds it, mapped back to a sheet name through the `<sheets>` walk above; `hasHeaderRow` from the `headerRowCount` attribute on the table root, where absent means one, because that is the OOXML default.

It builds no grid for any sheet, which is what keeps inventory mode cheap on a workbook with many large sheets.

- [ ] **Step 7: Run the tests and commit**

Run: `npm run lint && npm run typecheck && npm test`

```bash
git add src/workbook/introspect.ts src/workbook/xlsx.ts src/workbook/sheet.ts tests/workbook/introspect.test.ts tests/workbook/sheet.test.ts
git commit -m "feat(workbook): enumerate a workbook's sheets and tables without building a grid"
```

---

### Task 3: Detect a header row

**Files:**
- Create: `src/workbook/describe.ts`
- Test: `tests/workbook/describe.header.test.ts`

**Interfaces:**
- Produces:

```typescript
export const HEADER_SCAN_ROWS = 20;
export interface HeaderCandidate { row: number; distinctLabels: number; reason: string }
export interface HeaderDetection { proposed?: number; candidates: HeaderCandidate[]; declinedReason?: string }
export function detectHeaderRow(grid: CellValue[][]): HeaderDetection
```

`row` is one based within the grid, which is what a profile's `headerRow` means. Task 4 consumes the proposed row; Task 5 reports the whole detection.

- [ ] **Step 1: Write the failing tests**

```typescript
it("proposes the single unambiguous header row", () => {
  const grid = [
    ["Client", "Owed", "Effective"],
    ["CLIENTA", 3, 45000],
    ["CLIENTB", 1, 45200],
  ];

  const detection = detectHeaderRow(grid);

  expect(detection.proposed).toBe(1);
  expect(detection.candidates).toHaveLength(1);
});

it("declines when two rows are equally plausible", () => {
  const grid = [
    ["Client", "Owed", "Effective"],
    ["Name", "Count", "Date"],
    ["CLIENTA", 3, 45000],
  ];

  const detection = detectHeaderRow(grid);

  expect(detection.proposed).toBeUndefined();
  expect(detection.candidates.map((candidate) => candidate.row)).toEqual([1, 2]);
  expect(detection.declinedReason).toContain("equally plausible");
});

it("does not treat a row of repeated text as a header", () => {
  const grid = [
    ["Open", "Open", "Open"],
    ["CLIENTA", 3, 45000],
  ];

  expect(detectHeaderRow([...grid]).proposed).toBeUndefined();
});

it("scans no further than HEADER_SCAN_ROWS", () => {
  const filler = Array.from({ length: HEADER_SCAN_ROWS }, () => [1, 2, 3]);
  const grid = [...filler, ["Client", "Owed", "Effective"]];

  expect(detectHeaderRow(grid).candidates).toHaveLength(0);
});

it("declines on an empty grid rather than proposing row 1", () => {
  expect(detectHeaderRow([]).proposed).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/workbook/describe.header.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the detection**

The rule, stated in the module's own doc comment because an operator may have to argue with its verdict:

A row is a candidate when it has at least two non-empty cells, every non-empty cell is a string, and those strings are all distinct from each other. Its score is the number of distinct labels. The detection proposes a candidate only when exactly one candidate has the highest score; on a tie it proposes none and sets `declinedReason`.

```typescript
export function detectHeaderRow(grid: CellValue[][]): HeaderDetection {
  const candidates: HeaderCandidate[] = [];

  for (let index = 0; index < Math.min(grid.length, HEADER_SCAN_ROWS); index += 1) {
    const row = grid[index] ?? [];
    const filled = row.filter((value) => value !== null && value !== "" && value !== UNEVALUABLE);
    const labels = filled.filter((value): value is string => typeof value === "string");
    const distinct = new Set(labels);

    if (filled.length < 2 || labels.length !== filled.length || distinct.size !== labels.length) continue;

    candidates.push({
      row: index + 1,
      distinctLabels: distinct.size,
      reason: `Every one of its ${String(filled.length)} filled cells is a distinct piece of text.`,
    });
  }

  const best = Math.max(0, ...candidates.map((candidate) => candidate.distinctLabels));
  const leaders = candidates.filter((candidate) => candidate.distinctLabels === best);

  if (leaders.length === 1) return { proposed: leaders[0]?.row, candidates };
  if (leaders.length === 0) return { candidates, declinedReason: "No row in the scanned range looks like a header." };
  return {
    candidates,
    declinedReason:
      `Rows ${leaders.map((candidate) => String(candidate.row)).join(" and ")} are equally plausible headers, ` +
      "so this tool proposes none. A header row chosen wrongly shifts every column by one and produces a " +
      "mapping that validates and reads the wrong data.",
  };
}
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/workbook/describe.header.test.ts && npm run lint`

```bash
git add src/workbook/describe.ts tests/workbook/describe.header.test.ts
git commit -m "feat(workbook): detect a header row, and decline when two are equally plausible"
```

---

### Task 4: Describe the columns of a range

**Files:**
- Modify: `src/workbook/describe.ts`
- Test: `tests/workbook/describe.columns.test.ts`

**Interfaces:**
- Consumes: `detectHeaderRow` from Task 3, `columnIndexToLabel` from Task 2.
- Produces:

```typescript
export const MAX_COLUMN_SAMPLES = 5;
export type InferredType = "string" | "number" | "boolean" | "mixed" | "empty";
export interface ColumnDescription {
  position: number;
  columnLabel: string;
  header?: string;
  headerUnevaluable: boolean;
  inferredType: InferredType;
  nonEmptyCount: number;
  unevaluableCount: number;
  distinctCount: number;
  samples: string[];
  samplesOmitted: number;
}
export function describeColumns(
  grid: CellValue[][],
  headerRow: number | undefined,
  firstColumn: number,
  options?: { samplesWithheld?: boolean; maxSamples?: number },
): ColumnDescription[]
```

`firstColumn` is the sheet-absolute column the grid's column 0 sits at: 1 for a worksheet, the table's own first column for a table. Task 5 supplies it.

- [ ] **Step 1: Write the failing tests**

```typescript
const grid = [
  ["Client", "Owed", "Active", "Notes"],
  ["CLIENTA", 3, true, null],
  ["CLIENTB", 1, false, null],
  ["CLIENTA", 2, true, null],
];

it("labels columns against the sheet, not the grid", () => {
  const described = describeColumns(grid, 1, 3, {});
  expect(described.map((column) => column.columnLabel)).toEqual(["C", "D", "E", "F"]);
});

it("reports the header verbatim and the type under it", () => {
  const described = describeColumns(grid, 1, 1, {});
  expect(described[0]).toMatchObject({ header: "Client", inferredType: "string", nonEmptyCount: 3, distinctCount: 2 });
  expect(described[1]).toMatchObject({ header: "Owed", inferredType: "number", distinctCount: 3 });
  expect(described[2]).toMatchObject({ header: "Active", inferredType: "boolean", distinctCount: 2 });
});

it("reports a column with no values as empty rather than as a type", () => {
  expect(describeColumns(grid, 1, 1, {})[3]).toMatchObject({ header: "Notes", inferredType: "empty", nonEmptyCount: 0 });
});

it("reports mixed types as mixed rather than picking the first", () => {
  const mixed = [["H"], ["a"], [2]];
  expect(describeColumns(mixed, 1, 1, {})[0]?.inferredType).toBe("mixed");
});

it("caps samples and says how many it left out", () => {
  const many = [["H"], ...Array.from({ length: 9 }, (_unused, index) => [`v${String(index)}`])];
  const described = describeColumns(many, 1, 1, { maxSamples: 4 });

  expect(described[0]?.samples).toHaveLength(4);
  expect(described[0]?.samplesOmitted).toBe(5);
  expect(described[0]?.distinctCount).toBe(9);
});

it("counts an unevaluable cell rather than treating it as blank", () => {
  const withUnevaluable = [["H"], ["a"], [UNEVALUABLE]];
  const described = describeColumns(withUnevaluable, 1, 1, {});

  expect(described[0]?.unevaluableCount).toBe(1);
  expect(described[0]?.nonEmptyCount).toBe(1);
  expect(described[0]?.samples).not.toContain("");
});

it("marks an unevaluable header rather than reporting no header", () => {
  const described = describeColumns([[UNEVALUABLE], ["a"]], 1, 1, {});
  expect(described[0]?.headerUnevaluable).toBe(true);
  expect(described[0]?.header).toBeUndefined();
});

it("returns no samples at all when they are withheld", () => {
  const described = describeColumns(grid, 1, 1, { samplesWithheld: true });
  expect(described.every((column) => column.samples.length === 0)).toBe(true);
  expect(described[0]?.distinctCount).toBe(2);
});

it("describes every column when there is no header row", () => {
  const described = describeColumns([["a", 1]], undefined, 1, {});
  expect(described).toHaveLength(2);
  expect(described[0]?.header).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/workbook/describe.columns.test.ts`
Expected: FAIL, `describeColumns` is not exported.

- [ ] **Step 3: Implement it**

Data rows are the rows below `headerRow`, or every row when it is undefined. Column count is the widest row in the grid, so a ragged grid does not lose a column that only some rows reach.

Type inference: over non-empty, evaluable values only. All strings gives `string`, all numbers `number`, all booleans `boolean`, none at all `empty`, anything else `mixed`. An unevaluable cell contributes to `unevaluableCount` and to neither the type nor the samples, because its value was never read.

Samples are distinct values rendered as strings, taken in first-seen order so they reflect the top of the column an operator will scroll to, capped at `maxSamples ?? MAX_COLUMN_SAMPLES`, with `samplesOmitted` computed against the distinct count before the cap.

`samplesWithheld` empties the samples and zeroes `samplesOmitted` while leaving every count intact, because the counts are structure and structure is not stale.

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/workbook/describe.columns.test.ts && npm run lint`

```bash
git add src/workbook/describe.ts tests/workbook/describe.columns.test.ts
git commit -m "feat(workbook): describe a range's columns, types and bounded samples"
```

---

### Task 5: Wire the tool

**Files:**
- Create: `src/tools/describe/{output,shape,text,run}.ts`
- Modify: `src/tools/definitions/describe-workbook.ts`
- Test: `tests/tools/describe/{shape,text,run,wire}.test.ts`

**Interfaces:**
- Consumes: `readWorkbookInventory` (Task 2), `detectHeaderRow` and `describeColumns` (Tasks 3 and 4), the granted site (Task 1), `downloadDriveItem` from `src/graph/content.ts`, `resolveDrive` from `src/graph/drive.ts`.
- Produces: `runDescribeWorkbook(input: unknown, context: ToolContext): Promise<CallToolResult>`.

`ToolContext` gains `grantedSiteUrl: string`, set once per process where the registry and clients are built.

- [ ] **Step 1: Rewrite the definition**

`src/tools/definitions/describe-workbook.ts`:

```typescript
  inputSchema: z.object({
    library: z
      .string()
      .min(1)
      .describe("Document library holding the workbook, for example \"Documents\"."),
    workbookPath: z
      .string()
      .min(1)
      .describe("Library-relative path to the workbook, for example \"Trackers/Operational Tracking Workbook.xlsx\"."),
    source: z
      .object({
        kind: z.enum(["table", "worksheet"]),
        name: z.string().min(1),
      })
      .optional()
      .describe(
        "Describe this one table or worksheet in full, for example {\"kind\":\"table\",\"name\":\"ClientTable\"}. " +
          "Omit to list what the workbook contains instead.",
      ),
  }),
```

The `siteUrl` input is removed. The description's first sentence becomes:

```
"Inspect a tracking workbook and report what it contains, so a profile's workbookMapping can be written from evidence. With no source argument it lists every worksheet and table with its bounds; with one it describes that range's header row and columns, including inferred types and a few sample values."
```

and it gains:

```
"It proposes a source and a header row only when those are unambiguous, and it never guesses which column is the client, because those field names are yours and this tool has not seen your deliverables."
```

The claim about named ranges is removed. A profile's source is a table or a worksheet, so describing a named range would advertise something no mapping can consume.

- [ ] **Step 2: Write the failing run tests**

`tests/tools/describe/run.test.ts`:

```typescript
it("lists what the workbook contains when no source is given", async () => {
  const result = await runDescribeWorkbook({ library: "Documents", workbookPath: "Trackers/Book.xlsx" }, context);

  const output = result.structuredContent as DescribeToolOutput;
  expect(output.mode).toBe("inventory");
  expect(output.sheets?.map((sheet) => sheet.name)).toEqual(["Tracking", "Notes"]);
  expect(output.columns).toBeUndefined();
});

it("describes one source when given", async () => {
  const result = await runDescribeWorkbook(
    { library: "Documents", workbookPath: "Trackers/Book.xlsx", source: { kind: "table", name: "ClientTable" } },
    context,
  );

  const output = result.structuredContent as DescribeToolOutput;
  expect(output.mode).toBe("source");
  expect(output.headerRow?.proposed).toBe(1);
  expect(output.columns?.[0]?.header).toBe("Client");
});

it("fails a source the workbook does not contain by listing what it does", async () => {
  const result = await runDescribeWorkbook(
    { library: "Documents", workbookPath: "Trackers/Book.xlsx", source: { kind: "table", name: "Nope" } },
    context,
  );

  expect(result.isError).toBe(true);
  const text = String(result.content?.[0]?.text);
  expect(text).toContain("Nope");
  expect(text).toContain("ClientTable");
});

it("withholds samples when the workbook says its formulas are stale", async () => {
  const result = await runDescribeWorkbook(
    { library: "Documents", workbookPath: "Trackers/Stale.xlsx", source: { kind: "worksheet", name: "Tracking" } },
    context,
  );

  const output = result.structuredContent as DescribeToolOutput;
  expect(output.samplesWithheld).toBe(true);
  expect(output.columns?.every((column) => column.samples.length === 0)).toBe(true);
});

it("reports the Graph cost it actually paid", async () => {
  const result = await runDescribeWorkbook({ library: "Documents", workbookPath: "Trackers/Book.xlsx" }, context);
  expect((result.structuredContent as DescribeToolOutput).graphRequests).toBe(context.graph.requests());
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/tools/describe/run.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Compose the run**

`src/tools/describe/run.ts` resolves the drive from `context.grantedSiteUrl` and the `library` argument, downloads the workbook with `downloadDriveItem`, then branches on `source`.

Inventory mode calls `readWorkbookInventory`. Source mode calls `parseWorkbookGrid`, except that the tool must not fail on `fullCalcOnLoad`. Introduce a sibling entry point in `src/workbook/xlsx.ts` that returns the grid, the row offset, the range's first column and both flags, and have `parseWorkbookGrid` call it and keep its own throw. The compliance path's behavior is unchanged; this tool takes the same resolution without the refusal, and sets `samplesWithheld` when the workbook is `fullCalcOnLoad` and the range held a formula.

The unknown-source failure must list what the workbook contains. `resolveTable` and `resolveWorksheet` already throw a `WorkbookMappingError` naming what was asked for; this tool catches that, calls `readWorkbookInventory` on bytes it already holds, and re-throws with the available names appended. That costs no extra Graph request, and it is what turns the most common operator mistake into a self-correcting one.

`catch` builds `{ tool: "describe_workbook", profileId: "", ... }`. Note that `FailureSubject` requires a `profileId` and this tool has none: add an optional-profile branch to `describeToolFailure` rather than passing an empty string, so no message ever names a profile that does not exist.

- [ ] **Step 5: Output, shape, text**

`output.ts` declares `MAX_SHEETS_LISTED`, `MAX_TABLES_LISTED`, `MAX_COLUMNS_DESCRIBED` and the schema, with the output type hand declared as the sibling tools do. `shape.ts` applies the caps with exact totals and per-list omitted counts. `text.ts` names the workbook and mode, states what was found, states the proposed source or header row or says plainly that it proposed none and why, states that the columns map is the reader's to write, and states the Graph cost. Its tests assert each sentence whole against pairwise-distinct figures.

- [ ] **Step 6: The wire test**

`tests/tools/describe/wire.test.ts` mirrors `tests/tools/inventory/wire.test.ts`: a real client over an in-memory transport, a successful call whose `structuredContent` is populated with at least one described column, asserting the SDK's output validation passes. This is the only guard against the hand-declared output type drifting from its schema.

- [ ] **Step 7: Run everything and commit**

Run: `npm run lint && npm run typecheck && npm run build && npm test`

```bash
git add src/tools/describe src/tools/definitions/describe-workbook.ts src/tools/context.ts src/tools/errors.ts src/workbook/xlsx.ts tests/tools/describe
git commit -m "feat(tools): wire describe_workbook over the granted site"
```

---

### Task 6: Record the phase

**Files:**
- Modify: `docs/OPEN-ITEMS.md`
- Modify: `docs/SETUP.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Record coverage and the required variable**

A section titled "Phase 4c: covered only by fakes, 2026-09-18" stating that no call in this phase has reached a tenant, what the unit tests cover, and the live checks the sitting must run, copied from the spec.

Record that `IW_SITE_URL` is now required server configuration and that **phase 5 hosting must set it**, because a deployment that does not will fail to start. `docs/SETUP.md` gains the same, next to where it already tells an operator what setup prints.

- [ ] **Step 2: Update the build sequence**

`CLAUDE.md` phase 4 becomes 4a, 4b and 4c, with all five read tools wired and phase 4 complete pending the live sitting. Do not claim live verification.

- [ ] **Step 3: Commit**

```bash
git add docs/OPEN-ITEMS.md docs/SETUP.md CLAUDE.md
git commit -m "docs: record phase 4c coverage and the newly required IW_SITE_URL"
```

---

## Self-Review

**Spec coverage.** The config change and profile check are Task 1. Inventory mode is Task 2. Header detection is Task 3, including the decline. Column description, types, counts, bounded samples and the unevaluable rules are Task 4. The two modes, the source argument shaped like `workbookMapping.source`, the removed `siteUrl`, the removed named-range claim, the self-correcting unknown-source failure, the withheld samples and the wire test are Task 5. Coverage and the phase 5 configuration warning are Task 6. The live sitting is the controller's to run before merge and is not a task here, because it needs a tenant.

**Placeholder scan.** Task 5's `shape.ts` and `text.ts` are described in prose rather than given in full. That is deliberate and bounded: the sibling tools in `src/tools/inventory/` and `src/tools/query/` are exact models, and the tests that pin the prose are specified by the sentences they must assert. Every other code step carries real code.

**Type consistency.** `columnIndexToLabel` is produced in Task 2 and consumed in Task 4. `HeaderDetection` is produced in Task 3 and consumed in Tasks 4 and 5. `ColumnDescription` is produced in Task 4 and consumed in Task 5. `readWorkbookInventory` is produced in Task 2 and consumed twice in Task 5, once for inventory mode and once for the unknown-source failure. `ToolContext.grantedSiteUrl` is added in Task 5 and fed by Task 1's loader.

**Two known frictions, stated rather than hidden.** `FailureSubject` requires a `profileId` and this is the first tool with none; Task 5 widens the mapper rather than passing an empty string, and a reviewer should check no message ever names a profile that does not exist. And `parseWorkbookGrid` throws on `fullCalcOnLoad`, which this tool must not; Task 5 extracts a sibling entry point rather than adding a flag to the compliance path, and a reviewer should confirm the compliance path's behavior is byte for byte unchanged.
