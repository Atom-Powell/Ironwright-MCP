# Synthetic Tracking Workbook Seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `npm run seed-library` a second half that creates the tracking workbook the profile points at and prints the report it expects the live reconciliation tool to return.

**Architecture:** One deterministic `SeedPlan` drives both halves. A pure module generates the bytes of an empty workbook, a Graph module uploads it and turns a range into a named table, and a third module assembles the two engine input snapshots from the same plan and runs the pure engine to predict the live report.

**Tech Stack:** TypeScript on Node 22 or later, `tsx` for execution, `vitest` for tests, plain `fetch` against Microsoft Graph, `node:zlib` for CRC32. No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-15-synthetic-workbook-seeding-design.md`. Read it before starting. It is binding where this plan and it disagree.

## Global Constraints

- No new runtime or dev dependency. Everything here uses Node built-ins and what is already in `package.json`.
- No emojis or icons anywhere, including logs, comments and commit messages. US English throughout.
- No em dashes and no en dashes anywhere, including inside string literals. A test enforces this across tracked TypeScript, JavaScript, JSON, Markdown and YAML.
- Comments explain why, not what.
- A function that cannot observe an outcome must not assert it. Every operator-facing message names only what the code actually saw.
- The domain layer stays pure. Scripts may import `reconcile` from `src/domain/reconcile/index.js` and `ProfileSchema` from `src/domain/profile/schema.js`, and must never import a stage module inside `src/domain/reconcile/`. The lint fence already enforces this for `scripts/**`.
- Nothing in this plan makes a live Graph call. Every test uses a fake `fetch`.
- Branch: `synthetic-workbook-seeding`, off `main`. Conventional commits.
- Gates before any task is called done: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/seed/blank-workbook.ts` (create) | Pure. The bytes of an empty single-sheet workbook, and the shared worksheet name. |
| `scripts/seed/rows.ts` (create) | Pure. The plan becomes the header row and the client rows, including the Excel date serial. |
| `scripts/seed/workbook.ts` (create) | The four-call Graph sequence that puts a populated, tabled workbook in the library. |
| `scripts/seed/expected.ts` (create) | Assembles both engine snapshots from the plan and runs `reconcile`. |
| `scripts/seed-library.ts` (modify) | Argument parsing, the `SeedPlan`, the tree, the printed report. Gains the month cap, the planted drift, byte bodies and PATCH on `send`, and the workbook step in `runSeed`. |
| `tests/scripts/seed/blank-workbook.test.ts` (create) | ZIP and part structure. |
| `tests/scripts/seed/rows.test.ts` (create) | Row shaping and the date serial round trip. |
| `tests/scripts/seed/workbook.test.ts` (create) | The Graph call sequence against a fake fetch. |
| `tests/scripts/seed/workbook.errors.test.ts` (create) | The three named failures. |
| `tests/scripts/seed/expected.test.ts` (create) | The predicted report over the planted plan. |
| `tests/scripts/seed-library.test.ts` (modify) | Month cap, planted drift, plan determinism, `runSeed` wiring. |
| `docs/OPEN-ITEMS.md` (modify) | The runbook loses its hand-built workbook step. |

---

### Task 1: The blank workbook bytes

**Files:**
- Create: `scripts/seed/blank-workbook.ts`
- Test: `tests/scripts/seed/blank-workbook.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const SHEET_NAME = "Sheet1"`, and `export function blankWorkbookBytes(): Uint8Array`.

Pure module. No imports from `src/` at all. An `.xlsx` is a ZIP of XML parts, and the Excel API cannot open a zero-byte file, so this builds the smallest package Graph will open. Entries are stored, not deflated: the parts total a few kilobytes, so compression would buy nothing but a second failure mode. The DOS timestamp is fixed rather than taken from the clock, so two runs produce identical bytes.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scripts/seed/blank-workbook.test.ts
import { describe, expect, it } from "vitest";
import { blankWorkbookBytes, SHEET_NAME } from "../../../scripts/seed/blank-workbook.js";

/** Reads the ZIP central directory: entry names, CRCs, and the stored sizes. */
function readCentralDirectory(bytes: Uint8Array): { name: string; crc: number; size: number; offset: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  expect(eocd).toBeGreaterThanOrEqual(0);

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries: { name: string; crc: number; size: number; offset: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.push({ name, crc, size, offset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("blankWorkbookBytes", () => {
  it("carries the six parts an openable single-sheet workbook needs", () => {
    const entries = readCentralDirectory(blankWorkbookBytes());
    expect(entries.map((entry) => entry.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
      "xl/styles.xml",
    ]);
  });

  it("names the worksheet with the constant both halves share", () => {
    const text = new TextDecoder().decode(blankWorkbookBytes());
    expect(text).toContain(`name="${SHEET_NAME}"`);
  });

  it("records a CRC for every entry that matches the bytes stored for it", () => {
    const bytes = blankWorkbookBytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const entry of readCentralDirectory(bytes)) {
      // Local header: 30 fixed bytes, then the name, then the extra field.
      const nameLength = view.getUint16(entry.offset + 26, true);
      const extraLength = view.getUint16(entry.offset + 28, true);
      const start = entry.offset + 30 + nameLength + extraLength;
      const stored = bytes.subarray(start, start + entry.size);
      // Recomputed here rather than trusted: a CRC copied from the same
      // variable that wrote it would agree with itself and prove nothing.
      expect(entry.crc >>> 0).toBe(crc32(stored) >>> 0);
    }
  });

  it("is byte-identical across calls, so a re-seed cannot produce a different file", () => {
    expect(blankWorkbookBytes()).toEqual(blankWorkbookBytes());
  });
});

function crc32(input: Uint8Array): number {
  // node:zlib's own crc32, the same primitive the implementation uses. This is
  // a deliberate reuse: the test is checking that the right bytes were hashed
  // into the right entry, not reimplementing CRC32.
  return zlibCrc32(input);
}
```

Add at the top of the test file: `import { crc32 as zlibCrc32 } from "node:zlib";`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scripts/seed/blank-workbook.test.ts`
Expected: FAIL, cannot resolve `../../../scripts/seed/blank-workbook.js`.

- [ ] **Step 3: Write the implementation**

```ts
// scripts/seed/blank-workbook.ts
/**
 * The bytes of an empty single-sheet workbook.
 *
 * Generated rather than committed as a binary so the artifact is reviewable in
 * a diff and testable, and so this repository stays text. The Excel API cannot
 * open a zero-byte file, and every call in scripts/seed/workbook.ts after the
 * upload requires Graph to open this as a workbook, so these bytes are the
 * precondition for all of it.
 *
 * Entries are stored rather than deflated: the parts total a few kilobytes, so
 * compression would buy nothing and add a second way to be wrong.
 */
import { crc32 } from "node:zlib";

/**
 * Shared by the blank workbook's own sheet element and by every range and
 * table call in scripts/seed/workbook.ts. One constant rather than a literal
 * in two places, because a disagreement between them would fail only against a
 * live tenant, where it costs a whole sitting to discover.
 */
export const SHEET_NAME = "Sheet1";

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const CONTENT_TYPES =
  `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  "</Types>";

const ROOT_RELS =
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>";

const WORKBOOK =
  `${XML_DECLARATION}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  `<sheets><sheet name="${SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS =
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  "</Relationships>";

const SHEET = `${XML_DECLARATION}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;

/**
 * A minimal style table. Five parts make a workbook that opens; this sixth
 * exists because the Onboarded column is written with a date number format,
 * and a workbook carrying no style table at all is the case most likely to
 * make that call fail for a reason this project does not own. Two fills
 * rather than one: the none/gray125 pair is what every Excel-written file
 * carries, and readers have been known to assume it.
 */
const STYLES =
  `${XML_DECLARATION}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  "</styleSheet>";

interface Part {
  name: string;
  bytes: Uint8Array;
}

function parts(): Part[] {
  const encoder = new TextEncoder();
  return [
    { name: "[Content_Types].xml", bytes: encoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", bytes: encoder.encode(ROOT_RELS) },
    { name: "xl/workbook.xml", bytes: encoder.encode(WORKBOOK) },
    { name: "xl/_rels/workbook.xml.rels", bytes: encoder.encode(WORKBOOK_RELS) },
    { name: "xl/worksheets/sheet1.xml", bytes: encoder.encode(SHEET) },
    { name: "xl/styles.xml", bytes: encoder.encode(STYLES) },
  ];
}

// 1980-01-01 00:00 in DOS format. Fixed rather than read from the clock so the
// same seed produces the same bytes: a workbook whose contents differ run to
// run cannot be compared against anything.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export function blankWorkbookBytes(): Uint8Array {
  const encoder = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const entries = parts();

  for (const part of entries) {
    const name = encoder.encode(part.name);
    const crc = crc32(part.bytes) >>> 0;
    const offset = local.length;

    local.push(
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(0), // method 0: stored
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(part.bytes.length), // compressed size equals uncompressed when stored
      ...u32(part.bytes.length),
      ...u16(name.length),
      ...u16(0), // extra field length
      ...name,
      ...part.bytes,
    );

    central.push(
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0),
      ...u16(0),
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(part.bytes.length),
      ...u32(part.bytes.length),
      ...u16(name.length),
      ...u16(0), // extra
      ...u16(0), // comment
      ...u16(0), // disk number
      ...u16(0), // internal attributes
      ...u32(0), // external attributes
      ...u32(offset),
      ...name,
    );
  }

  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(0), // archive comment length
  ];

  return Uint8Array.from([...local, ...central, ...end]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/seed/blank-workbook.test.ts`
Expected: PASS, four tests.

- [ ] **Step 5: Run the gates**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all clean, whole suite green.

- [ ] **Step 6: Commit**

```bash
git add scripts/seed/blank-workbook.ts tests/scripts/seed/blank-workbook.test.ts
git commit -m "feat(seed): generate the bytes of an empty workbook"
```

---

### Task 2: The month cap and the planted drift

**Files:**
- Modify: `scripts/seed-library.ts` (`SeedOptions`, `buildSeedTree`, and a new `buildSeedPlan`)
- Test: `tests/scripts/seed-library.test.ts`

**Interfaces:**
- Consumes: the existing `buildSeedTree`, `SeedProfileInput`, `substituteTokens`, `MONTH_NAMES`, `QUARTER_END_MONTHS`, `clientName`.
- Produces:

```ts
export interface SeedPlan {
  clients: string[];          // Client01..ClientNN, the tree's clients
  workbookClients: string[];  // the tree's clients plus ABSENT_CLIENT
  year: number;
  throughMonth: number;       // 1..12, the last month written
  includeQuarterly: boolean;
  tree: SeedTree;
}
export const ABSENT_CLIENT = "Client13";
export const MISSING_FILE_CLIENT = "Client04";
export const MISSING_FILE_MONTH = 1;
export const MISNAMED_FILE_CLIENT = "Client09";
export const MISNAMED_FILE_MONTH = 1;
export function buildSeedPlan(profile: SeedProfileInput, options: SeedOptions): SeedPlan;
```

`SeedOptions` gains `throughMonth: number`. `buildSeedTree` honors it and is otherwise unchanged.

Two things happen here. The tree stops at the current month when the seeded year is the current year, and three discrepancies are planted so the live report has one of each interesting kind in it. The planted set is fixed, not random, because the printed expectation has to stay true across a re-seed.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/scripts/seed-library.test.ts
import {
  ABSENT_CLIENT,
  buildSeedPlan,
  MISNAMED_FILE_CLIENT,
  MISNAMED_FILE_MONTH,
  MISSING_FILE_CLIENT,
  MISSING_FILE_MONTH,
  parseSeedArguments,
} from "../../scripts/seed-library.js";

describe("buildSeedPlan", () => {
  const options = { clientCount: 12, year: 2026, includeQuarterly: true, throughMonth: 9 };

  it("stops the tree at throughMonth", () => {
    const plan = buildSeedPlan(exampleProfile(), options);
    expect(plan.tree.filePaths.some((path) => path.includes("10-October"))).toBe(false);
    expect(plan.tree.filePaths.some((path) => path.includes("09-September"))).toBe(true);
  });

  it("writes no folder for the absent client but lists it in the workbook", () => {
    const plan = buildSeedPlan(exampleProfile(), options);
    expect(plan.clients).not.toContain(ABSENT_CLIENT);
    expect(plan.workbookClients).toContain(ABSENT_CLIENT);
    expect(plan.tree.folderPaths.some((path) => path.includes(ABSENT_CLIENT))).toBe(false);
  });

  it("omits exactly one monthly file, for the planted client and month", () => {
    const plan = buildSeedPlan(exampleProfile(), options);
    const omitted = `2026/${MISSING_FILE_CLIENT}/01-January/2026-01_${MISSING_FILE_CLIENT}_MonthlyTraining.xlsx`;
    expect(plan.tree.filePaths).not.toContain(omitted);
    // The folder still exists: a missing artifact and a missing client are
    // different findings, and this row is meant to produce the first.
    expect(plan.tree.folderPaths).toContain(`2026/${MISSING_FILE_CLIENT}/01-January`);
    expect(MISSING_FILE_MONTH).toBe(1);
  });

  it("writes the planted misnamed file in the vendor-token shape", () => {
    const plan = buildSeedPlan(exampleProfile(), options);
    const compliant = `2026/${MISNAMED_FILE_CLIENT}/01-January/2026-01_${MISNAMED_FILE_CLIENT}_MonthlyTraining.xlsx`;
    const misnamed = `2026/${MISNAMED_FILE_CLIENT}/01-January/2026-01_${MISNAMED_FILE_CLIENT}_VendorTraining.xlsx`;
    expect(plan.tree.filePaths).not.toContain(compliant);
    expect(plan.tree.filePaths).toContain(misnamed);
    expect(MISNAMED_FILE_MONTH).toBe(1);
  });

  it("is identical across two builds with the same arguments", () => {
    expect(buildSeedPlan(exampleProfile(), options)).toEqual(buildSeedPlan(exampleProfile(), options));
  });
});

describe("parseSeedArguments throughMonth", () => {
  it("caps at the current month when the seeded year is the current year", () => {
    const args = parseSeedArguments(["--profile=p.json"], { now: () => new Date("2026-09-15T00:00:00Z") });
    expect(args.year).toBe(2026);
    expect(args.throughMonth).toBe(9);
  });

  it("writes all twelve months for a past year", () => {
    const args = parseSeedArguments(["--profile=p.json", "--year=2025"], {
      now: () => new Date("2026-09-15T00:00:00Z"),
    });
    expect(args.throughMonth).toBe(12);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scripts/seed-library.test.ts`
Expected: FAIL, `buildSeedPlan` is not exported.

- [ ] **Step 3: Implement**

In `scripts/seed-library.ts`:

1. Add `throughMonth: number` to `SeedOptions`, and in `buildSeedTree` change the month loop bound from `month <= 12` to `month <= options.throughMonth`, with a guard that rejects a `throughMonth` outside 1 through 12 by name, in the same style as the existing `clientCount` guard.

2. Add to `parseSeedArguments`, where `year` is resolved:

```ts
// A deliverable for a month that has not happened yet is not a realistic
// synthetic library, and against a rolling window the engine reports each
// one as an unexpected orphan: with twelve clients seeded in September that
// is thirty-six findings burying the three this seed plants on purpose.
const currentYear = now.getUTCFullYear();
const throughMonth = year === currentYear ? now.getUTCMonth() + 1 : 12;
```

and carry `throughMonth` on `SeedArguments`.

3. Add the plan:

```ts
/**
 * The three planted discrepancies. Fixed rather than random, because the
 * expected report this seed prints has to stay true across a re-seed, and
 * because an operator comparing a live report against it needs to know which
 * findings were put there on purpose.
 */
export const ABSENT_CLIENT = "Client13";
export const MISSING_FILE_CLIENT = "Client04";
export const MISSING_FILE_MONTH = 1;
export const MISNAMED_FILE_CLIENT = "Client09";
export const MISNAMED_FILE_MONTH = 1;

// Corrected 2026-09-15. Both months were 7 and 3 in the original plan, which was
// a defect: throughMonth caps the tree at the current month, so the guard below
// would refuse the whole seed for any run from January through June. January is
// reachable for every throughMonth and is on or after the January 1 effective
// date, so the window still expects it. Leave this at 1.

/**
 * The misnamed file uses the example profile's vendor-token recognizer, not
 * its legacy-spaced one. legacy-spaced anchors its client capture on
 * [A-Z0-9]+, which cannot match "Client09", so a file in that shape would
 * land as an unrecognized orphan and exercise the recognizer path not at all.
 */
const MISNAMED_DELIVERABLE_TOKEN = "VendorTraining";

export interface SeedPlan {
  clients: string[];
  workbookClients: string[];
  year: number;
  throughMonth: number;
  includeQuarterly: boolean;
  tree: SeedTree;
}

export function buildSeedPlan(profile: SeedProfileInput, options: SeedOptions): SeedPlan {
  const base = buildSeedTree(profile, options);
  const clients: string[] = [];
  for (let index = 1; index <= options.clientCount; index += 1) clients.push(clientName(index));

  const year = String(options.year);
  if (MONTH_NAMES[MISSING_FILE_MONTH - 1] === undefined || MONTH_NAMES[MISNAMED_FILE_MONTH - 1] === undefined) {
    // Unreachable today: both constants are within 1..12 and MONTH_NAMES has
    // twelve entries. Checked anyway so a future edit to either constant fails
    // here rather than producing a path with "undefined" in it.
    throw new Error("Internal error: a planted month has no name in MONTH_NAMES.");
  }

  const monthlyToken = profile.deliverables.find((entry) => entry.cadence === "monthly")?.token;
  if (monthlyToken === undefined) {
    throw new Error(
      'The profile carries no deliverable with cadence "monthly", so this seed has no artifact to plant against.',
    );
  }

  const omitted = plantedPath(profile, year, MISSING_FILE_CLIENT, MISSING_FILE_MONTH, monthlyToken);
  const replacedFrom = plantedPath(profile, year, MISNAMED_FILE_CLIENT, MISNAMED_FILE_MONTH, monthlyToken);
  const replacedTo = plantedPath(profile, year, MISNAMED_FILE_CLIENT, MISNAMED_FILE_MONTH, MISNAMED_DELIVERABLE_TOKEN);

  const filePaths = base.filePaths
    .filter((path) => path !== omitted)
    .map((path) => (path === replacedFrom ? replacedTo : path));

  if (filePaths.length !== base.filePaths.length - 1) {
    // The planted paths are built from the same profile and tokens the tree
    // used, so a mismatch means the naming template changed underneath this
    // function. Refused rather than silently seeding a library whose planted
    // drift is not where the printed expectation says it is.
    throw new Error(
      `Planting expected to remove exactly one file at ${omitted}, but the tree does not contain that path. ` +
        "The profile's naming template and this seed's planted set have diverged.",
    );
  }

  return {
    clients,
    workbookClients: [...clients, ABSENT_CLIENT],
    year: options.year,
    throughMonth: options.throughMonth,
    includeQuarterly: options.includeQuarterly,
    tree: { folderPaths: base.folderPaths, filePaths },
  };
}

function plantedPath(
  profile: SeedProfileInput,
  year: string,
  client: string,
  month: number,
  deliverable: string,
): string {
  const monthNumber = String(month).padStart(2, "0");
  const monthName = MONTH_NAMES[month - 1] as string;
  const values = { year, client, monthNumber, monthName };
  let cursor = "";
  for (const segment of profile.taxonomy.segments) {
    const rendered = substituteTokens(segment, values);
    cursor = cursor === "" ? rendered : `${cursor}/${rendered}`;
  }
  return `${cursor}/${substituteTokens(profile.naming.template, { ...values, deliverable })}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/seed-library.test.ts`
Expected: PASS. Existing `buildSeedTree` tests will need `throughMonth: 12` added to their options objects; update them rather than defaulting the field, so every caller states its intent.

- [ ] **Step 5: Run the gates**

Run: `npm run lint && npm run typecheck && npm test`

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-library.ts tests/scripts/seed-library.test.ts
git commit -m "feat(seed): cap the tree at the current month and plant three discrepancies"
```

---

### Task 3: The workbook rows

**Files:**
- Create: `scripts/seed/rows.ts`
- Test: `tests/scripts/seed/rows.test.ts`

**Interfaces:**
- Consumes: `SeedPlan` from Task 2.
- Produces:

```ts
export const WORKBOOK_HEADERS = ["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"];
export function excelDateSerial(year: number, month: number, day: number): number;
export function workbookGrid(plan: SeedPlan): (string | number)[][];
export function rangeAddress(plan: SeedPlan): string;      // e.g. "A1:D14"
export function onboardedColumnAddress(plan: SeedPlan): string; // e.g. "D2:D14"
```

Pure. The headers match the example profile's `workbookMapping.columns` exactly. The deliverable cells are the string `Yes` rather than a boolean, because the engine's `isOwed` treats `no` and `false` as falsey and everything else as owed, and a hand-maintained tracker holds text. `Onboarded` is an Excel date serial, not text, because a real tracker's date column holds dates and `excelSerialToIsoDate` in `src/workbook/read.ts` exists to convert what a range read returns.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scripts/seed/rows.test.ts
import { describe, expect, it } from "vitest";
import { excelSerialToIsoDate } from "../../../src/workbook/read.js";
import { buildSeedPlan, ABSENT_CLIENT } from "../../../scripts/seed-library.js";
import {
  excelDateSerial,
  onboardedColumnAddress,
  rangeAddress,
  WORKBOOK_HEADERS,
  workbookGrid,
} from "../../../scripts/seed/rows.js";
import { exampleSeedProfile } from "./fixtures.js";

const options = { clientCount: 12, year: 2026, includeQuarterly: true, throughMonth: 9 };

describe("excelDateSerial", () => {
  it("produces the serial Excel uses for 2026-01-01", () => {
    expect(excelDateSerial(2026, 1, 1)).toBe(46023);
  });

  it("round-trips through the reader's own converter", () => {
    // The one assertion that matters: the seeder and the workbook reader must
    // agree about what a date cell means, and the reader is the side that will
    // see this value coming back out of Graph.
    expect(excelSerialToIsoDate(excelDateSerial(2026, 1, 1))).toBe("2026-01-01");
  });
});

describe("workbookGrid", () => {
  it("leads with the headers the example profile maps", () => {
    const grid = workbookGrid(buildSeedPlan(exampleSeedProfile(), options));
    expect(grid[0]).toEqual(WORKBOOK_HEADERS);
    expect(WORKBOOK_HEADERS).toEqual(["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"]);
  });

  it("carries one row per workbook client, the absent one included", () => {
    const plan = buildSeedPlan(exampleSeedProfile(), options);
    const grid = workbookGrid(plan);
    expect(grid).toHaveLength(plan.workbookClients.length + 1);
    expect(grid.map((row) => row[0])).toContain(ABSENT_CLIENT);
  });

  it("writes the deliverable columns as text the engine reads as owed", () => {
    const grid = workbookGrid(buildSeedPlan(exampleSeedProfile(), options));
    expect(grid[1]?.[1]).toBe("Yes");
    expect(grid[1]?.[2]).toBe("Yes");
  });

  it("onboards every client on January 1 of the seeded year", () => {
    const grid = workbookGrid(buildSeedPlan(exampleSeedProfile(), options));
    for (const row of grid.slice(1)) expect(row[3]).toBe(excelDateSerial(2026, 1, 1));
  });
});

describe("addresses", () => {
  it("covers the header row and every client row", () => {
    const plan = buildSeedPlan(exampleSeedProfile(), options);
    expect(rangeAddress(plan)).toBe("A1:D14");
    expect(onboardedColumnAddress(plan)).toBe("D2:D14");
  });
});
```

Create `tests/scripts/seed/fixtures.ts` exporting `exampleSeedProfile()`, a copy of the `exampleProfile()` helper already in `tests/scripts/seed-library.test.ts`, and change that test file to import it from the new module rather than keeping two copies.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scripts/seed/rows.test.ts`
Expected: FAIL, cannot resolve `scripts/seed/rows.js`.

- [ ] **Step 3: Implement**

```ts
// scripts/seed/rows.ts
/**
 * The workbook's contents, derived from the same SeedPlan the tree was built
 * from so the two sides of the reconciliation cannot drift apart.
 */
import type { SeedPlan } from "../seed-library.js";

/** Exactly the headers examples/profiles/example.json maps in workbookMapping.columns. */
export const WORKBOOK_HEADERS = ["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"];

/**
 * Excel counts days from 1899-12-30 rather than 1900-01-01, which absorbs the
 * 1900 leap year that Excel believes in and the calendar does not. Only dates
 * after 1900-03-01 are produced here, so that offset is the whole conversion.
 */
export function excelDateSerial(year: number, month: number, day: number): number {
  const epoch = Date.UTC(1899, 11, 30);
  return (Date.UTC(year, month - 1, day) - epoch) / 86_400_000;
}

/**
 * "Yes" rather than true. The engine's isOwed treats "no" and "false" as
 * falsey regardless of case and everything else as owed, which is a rule
 * written for hand-maintained trackers that record ownership as text. A
 * boolean cell would route around it.
 */
const OWED = "Yes";

export function workbookGrid(plan: SeedPlan): (string | number)[][] {
  // January 1 of the seeded year for every client. With respectEffectiveFrom
  // on, this excludes the months of the previous calendar year that the
  // rolling window reaches back into, and those months have no folders, so
  // without it every client would show a run of missing artifacts nobody
  // planted.
  const onboarded = excelDateSerial(plan.year, 1, 1);
  return [
    [...WORKBOOK_HEADERS],
    ...plan.workbookClients.map((client) => [client, OWED, OWED, onboarded]),
  ];
}

export function rangeAddress(plan: SeedPlan): string {
  return `A1:D${plan.workbookClients.length + 1}`;
}

export function onboardedColumnAddress(plan: SeedPlan): string {
  return `D2:D${plan.workbookClients.length + 1}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/seed/rows.test.ts`
Expected: PASS, seven tests.

- [ ] **Step 5: Run the gates**

Run: `npm run lint && npm run typecheck && npm test`

- [ ] **Step 6: Commit**

```bash
git add scripts/seed/rows.ts tests/scripts/seed/rows.test.ts tests/scripts/seed/fixtures.ts tests/scripts/seed-library.test.ts
git commit -m "feat(seed): shape the workbook grid from the seed plan"
```

---

### Task 4: The Graph sequence

**Files:**
- Modify: `scripts/seed-library.ts` (`send`, `SeedGraphClient`)
- Create: `scripts/seed/workbook.ts`
- Test: `tests/scripts/seed/workbook.test.ts`, `tests/scripts/seed/workbook.errors.test.ts`

**Interfaces:**
- Consumes: `blankWorkbookBytes`, `SHEET_NAME` (Task 1); `SeedPlan` (Task 2); `workbookGrid`, `rangeAddress`, `onboardedColumnAddress` (Task 3); `driveItemPath` from `src/graph/paths.js`; `GraphRequestError` from `src/graph/errors.js`.
- Produces: on `SeedGraphClient`, `putBytes(driveId, path, bytes, contentType): Promise<{ status: number }>` and `patch<T>(path, body): Promise<T>`; and `export async function createSeedWorkbook(client: SeedGraphClient, driveId: string, workbookPath: string, plan: SeedPlan): Promise<{ requests: number }>`.

Five calls after the parent folder exists, and the parent folder itself is a chain: every ancestor segment is created root to leaf, because Graph's children endpoint needs each parent to exist before a child can go in it, and `workbookPath` carries no depth limit.

Corrected 2026-09-15. This plan originally put the bad-bytes attribution on `tables/add`, calling it the first call that requires Graph to open the file as a workbook. It is not: every `/workbook/` call opens the file, so the first range write gets there first, and by the time `tables/add` runs the code has already observed two successful opens. The first range `PATCH` carries the bytes-are-the-suspect message, and `tables/add` says the opposite, naming the table request rather than the bytes.

None of this goes through `src/graph/excel.ts`. That module opens a non-persistent session and structurally cannot write, which is a locked decision: the server only ever reads a document that is the customer's live operational authority.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scripts/seed/workbook.test.ts
import { describe, expect, it } from "vitest";
import { buildSeedPlan, createSeedGraphClient } from "../../../scripts/seed-library.js";
import { createSeedWorkbook } from "../../../scripts/seed/workbook.js";
import { exampleSeedProfile } from "./fixtures.js";

interface Recorded {
  method: string;
  url: string;
  body: string;
}

function recordingClient(responder: (call: Recorded) => Response) {
  const calls: Recorded[] = [];
  const client = createSeedGraphClient({
    tokenProvider: { getToken: async () => "token" },
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = init?.body;
      const call = {
        method: init?.method ?? "GET",
        url: String(input),
        body: typeof body === "string" ? body : body === undefined ? "" : "<bytes>",
      };
      calls.push(call);
      return responder(call);
    }) as typeof fetch,
  });
  return { client, calls };
}

const plan = () => buildSeedPlan(exampleSeedProfile(), { clientCount: 12, year: 2026, includeQuarterly: true, throughMonth: 9 });

describe("createSeedWorkbook", () => {
  it("creates the parent folder, uploads, writes the range, adds and names the table, in that order", async () => {
    const { client, calls } = recordingClient((call) =>
      call.url.includes("/tables/add")
        ? new Response(JSON.stringify({ id: "{table-1}" }), { status: 201 })
        : new Response("{}", { status: 200 }),
    );

    await createSeedWorkbook(client, "drive-1", "/Trackers/Operational Tracking Workbook.xlsx", plan());

    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "PATCH", "PATCH", "POST", "PATCH"]);
    expect(calls[1]?.url).toContain("Operational%20Tracking%20Workbook.xlsx:/content");
    expect(calls[1]?.body).toBe("<bytes>");
    expect(calls[2]?.url).toContain(`worksheets('${"Sheet1"}')/range(address='A1:D14')`);
    expect(calls[3]?.url).toContain("range(address='D2:D14')");
    expect(calls[4]?.url).toContain("/workbook/tables/add");
    expect(JSON.parse(calls[4]?.body ?? "{}")).toMatchObject({ address: expect.stringContaining("A1:D14"), hasHeaders: true });
    expect(JSON.parse(calls[5]?.body ?? "{}")).toEqual({ name: "ClientRoster" });
  });

  it("sends the client rows in the range body", async () => {
    const { client, calls } = recordingClient((call) =>
      call.url.includes("/tables/add") ? new Response(JSON.stringify({ id: "t" }), { status: 201 }) : new Response("{}", { status: 200 }),
    );
    await createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan());
    const values = (JSON.parse(calls[2]?.body ?? "{}") as { values: unknown[][] }).values;
    expect(values[0]).toEqual(["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"]);
    expect(values).toHaveLength(14);
  });
});
```

```ts
// tests/scripts/seed/workbook.errors.test.ts
import { describe, expect, it } from "vitest";
import { buildSeedPlan, createSeedGraphClient } from "../../../scripts/seed-library.js";
import { createSeedWorkbook } from "../../../scripts/seed/workbook.js";
import { exampleSeedProfile } from "./fixtures.js";

const plan = () => buildSeedPlan(exampleSeedProfile(), { clientCount: 12, year: 2026, includeQuarterly: true, throughMonth: 9 });

function clientFailing(predicate: (url: string) => boolean, status: number, body: string) {
  return createSeedGraphClient({
    tokenProvider: { getToken: async () => "token" },
    fetchImpl: (async (input: Parameters<typeof fetch>[0]) =>
      predicate(String(input)) ? new Response(body, { status }) : new Response(JSON.stringify({ id: "t" }), { status: 200 })) as typeof fetch,
  });
}

describe("createSeedWorkbook failures", () => {
  it("names the upload when the upload is what failed", async () => {
    const client = clientFailing((url) => url.includes(":/content"), 403, '{"error":{"code":"accessDenied"}}');
    await expect(createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan())).rejects.toThrow(
      /Uploading the blank workbook to \/Trackers\/Book\.xlsx failed with 403/,
    );
  });

  it("names the workbook bytes as the suspect when tables/add is what failed", async () => {
    const client = clientFailing((url) => url.includes("/tables/add"), 400, '{"error":{"code":"invalidRequest"}}');
    await expect(createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan())).rejects.toThrow(
      /the bytes this script uploaded are the first thing to suspect/,
    );
  });

  it("says a table of that name already exists when Graph reports the conflict", async () => {
    const client = clientFailing((url) => url.includes("/tables/add"), 409, '{"error":{"code":"nameAlreadyExists"}}');
    await expect(createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan())).rejects.toThrow(
      /already carries a table named ClientRoster/,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scripts/seed/workbook.test.ts tests/scripts/seed/workbook.errors.test.ts`
Expected: FAIL, cannot resolve `scripts/seed/workbook.js`.

- [ ] **Step 3: Extend `send` and the client in `scripts/seed-library.ts`**

Change `send`'s body parameter to a union so bytes can be carried, and widen the method to include PATCH:

```ts
type SendBody = { text: string; contentType: string } | { bytes: Uint8Array; contentType: string };

async function send(path: string, method: string, body?: SendBody): Promise<RawGraphResponse> {
  const token = await options.tokenProvider.getToken();
  requestCount += 1;
  const response = await fetchImpl(`${GRAPH_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": body.contentType }),
    },
    // A workbook is binary, so its body cannot go through the text branch:
    // encoding those bytes as a UTF-8 string would corrupt every byte above
    // 0x7f and produce a file Graph refuses to open.
    ...(body === undefined ? {} : { body: "text" in body ? body.text : (body.bytes as BodyInit) }),
  });
  return { status: response.status, body: await response.text() };
}
```

Add to the `SeedGraphClient` interface and its returned object:

```ts
putBytes(driveId: string, path: string, bytes: Uint8Array, contentType: string): Promise<{ status: number }>;
patch<T>(path: string, body?: unknown): Promise<T>;
```

```ts
async putBytes(driveId, filePath, bytes, contentType) {
  const path = `${driveItemPath(driveId, filePath)}/content`;
  const response = await send(path, "PUT", { bytes, contentType });
  if (response.status < 200 || response.status >= 300) {
    throw new GraphRequestError({ method: "PUT", path, status: response.status, body: response.body });
  }
  return { status: response.status };
},

async patch<T>(path: string, body?: unknown): Promise<T> {
  const response = await send(path, "PATCH", body === undefined ? undefined : { text: JSON.stringify(body), contentType: "application/json" });
  if (response.status < 200 || response.status >= 300) {
    throw new GraphRequestError({ method: "PATCH", path, status: response.status, body: response.body });
  }
  if (response.body.length === 0) return undefined as T;
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new Error(
      `Graph PATCH ${path} returned ${response.status} with a body that is not JSON. Something other than ` +
        "Graph answered this request.",
    );
  }
},
```

- [ ] **Step 4: Write `scripts/seed/workbook.ts`**

```ts
/**
 * Puts a populated, tabled tracking workbook in the library.
 *
 * Deliberately does not use src/graph/excel.ts. That module opens a
 * non-persistent session and therefore structurally cannot write, which is a
 * locked decision: the server only ever reads a document the spec calls the
 * customer's live operational authority, and the read-only guarantee is meant
 * to be structural rather than a matter of nobody calling the wrong method.
 * This script writes, so it uses the seeder's own client.
 */
import { GraphRequestError } from "../../src/graph/errors.js";
import { driveItemPath } from "../../src/graph/paths.js";
import type { SeedGraphClient, SeedPlan } from "../seed-library.js";
import { blankWorkbookBytes, SHEET_NAME } from "./blank-workbook.js";
import { onboardedColumnAddress, rangeAddress, workbookGrid } from "./rows.js";

const TABLE_NAME = "ClientRoster";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DATE_NUMBER_FORMAT = "yyyy-mm-dd";

function splitWorkbookPath(workbookPath: string): { parentPath: string; libraryRelative: string } {
  const libraryRelative = workbookPath.replace(/^\/+/, "");
  const lastSlash = libraryRelative.lastIndexOf("/");
  return { parentPath: lastSlash === -1 ? "" : libraryRelative.slice(0, lastSlash), libraryRelative };
}

export async function createSeedWorkbook(
  client: SeedGraphClient,
  driveId: string,
  workbookPath: string,
  plan: SeedPlan,
): Promise<{ requests: number }> {
  const before = client.requests();
  const { parentPath, libraryRelative } = splitWorkbookPath(workbookPath);

  // The workbook's folder is not part of the taxonomy, so the tree writer
  // never creates it.
  if (parentPath !== "") {
    const lastSlash = parentPath.lastIndexOf("/");
    const grandparent = lastSlash === -1 ? "" : parentPath.slice(0, lastSlash);
    const name = lastSlash === -1 ? parentPath : parentPath.slice(lastSlash + 1);
    await client.createFolder(driveId, grandparent, name);
  }

  try {
    await client.putBytes(driveId, libraryRelative, blankWorkbookBytes(), XLSX_CONTENT_TYPE);
  } catch (error) {
    if (error instanceof GraphRequestError) {
      throw new Error(`Uploading the blank workbook to ${workbookPath} failed with ${error.status}.`);
    }
    throw error;
  }

  const item = driveItemPath(driveId, libraryRelative);
  const grid = workbookGrid(plan);
  await client.patch(`${item}/workbook/worksheets('${SHEET_NAME}')/range(address='${rangeAddress(plan)}')`, {
    values: grid,
  });
  await client.patch(`${item}/workbook/worksheets('${SHEET_NAME}')/range(address='${onboardedColumnAddress(plan)}')`, {
    numberFormat: grid.slice(1).map(() => [DATE_NUMBER_FORMAT]),
  });

  let table: { id: string };
  try {
    table = await client.post<{ id: string }>(`${item}/workbook/tables/add`, {
      address: `${SHEET_NAME}!${rangeAddress(plan)}`,
      hasHeaders: true,
    });
  } catch (error) {
    if (error instanceof GraphRequestError) {
      if (error.status === 409 && error.code === "nameAlreadyExists") {
        throw new Error(
          `${workbookPath} already carries a table named ${TABLE_NAME}. This seed replaces the file rather than ` +
            "updating it, so a table surviving the upload means the upload did not replace what was there.",
        );
      }
      // Stated as position, not as diagnosis: this is the first call that
      // requires Graph to open the file as a workbook, so a failure here
      // implicates the uploaded bytes more than anything after it. Which of
      // the two it actually was is not something this code observed.
      throw new Error(
        `Adding the ${TABLE_NAME} table to ${workbookPath} failed with ${error.status}. This is the first call ` +
          "that requires Graph to open the uploaded file as a workbook, so the bytes this script uploaded are " +
          "the first thing to suspect.",
      );
    }
    throw error;
  }

  await client.patch(`${item}/workbook/tables/${table.id}`, { name: TABLE_NAME });
  return { requests: client.requests() - before };
}
```

`GraphRequestError` already carries `status`, `body` and a parsed `code` as public readonly fields, so nothing in `src/graph/errors.ts` changes.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/seed/`
Expected: PASS.

- [ ] **Step 6: Run the gates**

Run: `npm run lint && npm run typecheck && npm test`

- [ ] **Step 7: Commit**

```bash
git add scripts/seed-library.ts scripts/seed/workbook.ts tests/scripts/seed/workbook.test.ts tests/scripts/seed/workbook.errors.test.ts
git commit -m "feat(seed): create the tracking workbook and its named table over Graph"
```

---

### Task 5: The expected report

**Files:**
- Create: `scripts/seed/expected.ts`
- Modify: `scripts/seed-library.ts` (the header comment)
- Test: `tests/scripts/seed/expected.test.ts`

**Interfaces:**
- Consumes: `SeedPlan` (Task 2), `workbookGrid` and `excelDateSerial` (Task 3), `reconcile` and the report types from `src/domain/reconcile/index.js`, `ProfileSchema` from `src/domain/profile/schema.js`.
- Produces: `export function expectedReport(rawProfile: unknown, plan: SeedPlan, asOf: Period): ReconciliationReport` and `export function formatExpectedReport(report: ReconciliationReport): string[]`.

The expectation is computed, not hand-written. Hand-computing it over a rolling window, an effective-date exclusion and a quarterly anchor would be its own defect surface, and a wrong expectation is worse than none because the operator would chase the tool instead of the note.

This asks the engine to predict itself, so it cannot catch an engine defect. What it catches is the live path returning something different from what was seeded, which is Graph, Excel, Azure Table Storage and the tool's composition. Say that in the printed output, so nobody reads a matching comparison as engine evidence.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scripts/seed/expected.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildSeedPlan, ABSENT_CLIENT, MISNAMED_FILE_CLIENT, MISSING_FILE_CLIENT } from "../../../scripts/seed-library.js";
import { expectedReport, formatExpectedReport } from "../../../scripts/seed/expected.js";
import { exampleSeedProfile } from "./fixtures.js";

const rawProfile = JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown;
const plan = buildSeedPlan(exampleSeedProfile(), { clientCount: 12, year: 2026, includeQuarterly: true, throughMonth: 9 });
const report = () => expectedReport(rawProfile, plan, { year: 2026, month: 9 });

describe("expectedReport", () => {
  it("reports every period the absent client owes as missing", () => {
    const missing = report().artifacts.filter((a) => a.client === ABSENT_CLIENT && a.state === "missing");
    expect(missing.length).toBeGreaterThan(0);
  });

  it("reports exactly one missing artifact for the planted client and month", () => {
    const missing = report().artifacts.filter((a) => a.client === MISSING_FILE_CLIENT && a.state === "missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.period).toEqual({ year: 2026, month: 1 });
  });

  it("reports the planted file as misnamed rather than unrecognized", () => {
    const misnamed = report().artifacts.filter((a) => a.client === MISNAMED_FILE_CLIENT && a.state === "misnamed");
    expect(misnamed).toHaveLength(1);
    expect(misnamed[0]?.period).toEqual({ year: 2026, month: 1 });
  });

  it("finds no orphans at all, which is what the month cap is for", () => {
    // Without the cap the tree carries files for months that have not
    // happened, and every one of them is an unexpected orphan burying the
    // three findings this seed plants on purpose.
    expect(report().orphans).toEqual([]);
  });

  it("refuses any client that is not planted to carry an exception", () => {
    const planted = new Set([ABSENT_CLIENT, MISSING_FILE_CLIENT, MISNAMED_FILE_CLIENT]);
    const surprises = report().artifacts.filter((a) => a.state !== "compliant" && !planted.has(a.client));
    expect(surprises).toEqual([]);
  });

  it("states in the printed output that this cannot prove the engine", () => {
    const lines = formatExpectedReport(report()).join("\n");
    expect(lines).toContain("cannot");
    expect(lines).toMatch(/engine/i);
  });
});
```

`ArtifactFinding` extends `Slot`, so `client`, `deliverable` and `period` are its own fields alongside `state`, `expectedPath`, `expectedName` and an optional `matched`. The names above are the real ones. `index.ts` re-exports every type in `types.ts`, so `Period`, `ReconciliationReport`, `RepositorySnapshot` and `WorkbookSnapshot` all come from the engine's entry point and nothing here reaches past it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scripts/seed/expected.test.ts`
Expected: FAIL, cannot resolve `scripts/seed/expected.js`.

- [ ] **Step 3: Implement**

```ts
// scripts/seed/expected.ts
/**
 * Predicts the report the live tool should return over what this seed just
 * wrote, by running the engine over in-memory snapshots of it.
 *
 * This asks the engine to predict itself, so the two sides agree by
 * construction on anything the engine gets wrong. It cannot be engine
 * evidence, and the printed output says so. What a mismatch catches is the
 * live path returning something different from what was seeded: Graph, Excel,
 * Azure Table Storage and the tool's composition, which is the set of layers
 * no fake can reach.
 */
import { ProfileSchema } from "../../src/domain/profile/schema.js";
import { reconcile } from "../../src/domain/reconcile/index.js";
import type {
  Period,
  ReconciliationReport,
  RepositorySnapshot,
  WorkbookSnapshot,
} from "../../src/domain/reconcile/index.js";
import type { SeedPlan } from "../seed-library.js";
import { excelDateSerial } from "./rows.js";

const SEED_TIMESTAMP = "2000-01-01T00:00:00.000Z";

function workbookSnapshot(plan: SeedPlan): WorkbookSnapshot {
  // Built from the plan rather than by reading back what was written: this is
  // the prediction, and a prediction that read the live workbook would be
  // asserting the thing it is supposed to be checking.
  const effectiveFrom = `${plan.year}-01-01`;
  return {
    rows: plan.workbookClients.map((client) => ({
      client,
      fields: { monthlyTraining: "Yes", quarterlyPhishing: "Yes", effectiveFrom: excelDateSerial(plan.year, 1, 1) },
      effectiveFrom,
    })),
    source: "seeded by npm run seed-library",
    rejectedRows: [],
  };
}

function repositorySnapshot(plan: SeedPlan): RepositorySnapshot {
  return {
    files: plan.tree.filePaths.map((path) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      size: 0,
      modified: SEED_TIMESTAMP,
      etag: "",
    })),
    folderPaths: [...plan.tree.folderPaths],
    scannedAt: SEED_TIMESTAMP,
    // The cross-check is phase 2c and has not been built, so the live scan
    // will carry false here too. Claiming true would make the prediction
    // differ from the run for a reason that has nothing to do with the seed.
    searchCrossCheckIncluded: false,
  };
}

export function expectedReport(rawProfile: unknown, plan: SeedPlan, asOf: Period): ReconciliationReport {
  const profile = ProfileSchema.parse(rawProfile);
  return reconcile(profile, workbookSnapshot(plan), repositorySnapshot(plan), asOf);
}

export function formatExpectedReport(report: ReconciliationReport): string[] {
  const exceptions = report.artifacts.filter((artifact) => artifact.state !== "compliant");
  return [
    "Expected report from the live reconciliation tool:",
    ...exceptions.map((artifact) => `  ${artifact.client}  ${artifact.period.year}-${String(artifact.period.month).padStart(2, "0")}  ${artifact.state}`),
    `  orphans: ${report.orphans.length}`,
    "",
    "Anything the live tool reports that is not listed above is a real finding.",
    "This expectation was computed by running the same engine the tool runs, so it cannot",
    "prove the engine is right. It checks the layers a fake cannot reach: Graph, Excel,",
    "Azure Table Storage, and the tool's own composition.",
  ];
}
```

- [ ] **Step 4: Rewrite the header comment in `scripts/seed-library.ts`**

The file opens by stating it deliberately imports nothing from `src/domain/`. That is now false. Replace that paragraph with:

```ts
/*
 * Imports two things from src/domain/, both through scripts/seed/expected.ts.
 * The reconciliation engine's front door, to predict the report this seed
 * should produce: that is what the front door is for, and the alternative is a
 * second implementation of the rolling window, the quarterly anchor and the
 * effective-date rule, which is the duplication the single-entry rule exists
 * to prevent. And the profile schema, because reconcile takes a validated
 * Profile while this script starts from raw JSON, so something has to parse
 * it, and a second hand-written validator would be the same duplication in a
 * different place.
 *
 * Corrected 2026-09-15: this paragraph originally said "exactly one thing" and
 * never mentioned the schema, which made the comment written to fix a false
 * comment false in the same way.
 *
 * The token substitution below is still a local reimplementation of just
 * enough of naming.template's placeholder syntax, not a second copy of the
 * domain's renderer, and that stays deliberate: a fixture generator is not a
 * legitimate consumer of the renderer the engine uses to decide compliance.
 */
```

A comment that is no longer true is the same defect class as a message that is no longer true, which is why this is a step and not a footnote.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/seed/expected.test.ts && npm run lint`
Expected: PASS, and lint clean, which is what confirms the engine import is inside the fence rather than around it.

- [ ] **Step 6: Run the gates**

Run: `npm run lint && npm run typecheck && npm test`

- [ ] **Step 7: Commit**

```bash
git add scripts/seed/expected.ts scripts/seed-library.ts tests/scripts/seed/expected.test.ts
git commit -m "feat(seed): predict the report the seeded library should produce"
```

---

### Task 6: Wire it into the command and the runbook

**Files:**
- Modify: `scripts/seed-library.ts` (`runSeed`, `formatDryRunReport`, `formatExecutionReport`, `estimateGraphRequests`)
- Modify: `docs/OPEN-ITEMS.md`
- Test: `tests/scripts/seed-library.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 through 5.
- Produces: no new exported types. `runSeed` calls `createSeedWorkbook` and prints `formatExpectedReport`.

A dry run must still issue no Graph call at all, which is an existing guarantee of this command and is what the `--confirm` branch protects.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/scripts/seed-library.test.ts
describe("runSeed with the workbook", () => {
  it("issues no Graph call at all without --confirm", async () => {
    let created = false;
    await runSeed(["--profile=examples/profiles/example.json"], {
      readProfileFile: async () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
      createGraphClient: () => {
        created = true;
        throw new Error("a dry run must not build a client");
      },
      now: () => new Date("2026-09-15T00:00:00Z"),
      log: () => {},
    });
    expect(created).toBe(false);
  });

  it("names the workbook it will create in the dry run report", async () => {
    const lines: string[] = [];
    await runSeed(["--profile=examples/profiles/example.json"], {
      readProfileFile: async () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
      createGraphClient: () => { throw new Error("not reached"); },
      now: () => new Date("2026-09-15T00:00:00Z"),
      log: (line) => lines.push(line),
    });
    expect(lines.join("\n")).toContain("Operational Tracking Workbook.xlsx");
  });

  it("prints the expected report after a confirmed run", async () => {
    const lines: string[] = [];
    await runSeed(["--profile=examples/profiles/example.json", "--confirm", "--clients=2"], {
      readProfileFile: async () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
      createGraphClient: () => fakeSeedClient(),
      now: () => new Date("2026-09-15T00:00:00Z"),
      log: (line) => lines.push(line),
    });
    expect(lines.join("\n")).toContain("Expected report from the live reconciliation tool");
  });
});
```

Write `fakeSeedClient()` in the same file: an object satisfying `SeedGraphClient` whose `get` returns the two responses `resolveDrive` needs, whose `createFolder`, `createFile` and `putBytes` return `{ status: 201 }`, whose `post` returns `{ id: "t" }`, whose `patch` returns `{}`, and whose `requests()` counts calls.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scripts/seed-library.test.ts`
Expected: FAIL on the last two, since `runSeed` neither mentions nor creates a workbook.

- [ ] **Step 3: Implement**

In `runSeed`, replace `buildSeedTree` with `buildSeedPlan`, pass `plan.tree` to `executeSeed`, then after it:

```ts
const workbook = await createSeedWorkbook(client, result.driveId, profile.identity.workbookPath, plan);
for (const line of formatExecutionReport({ ...result, workbookRequests: workbook.requests })) dependencies.log(line);
for (const line of formatExpectedReport(expectedReport(rawProfile, plan, asOfFromClock(dependencies.now())))) {
  dependencies.log(line);
}
```

`asOfFromClock` converts a `Date` to `{ year, month }` in UTC. `SeedProfileIdentity` gains `workbookPath: string`, validated by `loadSeedProfile` in the same hand-rolled style as the fields beside it, with a message naming the field. `SeedExecutionResult` gains `workbookRequests: number`, and `formatExecutionReport` prints it as its own line rather than folding it into the tree's count, because the count the tree reports is the number this script exists to let an operator measure and the workbook's calls are not part of it.

`estimateGraphRequests` gains the workbook's six calls, with a comment naming them, so the dry run's estimate stays honest.

`formatDryRunReport` gains a line naming `profile.identity.workbookPath` and saying the workbook is replaced rather than updated.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/seed-library.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the runbook**

In `docs/OPEN-ITEMS.md`, in the eight-step operator procedure under "Phase 2a: covered only by fakes, 2026-09-13", replace the hand-built library and workbook steps with the seeder, and add the comparison as its own step. Do not describe the comparison as proving the engine. In the "Phase 2b-1: covered only by fakes" section, strike the sentence saying live verification needs a workbook placed by hand.

- [ ] **Step 6: Run the gates**

Run: `npm run lint && npm run typecheck && npm run build && npm test`
Expected: all clean, whole suite green.

- [ ] **Step 7: Commit**

```bash
git add scripts/seed-library.ts tests/scripts/seed-library.test.ts docs/OPEN-ITEMS.md
git commit -m "feat(seed): seed the workbook and print the expected report"
```

---

## After the last task

Open a PR against `main`. The body states what is delivered, and states plainly that none of it has run against a tenant, that the expected report cannot be engine evidence, and that the sitting it serves also needs the tool PR #10 wires.
