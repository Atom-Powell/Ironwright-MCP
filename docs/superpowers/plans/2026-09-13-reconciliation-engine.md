# Reconciliation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure reconciliation engine: given a profile, a workbook snapshot and a repository snapshot, produce one report saying which expected deliverables exist, which are misnamed or misplaced, which are missing, and what else is in the repository.

**Architecture:** A new `src/domain/reconcile/` directory beside the existing `src/domain/profile/`. Five internal stages behind one exported function. No I/O, no Graph, no clock. Every input arrives as plain data, including the reference date, so the engine is deterministic and testable against fixtures with no tenant.

**Tech Stack:** Unchanged. TypeScript ESM, Zod already present for the profile, Vitest.

## Global Constraints

- Node `>=22.0.0`, TypeScript ESM, `NodeNext` resolution, `strict: true`. Relative imports carry a `.js` extension.
- **`src/domain/**` is pure.** No I/O, no Azure, no Graph, no Node built-ins beyond language features. An ESLint allowlist enforces this: the domain layer may import `zod` and its own siblings and nothing else. Do not attempt to widen it.
- **No clock access.** `Date.now()` and `new Date()` with no argument are forbidden in this directory. The reference date is an input. A pure function that reads the clock is not testable against a golden file, and the report must be reproducible.
- No emojis or icons anywhere. US English. Comments explain why, not what.
- Error-path test files are named `*.errors.test.ts`.
- Tests are type-checked through `tsconfig.test.json`.
- Baseline: 352 tests in 24 files, 120 error-path. Gate green.
- Diagnostic messages name a cause and an action, and must not assert an outcome the code cannot observe.

## A deliberate deviation from the usual plan format

Plans in this repository normally carry the complete code for every step. This one carries
complete tests and describes the implementations instead.

That is a judgment call, not an oversight. Phase 1 was largely transcription, where writing the
code into the plan cost nothing and removed ambiguity. This engine is algorithmic, and writing
it twice would produce two versions that drift, with the plan's copy being the one nobody runs.
The tests are the contract and they are exact; the prose says how to build it and, more
importantly, why each choice is that way.

Where a test is described rather than written out, the description names every case it must
cover. An implementer who writes fewer cases than the description names has not done the step.

## Context every task needs

Read `docs/superpowers/specs/2026-09-13-reconciliation-engine-design.md` first. It settles the boundary, the public surface, the report shape and the matching rules, and it is binding where anything disagrees.

`src/domain/profile/schema.ts` already exports `Profile` and its parts. A profile carries `taxonomy.segments` (ordered path templates), `naming.template` and `naming.recognizers` (each with `id`, `pattern`, `deliverable`, `verdict`), `deliverables` (each with `id`, `token`, `cadence`, `periodAnchor`, `appliesTo.workbookField`), `workbookMapping.columns`, and `window` (`mode: "rolling"`, `months`, `respectEffectiveFrom`).

`src/domain/profile/placeholders.ts` exports `PLACEHOLDERS`, the closed set of template tokens: `year`, `month`, `month:02`, `monthName`, `client`, `deliverable`. It validates them. It does not render them; that is Task 1.

---

### Task 1: Types, periods and rendering

**Files:**
- Create: `src/domain/reconcile/types.ts`, `src/domain/reconcile/period.ts`, `src/domain/reconcile/render.ts`
- Test: `tests/domain/reconcile/period.test.ts`, `tests/domain/reconcile/render.test.ts`, `tests/domain/reconcile/render.errors.test.ts`

**Interfaces:**
- Produces: every type in `types.ts` listed below. `periodsInWindow(args): Period[]`. `anchorPeriod(period, cadence, anchor): Period`. `renderTemplate(template, context): string`. `renderPath(segments, context): string`.

- [ ] **Step 1: Write `src/domain/reconcile/types.ts`**

No tests for a types file. Everything after this depends on it.

```ts
/** A single calendar month. Every cadence resolves to one of these before rendering. */
export interface Period {
  year: number;
  /** 1 through 12. */
  month: number;
}

export interface ClientRecord {
  client: string;
  /**
   * Other mapped columns, keyed by profile field name rather than spreadsheet
   * header, so a renamed column fails in the mapping where it can be explained
   * rather than reaching the engine.
   */
  fields: Record<string, string | number | boolean | null>;
  /** ISO date, present only when the profile maps an effectiveFrom column. */
  effectiveFrom?: string;
}

export interface WorkbookSnapshot {
  rows: ClientRecord[];
  /** Where the rows came from, for the report's provenance. */
  source: string;
}

export interface RepositoryFile {
  /** Library-relative, no leading slash. */
  path: string;
  name: string;
  size: number;
  modified: string;
  /** Captured now because a later rename or move plan needs it as an If-Match precondition. */
  etag: string;
}

export interface RepositorySnapshot {
  files: RepositoryFile[];
  folderPaths: string[];
  scannedAt: string;
  /**
   * False when the Microsoft Search cross-check did not run. Without it a
   * correctly named file outside the expected taxonomy is invisible, so every
   * misplaced finding is unreliable and every missing finding is suspect. The
   * report carries this so callers cannot present a partial scan as complete.
   */
  searchCrossCheckIncluded: boolean;
}

export type ArtifactState =
  | "compliant"
  | "misnamed"
  | "misplaced"
  | "misnamed_and_misplaced"
  | "missing";

export interface MatchedFile {
  path: string;
  name: string;
  etag: string;
  /** Present when the name matched a recognizer rather than the canonical template. */
  recognizerId?: string;
}

export interface Slot {
  client: string;
  deliverable: string;
  period: Period;
}

export interface ArtifactFinding extends Slot {
  expectedPath: string;
  expectedName: string;
  state: ArtifactState;
  matched?: MatchedFile;
}

export interface DuplicateFinding {
  path: string;
  name: string;
  /** The slot this file also satisfies, already claimed by a better candidate. */
  slot: Slot;
  state: Exclude<ArtifactState, "missing">;
}

/**
 * `unrecognized` means the filename did not parse at all. `unexpected` means it
 * parsed cleanly but names a client, period or deliverable nobody owes, which
 * usually means the workbook is stale rather than the repository being wrong.
 */
export type OrphanKind = "unrecognized" | "unexpected";

export interface OrphanFinding {
  path: string;
  name: string;
  kind: OrphanKind;
  parsed?: Slot;
}

export interface ClientSummary {
  client: string;
  counts: Record<ArtifactState, number>;
  compliant: boolean;
}

export interface Provenance {
  scannedAt: string;
  searchCrossCheckIncluded: boolean;
  workbookSource: string;
}

export interface ReconciliationReport {
  profileId: string;
  window: { from: Period; to: Period };
  provenance: Provenance;
  artifacts: ArtifactFinding[];
  duplicates: DuplicateFinding[];
  orphans: OrphanFinding[];
  emptyFolders: string[];
  clients: ClientSummary[];
}
```

Note there is no `generatedAt`. A timestamp the engine invents would make every golden file fail on the second run, and the only time that matters is the scan time, which is an input.

- [ ] **Step 2: Write the failing period test**

Create `tests/domain/reconcile/period.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { anchorPeriod, periodsInWindow } from "../../../src/domain/reconcile/period.js";

const asOf = { year: 2026, month: 6 };

describe("periodsInWindow", () => {
  it("returns one period per month for a monthly cadence, oldest first", () => {
    const periods = periodsInWindow({ asOf, months: 3, cadence: "monthly", anchor: "last" });

    expect(periods).toEqual([
      { year: 2026, month: 4 },
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
    ]);
  });

  it("crosses a year boundary", () => {
    const periods = periodsInWindow({ asOf: { year: 2026, month: 2 }, months: 3, cadence: "monthly", anchor: "last" });

    expect(periods).toEqual([
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
      { year: 2026, month: 2 },
    ]);
  });

  it("returns one period per quarter, anchored to the quarter's last month", () => {
    const periods = periodsInWindow({ asOf, months: 12, cadence: "quarterly", anchor: "last" });

    expect(periods).toEqual([
      { year: 2025, month: 9 },
      { year: 2025, month: 12 },
      { year: 2026, month: 3 },
      { year: 2026, month: 6 },
    ]);
  });

  it("anchors a quarter to its first month when the profile says so", () => {
    const periods = periodsInWindow({ asOf, months: 6, cadence: "quarterly", anchor: "first" });

    expect(periods).toEqual([
      { year: 2026, month: 1 },
      { year: 2026, month: 4 },
    ]);
  });

  it("excludes periods before a client's effective date", () => {
    const periods = periodsInWindow({
      asOf,
      months: 6,
      cadence: "monthly",
      anchor: "last",
      effectiveFrom: { year: 2026, month: 4 },
    });

    expect(periods).toEqual([
      { year: 2026, month: 4 },
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
    ]);
  });
});

describe("anchorPeriod", () => {
  it("maps any month in a quarter to the quarter's anchored month", () => {
    expect(anchorPeriod({ year: 2026, month: 4 }, "quarterly", "last")).toEqual({ year: 2026, month: 6 });
    expect(anchorPeriod({ year: 2026, month: 6 }, "quarterly", "last")).toEqual({ year: 2026, month: 6 });
    expect(anchorPeriod({ year: 2026, month: 4 }, "quarterly", "first")).toEqual({ year: 2026, month: 4 });
  });

  it("leaves a monthly period alone", () => {
    expect(anchorPeriod({ year: 2026, month: 5 }, "monthly", "last")).toEqual({ year: 2026, month: 5 });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/domain/reconcile/period.test.ts`
Expected: FAIL, cannot resolve `period.js`.

- [ ] **Step 4: Implement `src/domain/reconcile/period.ts`**

Represent a period as a month index internally to make the arithmetic trivial and the year boundary free. Handle `semiannual` and `annual` too, since the profile schema allows them; treat cadence as a span in months.

The anchor decides which month of a multi-month period represents it. A report covering a quarter is produced after the quarter closes, which is why `last` is the profile default, but both must work.

Do not read the clock. `asOf` is a parameter.

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/domain/reconcile/period.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Write the failing render test**

Create `tests/domain/reconcile/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderPath, renderTemplate } from "../../../src/domain/reconcile/render.js";

const context = { period: { year: 2026, month: 5 }, client: "CLIENTA", deliverable: "MonthlyTraining" };

describe("renderTemplate", () => {
  it("renders every supported placeholder", () => {
    expect(renderTemplate("{year}-{month:02}_{client}_{deliverable}.xlsx", context)).toBe(
      "2026-05_CLIENTA_MonthlyTraining.xlsx",
    );
  });

  it("renders an unpadded month and a month name", () => {
    expect(renderTemplate("{month}-{monthName}", context)).toBe("5-May");
  });

  it("leaves literal text alone", () => {
    expect(renderTemplate("Reports {year} final", context)).toBe("Reports 2026 final");
  });
});

describe("renderPath", () => {
  it("joins rendered segments with forward slashes", () => {
    expect(renderPath(["{year}", "{client}", "{month:02}-{monthName}"], context)).toBe("2026/CLIENTA/05-May");
  });
});
```

- [ ] **Step 7: Run it to verify it fails, then implement `src/domain/reconcile/render.ts`**

Run: `npx vitest run tests/domain/reconcile/render.test.ts`, expect FAIL, then implement.

Month names are English and fixed, not locale-derived, because the repository's folder names are data rather than presentation and a machine with a different locale must produce identical paths. Say that in a comment.

Reuse the token set from `src/domain/profile/placeholders.ts` rather than restating it. A renderer that supports a token the validator rejects, or vice versa, is a bug waiting for a profile to find it.

- [ ] **Step 8: Write the error-path test**

Create `tests/domain/reconcile/render.errors.test.ts` asserting that an unknown placeholder throws naming the token, rather than rendering a literal brace. The profile validator already rejects unknown tokens, so reaching the renderer with one means a bug upstream, and rendering `{quarter}` into a path silently would produce a file path that can never match anything.

- [ ] **Step 9: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:errors
git add src tests
git commit -m "feat: add reconciliation types, period arithmetic and template rendering"
```

---

### Task 2: Expected-state derivation

**Files:**
- Create: `src/domain/reconcile/expected.ts`
- Test: `tests/domain/reconcile/expected.test.ts`

**Interfaces:**
- Consumes: `Profile`, `WorkbookSnapshot`, `Period`, `periodsInWindow`, `renderPath`, `renderTemplate`.
- Produces: `deriveExpected(profile, workbook, asOf): ArtifactFinding[]` where every finding has state `missing` and no `matched`. Matching fills those in later.

- [ ] **Step 1: Write the failing test**

Cover: one client owing one monthly deliverable produces one artifact per month in the window, each with the correct rendered path and name. A client whose `appliesTo` field is falsey owes nothing. A client owing two deliverables produces both. A quarterly deliverable produces one artifact per quarter at the anchored month. A client with an effective date inside the window is not expected to have filed before it, and only when `respectEffectiveFrom` is set.

Assert the rendered `expectedPath` and `expectedName` explicitly rather than just the count, since a wrong render is the failure that produces confident false "missing" findings.

- [ ] **Step 2: Run it to verify it fails, then implement**

The cross product is client, then the deliverables that client owes, then the periods for that deliverable's cadence. `appliesTo.workbookField` names a key in the row's `fields`; treat it as owed when the value is truthy, and treat the string `"no"` and `"false"` as falsey too, because a hand-maintained spreadsheet uses words rather than booleans. Say why in a comment.

Skip a deliverable whose `workbookField` is absent from a row entirely rather than throwing: the profile validator already guarantees the field is mapped, so an absent value means that row left the cell blank, which means not owed.

- [ ] **Step 3: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src tests
git commit -m "feat: derive expected artifacts from the workbook and the profile"
```

---

### Task 3: Parsing actual files

**Files:**
- Create: `src/domain/reconcile/parse.ts`
- Test: `tests/domain/reconcile/parse.test.ts`, `tests/domain/reconcile/parse.errors.test.ts`

**Interfaces:**
- Consumes: `Profile`, `RepositoryFile`, `Period`, `anchorPeriod`.
- Produces: `parseFile(profile, file): ParsedFile`, and the `ParsedFile` type: either `{ recognized: false; file }` or `{ recognized: true; file; client; deliverable; period; nameVerdict: "canonical" | "compliant" | "misnamed"; recognizerId?: string }`.

- [ ] **Step 1: Write the failing test**

Cover: a canonical filename parses with verdict `canonical`. A filename matching a recognizer whose verdict is `misnamed` parses with that verdict and carries the recognizer id. A recognizer whose verdict is `compliant` parses as an accepted alias. A filename matching nothing is unrecognized. Recognizers are tried in profile order and the first match wins. A recognizer capturing a month name rather than a number normalizes to the same period.

That last one matters: `CLIENTA Monthly - May 2026.xlsx` and `2026-05_CLIENTA_MonthlyTraining.xlsx` must produce the same period, or a legacy file will never match its slot.

- [ ] **Step 2: Run it to verify it fails, then implement**

Build a matcher from `naming.template` by turning its placeholders into named capture groups, so the canonical form is parsed by the same description that renders it. Two independent definitions of the canonical name would drift.

Recognizers already carry regular expressions with named captures. Accept `client`, `deliverable`, `year`, `month` and `monthName` as capture names. A recognizer that names no deliverable capture falls back to its declared `deliverable` field, which is why that field exists.

Normalize a captured month name against the same fixed English month list the renderer uses. Case-insensitively, and accept a three-letter abbreviation, because both appear in real repositories.

- [ ] **Step 3: Write the error-path test**

Cover a recognizer that matches but captures an impossible month, such as `13` or a misspelled name. It must be treated as unrecognized rather than producing a period nobody can satisfy, and the reason belongs in a comment: a file parsed into a nonexistent period would be reported as an orphan against a slot that cannot exist, which reads as a repository problem when it is a profile problem.

- [ ] **Step 4: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:errors
git add src tests
git commit -m "feat: parse repository filenames against the profile's naming rules"
```

---

### Task 4: Matching, duplicates and orphans

**Files:**
- Create: `src/domain/reconcile/match.ts`
- Test: `tests/domain/reconcile/match.test.ts`

**Interfaces:**
- Consumes: `ArtifactFinding[]` from Task 2, `ParsedFile[]` from Task 3, `renderPath`.
- Produces: `matchArtifacts(profile, expected, parsed): { artifacts, duplicates, orphans }`.

- [ ] **Step 1: Write the failing test**

Cover every state and every rule the spec names. A canonical file in the right folder is `compliant`. A recognizer-misnamed file in the right folder is `misnamed`. A canonical file at a client root is `misplaced`. Both wrong is `misnamed_and_misplaced`. A slot with no candidate stays `missing`. Two candidates for one slot: the better wins by the state ranking and the other becomes a duplicate naming that slot. A tie between two equally ranked candidates resolves to the most recently modified, and a tie on that resolves alphabetically by path. A parsed file matching no slot is an `unexpected` orphan. An unparsed file is an `unrecognized` orphan.

Assert the duplicate's `slot` explicitly. A duplicate reported with no link to what it duplicates is the failure mode the design decision was made to avoid.

- [ ] **Step 2: Run it to verify it fails, then implement**

Compute each candidate's state from two independent axes, name and location, exactly as the spec describes. Location compares the file's folder against the path rendered for what the file parsed to, not against the slot's expected path; those coincide for a correct file and differ for a misplaced one, and using the slot's path would make every misplaced file look compliant.

Rank with an explicit order rather than relying on the string ordering of the state names. Comment why the tiebreaks exist: determinism for golden files, and a human diffing two reports by hand.

- [ ] **Step 3: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src tests
git commit -m "feat: match parsed files to expected artifacts with duplicate resolution"
```

---

### Task 5: Empty folders, rollup and the public entry

**Files:**
- Create: `src/domain/reconcile/empty-folders.ts`, `src/domain/reconcile/index.ts`
- Test: `tests/domain/reconcile/empty-folders.test.ts`, `tests/domain/reconcile/reconcile.test.ts`

**Interfaces:**
- Produces: `findEmptyFolders(repository): string[]`. `reconcile(profile, workbook, repository, asOf): ReconciliationReport`, the only export other modules may use.

- [ ] **Step 1: Write the failing empty-folder test**

A folder is empty when no file and no deeper folder sits beneath it. Cover: a folder with a file directly in it is not empty. A folder containing only another folder is not empty, even when that deeper folder is. A folder with nothing beneath it is empty. Path prefix comparison must be segment-aware, so `2026/CLIENTA` is not treated as a parent of `2026/CLIENTAB`.

That last case is the one that silently produces wrong answers, and a naive `startsWith` gets it wrong.

- [ ] **Step 2: Run it to verify it fails, then implement**

- [ ] **Step 3: Write the failing entry-point test**

Assert that `reconcile` composes the stages, produces a report whose per-client rollup agrees with its own artifact findings, and sorts everything: artifacts by client then deliverable then period, duplicates and orphans and empty folders by path.

Derive the rollup from the artifacts rather than recomputing. A summary that can disagree with the findings it summarizes is worse than no summary.

- [ ] **Step 4: Run it to verify it fails, then implement**

`index.ts` exports only `reconcile` and the types. The stage modules stay unexported from the package's perspective, per the design decision that one authoritative computation is the point.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src tests
git commit -m "feat: assemble the reconciliation report behind one entry point"
```

---

### Task 6: Fixtures and the golden report

**Files:**
- Create: `tests/domain/reconcile/fixtures/profile.json`, `workbook.json`, `repository.json`, `expected-report.json`
- Test: `tests/domain/reconcile/golden.test.ts`, `tests/domain/reconcile/degraded.errors.test.ts`

- [ ] **Step 1: Build the fixtures**

One synthetic profile, workbook and repository that between them exercise every state and every rule that could silently invert:

a compliant file; one compliant only through an alias recognizer; a misnamed file; a misplaced file; one that is both; a slot with nothing anywhere; a duplicate pair; an unrecognized orphan; an unexpected orphan; an empty folder; a quarterly deliverable exercising the anchor; a client whose effective date excludes earlier periods; and a client who owes nothing at all.

Use obviously synthetic names. No real company, client or tenant may appear.

- [ ] **Step 2: Write the golden test**

Load the three fixtures, run `reconcile` with a fixed `asOf`, and compare the whole report against `expected-report.json`.

Generate the expected report by running the engine once and inspecting the output by hand
against the fixture, case by case, before committing it. A golden file adopted without reading
it pins whatever the code did on the day it was written, including its bugs. Say in the test
file that it was reviewed by hand.

If that inspection finds the engine wrong, fix the engine. Never adjust the golden file to match
output you have judged incorrect. That is the single way this test stops being worth anything,
and it will be tempting at exactly the moment it matters, because the failing diff will look
like noise against thirteen cases that are right.

- [ ] **Step 3: Write the degraded-scan test**

Create `tests/domain/reconcile/degraded.errors.test.ts`. Run the same fixtures with `searchCrossCheckIncluded: false` and assert the report's provenance says so.

Then assert the substantive property: the engine still runs and still reports, but a caller can tell the scan was partial. This is the fixture that stops a future change from quietly presenting an incomplete scan as a complete answer.

- [ ] **Step 4: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:errors
git add tests
git commit -m "test: pin the reconciliation engine against reviewed golden fixtures"
```

---

## Definition of done

- `npm run lint && npm run typecheck && npm test && npm run test:errors && npm run build` all pass.
- `src/domain/reconcile/index.ts` exports `reconcile` and the types, and nothing else.
- No clock access anywhere in `src/domain/`. The reference date is a parameter.
- Every artifact state, both orphan kinds, duplicate resolution with both tiebreaks, the quarterly anchor, and effective-date exclusion each have a test that fails if the rule is removed.
- The golden report was read by hand before being committed, and the test file says so.
- A snapshot without the Search cross-check produces a report that says so.
- The engine runs with no Graph, no tenant and no network, which the whole suite already demonstrates by having none available.
