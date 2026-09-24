# Phase 6d Operator-Authored Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `generate_custom_plan` and `execute_custom_plan`, which rename and move files an operator describes with declarative selectors, through the existing plan-then-execute path, and ship library-only profiles so a library with no tracking workbook can be onboarded.

**Architecture:** A profile gains a `kind`: `compliance` (today's shape, the default) or `library` (identity only). The registry's `get` keeps returning a compliance profile and refuses a library one; a new `getAny` returns either. A pure resolver, `src/domain/custom/resolve.ts`, turns steps plus the repository snapshot into concrete items, exclusions, or a refusal. The generator persists a plan of kind `custom` holding the steps verbatim; the executor is a thin wrapper over the shared `applyPlan`.

**Tech Stack:** TypeScript, Node, `@modelcontextprotocol/sdk`, Zod, `@azure/data-tables`, vitest.

## Global Constraints

From `CLAUDE.md` and the spec at `docs/superpowers/specs/2026-09-23-custom-plans-design.md`, including its section "Amendments, 2026-09-24, before the implementation plan", which binds where it differs from the earlier sections.

- **No em dashes and no en dashes anywhere**, including string literals, comments and commit messages. `tests/source-hygiene.test.ts` enforces it.
- **No emojis. US English.**
- **The domain layer is pure.** Nothing under `src/domain/` performs I/O or imports from `src/store`, `src/graph`, `src/scan` or config. Lint enforces it.
- **A message states only what the code observed.** Refusals and exclusion reasons name what was seen, never a guessed cause.
- **Every tool input field description contains "for example"**, and a tool's `inputSchema` is a plain `z.object({...})`, never refined. Rules spanning fields go in the handler and in `inputConstraints`, stated verbatim in the description (enforced by `tests/tools/contract.test.ts`).
- **Every existing profile loads unchanged.** An absent `kind` means `compliance`.
- **Existing tests pass unedited** except where a task names the file it changes (`tests/tools/contract.test.ts` for the tool count and list).
- **Test naming:** happy path in `X.test.ts`, failures in `X.errors.test.ts`.
- **Conventional commits**, each ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Run `npm run lint`, `npm run typecheck` and `npm test` before every commit.

---

## File Structure

**Created:**
- `src/domain/profile/library.ts`: `LibraryProfileSchema`, `LibraryProfile`, `AnyProfile`, `loadAnyProfile`.
- `src/domain/custom/names.ts`: name splitting and SharePoint name validity. Pure.
- `src/domain/custom/resolve.ts`: step types and `resolveCustomPlan`. Pure.
- `src/tools/custom/output.ts`, `src/tools/custom/text.ts`, `src/tools/custom/generate.ts`, `src/tools/custom/execute.ts`.
- `src/tools/definitions/generate-custom-plan.ts`, `src/tools/definitions/execute-custom-plan.ts`.
- `examples/profiles/library-example.json`.
- Tests beside each under `tests/`.

**Modified:** `src/profiles/registry.ts`, `src/tools/errors.ts`, `src/scan/coordinator.ts`, `src/scan/run.ts`, `src/scan/cross-check.ts`, `src/tools/reconciliation/output.ts` (skip reason enum), `src/tools/inventory/run.ts`, `src/tools/query/run.ts`, `src/store/types.ts`, `src/store/table.ts`, `src/store/memory.ts`, `src/tools/rename/ids.ts`, `src/tools/registry.ts`, `tests/tools/contract.test.ts`, docs.

---

## Task 1: Library-only profiles in the schema and the registry

**Files:**
- Create: `src/domain/profile/library.ts`, `examples/profiles/library-example.json`, `tests/domain/profile/library.test.ts`, `tests/domain/profile/library.errors.test.ts`, `tests/profiles/registry-kinds.test.ts`, `tests/profiles/registry-kinds.errors.test.ts`
- Modify: `src/profiles/registry.ts`, `src/tools/errors.ts`, `tests/tools/errors.test.ts` (one added test)

**Interfaces:**
- Produces:
  - `LibraryProfile = { kind: "library"; profileId: string; identity: { siteUrl: string; library: string; searchRegion?: string } }`
  - `AnyProfile = (Profile & { kind?: "compliance" }) | LibraryProfile`
  - `isLibraryProfile(profile: AnyProfile): profile is LibraryProfile`
  - `loadAnyProfile(input: unknown): AnyProfile` (throws `ProfileValidationError`)
  - `class LibraryProfileError extends Error { readonly profileId: string }`
  - `ProfileRegistry.get(profileId): Profile` (refuses a library profile with `LibraryProfileError`) and `ProfileRegistry.getAny(profileId): AnyProfile`

- [ ] **Step 1: Write the failing tests**

`tests/domain/profile/library.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isLibraryProfile, loadAnyProfile } from "../../../src/domain/profile/library.js";

const example = JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown;

describe("loadAnyProfile", () => {
  it("loads a library profile carrying identity only", () => {
    const profile = loadAnyProfile({
      kind: "library",
      profileId: "shared-docs",
      identity: { siteUrl: "https://contoso.sharepoint.com/sites/Example", library: "Shared Documents" },
    });

    expect(isLibraryProfile(profile)).toBe(true);
    expect(profile.identity.library).toBe("Shared Documents");
  });

  it("loads an existing profile with no kind as a compliance profile, unchanged", () => {
    const profile = loadAnyProfile(example);

    expect(isLibraryProfile(profile)).toBe(false);
    expect(profile.profileId).toBe((example as { profileId: string }).profileId);
  });

  it("accepts an explicit compliance kind", () => {
    expect(isLibraryProfile(loadAnyProfile({ ...(example as object), kind: "compliance" }))).toBe(false);
  });

  it("loads the committed library example", () => {
    const profile = loadAnyProfile(JSON.parse(readFileSync("examples/profiles/library-example.json", "utf8")));
    expect(isLibraryProfile(profile)).toBe(true);
  });
});
```

`tests/domain/profile/library.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadAnyProfile } from "../../../src/domain/profile/library.js";
import { ProfileValidationError } from "../../../src/domain/profile/load.js";

const identity = { siteUrl: "https://contoso.sharepoint.com/sites/Example", library: "Docs" };

describe("loadAnyProfile refusals", () => {
  it("refuses a library profile carrying compliance fields, rather than silently ignoring them", () => {
    expect(() =>
      loadAnyProfile({ kind: "library", profileId: "docs", identity, taxonomy: { segments: ["{year}"] } }),
    ).toThrow(ProfileValidationError);
  });

  it("refuses a library profile with a workbookPath in its identity", () => {
    expect(() =>
      loadAnyProfile({ kind: "library", profileId: "docs", identity: { ...identity, workbookPath: "/x.xlsx" } }),
    ).toThrow(ProfileValidationError);
  });

  it("refuses an unknown kind", () => {
    expect(() => loadAnyProfile({ kind: "archive", profileId: "docs", identity })).toThrow(ProfileValidationError);
  });
});
```

`tests/profiles/registry-kinds.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createProfileRegistry } from "../../src/profiles/registry.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";
const compliance = JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown;
const library = { kind: "library", profileId: "shared-docs", identity: { siteUrl: SITE, library: "Shared Documents" } };

describe("profile registry with two kinds", () => {
  const registry = createProfileRegistry(
    [
      { source: "example.json", contents: compliance },
      { source: "shared-docs.json", contents: library },
    ],
    SITE,
  );

  it("lists both kinds", () => {
    expect(registry.ids()).toContain("shared-docs");
  });

  it("returns either kind from getAny", () => {
    expect(registry.getAny("shared-docs").identity.library).toBe("Shared Documents");
  });

  it("still returns a compliance profile from get", () => {
    const id = (compliance as { profileId: string }).profileId;
    expect(registry.get(id).taxonomy.segments.length).toBeGreaterThan(0);
  });
});
```

`tests/profiles/registry-kinds.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createProfileRegistry, LibraryProfileError, ProfileRegistryError } from "../../src/profiles/registry.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";

describe("profile registry refusals for library profiles", () => {
  it("refuses a library profile through get, naming it and why", () => {
    const registry = createProfileRegistry(
      [{ source: "d.json", contents: { kind: "library", profileId: "docs", identity: { siteUrl: SITE, library: "Docs" } } }],
      SITE,
    );

    expect(() => registry.get("docs")).toThrow(LibraryProfileError);
    expect(() => registry.get("docs")).toThrow(/library-only/);
  });

  it("applies the granted-site check to a library profile too", () => {
    expect(() =>
      createProfileRegistry(
        [
          {
            source: "d.json",
            contents: { kind: "library", profileId: "docs", identity: { siteUrl: "https://contoso.sharepoint.com/sites/Other", library: "Docs" } },
          },
        ],
        SITE,
      ),
    ).toThrow(ProfileRegistryError);
  });
});
```

In `tests/tools/errors.test.ts`, add inside the `describe` (import `LibraryProfileError` from `../../src/profiles/registry.js`):

```ts
  it("explains that a tool needs a compliance profile when handed a library-only one", () => {
    const message = describeToolFailure(new LibraryProfileError("docs"), { tool: "reconcile_workbook_vs_repository", profileId: "docs" });

    expect(message).toContain('"docs"');
    expect(message).toContain("library-only");
    expect(message).toContain("reconcile_workbook_vs_repository");
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/domain/profile/library tests/profiles/registry-kinds tests/tools/errors.test.ts`
Expected: FAIL, modules and exports not found.

- [ ] **Step 3: Create `src/domain/profile/library.ts`**

```ts
import { z } from "zod";
import { ProfileSchema, type Profile } from "./schema.js";
import { ProfileValidationError, loadProfile } from "./load.js";

/**
 * Identity only: the site and the library, and the search region a scan would
 * use. A library profile has no workbook, taxonomy, filename standard or
 * deliverables, so it can be inventoried, queried for empty folders, and
 * reorganized through operator-written plans, and nothing else.
 *
 * `.strict()` so a compliance field on a library profile is refused rather
 * than silently ignored: a profile that looks configured for reconciliation
 * but is not would be read as a promise the server does not keep.
 */
export const LibraryProfileSchema = z
  .object({
    kind: z.literal("library"),
    profileId: ProfileSchema.innerType().shape.profileId,
    identity: z
      .object({
        siteUrl: z.string().url(),
        library: z.string().min(1),
        searchRegion: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export type LibraryProfile = z.infer<typeof LibraryProfileSchema>;

export type AnyProfile = (Profile & { kind?: "compliance" }) | LibraryProfile;

export function isLibraryProfile(profile: AnyProfile): profile is LibraryProfile {
  return profile.kind === "library";
}

/**
 * The one entry point for a profile of either kind. An absent `kind` is a
 * compliance profile, so every profile written before kinds existed loads
 * exactly as it did.
 */
export function loadAnyProfile(input: unknown): AnyProfile {
  const kind = typeof input === "object" && input !== null ? (input as { kind?: unknown }).kind : undefined;
  if (kind === undefined || kind === "compliance") {
    const { kind: _ignored, ...rest } = input as Record<string, unknown>;
    return loadProfile(rest);
  }
  if (kind !== "library") {
    throw new ProfileValidationError([`kind: must be "compliance" or "library", not ${JSON.stringify(kind)}`]);
  }
  const result = LibraryProfileSchema.safeParse(input);
  if (result.success) return result.data;
  throw new ProfileValidationError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
}
```

`ProfileSchema` is a `ZodEffects` (it ends in `.superRefine`), which is why `.innerType().shape.profileId` reuses its id rule rather than restating it. Check `ProfileValidationError`'s constructor in `src/domain/profile/load.ts` takes `string[]`; if it takes something else, match it. If `loadProfile` returns an object without `kind`, that is correct: `AnyProfile`'s compliance member makes `kind` optional.

- [ ] **Step 4: Create `examples/profiles/library-example.json`**

```json
{
  "kind": "library",
  "profileId": "shared-docs",
  "identity": {
    "siteUrl": "https://contoso.sharepoint.com/sites/Example",
    "library": "Shared Documents"
  }
}
```

The site matches `examples/profiles/example.json`'s, since both load against one granted site in tests.

- [ ] **Step 5: Teach the registry both kinds**

In `src/profiles/registry.ts`:

1. Import `loadAnyProfile`, `isLibraryProfile`, `type AnyProfile` from `../domain/profile/library.js`.
2. Add, near `UnknownProfileError`:

```ts
/**
 * A tool that needs a compliance definition was handed a library-only
 * profile. Every such tool resolves its profile before its first Graph
 * request, so in practice nothing has been read; the message does not claim
 * that, because this class cannot observe where its caller was. A
 * reconciliation or structure check over a profile with no expected state
 * would report every client as compliant, a result the server did not observe.
 */
export class LibraryProfileError extends Error {
  readonly profileId: string;

  constructor(profileId: string) {
    super(
      `Profile "${profileId}" is library-only: it names a site and a library but no tracking workbook, ` +
        "taxonomy or filename standard, so this tool, which needs them, cannot run against it. inventory_tree, " +
        "query_repository's empty_folders question, and the custom plan tools work with a library-only profile.",
    );
    this.name = "LibraryProfileError";
    this.profileId = profileId;
  }
}
```

3. Change the map's value type to `{ profile: AnyProfile; source: string }`, and in the loop replace `profile = loadProfile(entry.contents);` with `profile = loadAnyProfile(entry.contents);`, declaring `let profile: AnyProfile;`. The duplicate-id and granted-site checks read only `profileId` and `identity.siteUrl`, which both kinds carry, so they apply unchanged.
4. Add `getAny(profileId: string): AnyProfile;` to the `ProfileRegistry` interface, with the doc comment "Either kind. For the tools that work without a compliance definition.", and implement both:

```ts
    get(profileId: string): Profile {
      const held = byId.get(profileId);
      if (held === undefined) throw new UnknownProfileError(profileId, [...ids]);
      if (isLibraryProfile(held.profile)) throw new LibraryProfileError(profileId);
      return held.profile;
    },
    getAny(profileId: string): AnyProfile {
      const held = byId.get(profileId);
      if (held === undefined) throw new UnknownProfileError(profileId, [...ids]);
      return held.profile;
    },
```

Update the doc comment on `get` to say it refuses a library profile, and why.

- [ ] **Step 6: Map the error for tool callers**

In `src/tools/errors.ts`, import `LibraryProfileError` from `../profiles/registry.js` and add, right after the `UnknownProfileError` branch:

```ts
  if (error instanceof LibraryProfileError) {
    // The error already names the profile, what it lacks and which tools do
    // work with it; only the failing tool's name is added.
    return `${subject.tool} needs a compliance profile. ${error.message}`;
  }
```

- [ ] **Step 7: Run tests, lint, typecheck, full suite, commit**

Run: `npx vitest run tests/domain/profile tests/profiles tests/tools/errors.test.ts`, then `npm run lint && npm run typecheck && npm test`. Expected: PASS, every existing test unedited.

```bash
git add src/domain/profile/library.ts src/profiles/registry.ts src/tools/errors.ts examples/profiles/library-example.json tests/domain/profile tests/profiles tests/tools/errors.test.ts
git commit -m "feat(profiles): add library-only profiles alongside compliance profiles"
```

---

## Task 2: Scans and the read tools accept a library profile

**Files:**
- Modify: `src/scan/coordinator.ts`, `src/scan/run.ts`, `src/scan/cross-check.ts`, `src/tools/reconciliation/output.ts`, `src/scan/cli.ts` (only if it switches exhaustively on the skip reason), `src/tools/inventory/run.ts`, `src/tools/query/run.ts`
- Test: `tests/scan/cross-check.errors.test.ts` (one added test), `tests/tools/inventory/library.test.ts`, `tests/tools/query/library.errors.test.ts`, `tests/tools/query/library.test.ts`

**Interfaces:**
- Consumes: `AnyProfile`, `isLibraryProfile`, `registry.getAny` (Task 1).
- Produces: `CrossCheckSkipReason` gains `"library-profile"`; `ScanCoordinator.run/settle/scansStarted` and `runScan` accept `AnyProfile`.

- [ ] **Step 1: Write the failing tests**

In `tests/scan/cross-check.errors.test.ts`, add (reuse the file's existing client and drives fixtures; the point is that no search request is made):

```ts
  it("skips a library profile with its own reason and spends no request", async () => {
    let posts = 0;
    const client = { post: () => { posts += 1; return Promise.reject(new Error("must not search")); } };
    const library = {
      kind: "library" as const,
      profileId: "docs",
      identity: { siteUrl: "https://contoso.sharepoint.com/sites/Example", library: "Docs", searchRegion: "NAM" },
    };

    const result = await crossCheckOtherLibraries(client, library, [], "drive-1");

    expect(result).toEqual({ files: [], complete: false, reason: "library-profile" });
    expect(posts).toBe(0);
  });
```

`tests/tools/inventory/library.test.ts`: build a context with `createFakeToolContext({ profiles: createProfileRegistry([...example.json, library-example.json], SITE), scans: scanCoordinatorStub(...) })`, using the same scan-result fixture helpers the existing `tests/tools/inventory/*.test.ts` use (read one and reuse its helpers verbatim), call the inventory handler with `{ profileId: "shared-docs" }`, and assert the result is not an error and lists the fixture's files.

`tests/tools/query/library.test.ts`: the same context; `question: "empty_folders"` for `shared-docs` answers without error.

`tests/tools/query/library.errors.test.ts`: `question: "naming_violations"` and `question: "recent_reports"` for `shared-docs` each return `isError: true`, the text names the question and says the profile is library-only, and the store was not read (wrap the fake store's `listInventory` to count calls and assert zero).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/scan/cross-check.errors.test.ts tests/tools/inventory/library tests/tools/query/library`
Expected: FAIL (type errors or `LibraryProfileError` from `get`).

- [ ] **Step 3: Widen the scan layer**

- `src/scan/cross-check.ts`: add `"library-profile"` to `CrossCheckSkipReason`; change the `profile` parameter type to `AnyProfile`; as the first statement of `crossCheckOtherLibraries`:

```ts
  // A library profile has no naming template, and the search query is built
  // from the template's literal extension, so there is nothing to search for.
  // Checked before the region so the reason names the real cause.
  if (isLibraryProfile(profile)) return { files: [], complete: false, reason: "library-profile" };
```

  After that guard TypeScript narrows `profile` to the compliance member, so `profile.naming` still typechecks.
- `src/scan/run.ts` and `src/scan/coordinator.ts`: change every `Profile` parameter and field type to `AnyProfile`. Neither reads a compliance field; if typecheck says one does, stop and report NEEDS_CONTEXT naming the line.
- `src/tools/reconciliation/output.ts`: add `"library-profile"` wherever the skip reasons are enumerated, with a comment that reconciliation never sees it, because `reconcile_workbook_vs_repository` refuses a library profile through `get`, and it is listed only so the enumeration stays exhaustive. If `reconciliation/text.ts` or `shape.ts` switch on the reason exhaustively, add a case whose text says the cross-check does not apply to a library-only profile.
- `src/scan/cli.ts`: the same, if it renders the reason.

- [ ] **Step 4: Let the two read tools accept a library profile**

- `src/tools/inventory/run.ts`: replace `context.profiles.get(` with `context.profiles.getAny(`. Typecheck confirms nothing else reads a compliance field.
- `src/tools/query/run.ts`: use `getAny`, and before any store read, refuse the two questions that need a naming standard:

```ts
    const profile = context.profiles.getAny(args.profileId);
    if (isLibraryProfile(profile) && args.question !== "empty_folders") {
      // Both need the naming standard: naming_violations compares names to it,
      // and recent_reports recognizes a report by parsing its name against it.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `Profile "${args.profileId}" is library-only, so "${args.question}" cannot be answered: it needs the ` +
              "profile's filename standard, which a library-only profile does not have. empty_folders works. " +
              "Nothing was read.",
          },
        ],
      };
    }
```

  After this guard, pass the narrowed compliance profile to `namingViolations` and `recentReports` (TypeScript narrows it; if it cannot see through the condition, branch on `isLibraryProfile(profile)` explicitly so it can). Update the tool's description in `src/tools/definitions/query-repository.ts` with one sentence: "With a library-only profile, only empty_folders is available."

- [ ] **Step 5: Run tests, lint, typecheck, full suite, commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/scan src/tools/reconciliation src/tools/inventory src/tools/query src/tools/definitions/query-repository.ts tests/scan tests/tools/inventory tests/tools/query
git commit -m "feat(tools): scan, inventory and empty-folder queries over a library-only profile"
```

---

## Task 3: The pure resolver

**Files:**
- Create: `src/domain/custom/names.ts`, `src/domain/custom/resolve.ts`
- Test: `tests/domain/custom/names.test.ts`, `tests/domain/custom/names.errors.test.ts`, `tests/domain/custom/resolve.test.ts`, `tests/domain/custom/resolve.errors.test.ts`

**Interfaces:**
- Produces, from `src/domain/custom/resolve.ts`:

```ts
export interface CustomSelector {
  folder: string;
  recursive?: boolean;
  nameEquals?: string;
  nameContains?: string;
  extensions?: string[];
  modifiedAfter?: string;
  modifiedBefore?: string;
}
export type CustomRename =
  | { setName: string }
  | { replace: { find: string; with: string } }
  | { addPrefix: string }
  | { addSuffix: string };
export interface CustomStep {
  selector: CustomSelector;
  moveTo?: string;
  rename?: CustomRename;
}
export type CustomExclusionReason =
  | "matched_by_multiple_steps"
  | "no_change"
  | "extension_would_change"
  | "invalid_target_name"
  | "target_path_already_occupied"
  | "two_items_share_one_target";
export interface ResolvedItem { path: string; currentName: string; targetName: string; targetPath: string; step: number }
export interface ResolvedExclusion { path: string; currentName: string; targetName: string; reason: CustomExclusionReason; steps: number[] }
export type CustomRefusal =
  | { kind: "invalid_step"; step: number; detail: string }
  | { kind: "unknown_folder"; step: number; field: "folder" | "moveTo"; requested: string; nearestExisting: string; children: string[] }
  | { kind: "ambiguous_set_name"; step: number; matched: number }
  | { kind: "too_many_files"; perStep: number[]; total: number; limit: number }
  | { kind: "nothing_matched"; perStep: number[] };
export type CustomResolution =
  | { ok: true; items: ResolvedItem[]; exclusions: ResolvedExclusion[]; perStep: number[] }
  | { ok: false; refusal: CustomRefusal };
export const MAX_CUSTOM_PLAN_FILES = 100;
export const MAX_CUSTOM_PLAN_STEPS = 20;
export function resolveCustomPlan(
  steps: readonly CustomStep[],
  snapshot: { files: readonly { path: string; name: string; modified: string; library?: string }[]; folderPaths: readonly string[] },
): CustomResolution;
```

Step numbers are 1-based everywhere, matching how an operator reads them.

- From `src/domain/custom/names.ts`: `splitName(name): { stem: string; extension: string }`, `invalidNameReason(name: string, atLibraryRoot: boolean): string | undefined`.

- [ ] **Step 1: Write `src/domain/custom/names.ts` tests first**

`tests/domain/custom/names.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { invalidNameReason, splitName } from "../../../src/domain/custom/names.js";

describe("splitName", () => {
  it("splits at the last dot", () => {
    expect(splitName("report.final.pdf")).toEqual({ stem: "report.final", extension: ".pdf" });
  });
  it("treats a name without a dot as all stem", () => {
    expect(splitName("README")).toEqual({ stem: "README", extension: "" });
  });
  it("treats a leading dot as part of the stem, not an extension", () => {
    expect(splitName(".gitignore")).toEqual({ stem: ".gitignore", extension: "" });
  });
});

describe("invalidNameReason", () => {
  it("accepts an ordinary name", () => {
    expect(invalidNameReason("2026-05 Client A report.pdf", false)).toBeUndefined();
  });
});
```

`tests/domain/custom/names.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { invalidNameReason } from "../../../src/domain/custom/names.js";

describe("invalidNameReason refusals", () => {
  it.each(['a"b', "a*b", "a:b", "a<b", "a>b", "a?b", "a/b", "a\\b", "a|b"])("refuses a forbidden character in %s", (name) => {
    expect(invalidNameReason(name, false)).toMatch(/character/);
  });
  it("refuses a leading or trailing space", () => {
    expect(invalidNameReason(" a.pdf", false)).toMatch(/space/);
    expect(invalidNameReason("a.pdf ", false)).toMatch(/space/);
  });
  it.each(["CON", "con.pdf", "NUL", "COM1", "LPT9.txt", ".lock", "desktop.ini"])("refuses the reserved name %s", (name) => {
    expect(invalidNameReason(name, false)).toMatch(/reserved/);
  });
  it("refuses the ~$ prefix and _vti_ anywhere", () => {
    expect(invalidNameReason("~$draft.docx", false)).toMatch(/~\$/);
    expect(invalidNameReason("a_vti_b.pdf", false)).toMatch(/_vti_/);
  });
  it("refuses forms only at the library root", () => {
    expect(invalidNameReason("forms", true)).toMatch(/root/);
    expect(invalidNameReason("forms", false)).toBeUndefined();
  });
  it("refuses an empty name", () => {
    expect(invalidNameReason("", false)).toMatch(/empty/);
  });
});
```

- [ ] **Step 2: Implement `src/domain/custom/names.ts`**

```ts
/**
 * SharePoint's naming rules, from Microsoft's "Restrictions and limitations in
 * OneDrive and SharePoint" (support.microsoft.com, read 2026-09-24). Checked at
 * plan time so a name Graph would refuse is excluded with a reason rather than
 * discovered as a failure during a write. Graph remains the authority: a name
 * this passes that Graph still refuses is reported as failed, never applied.
 */
const FORBIDDEN_CHARACTERS = /["*:<>?/\\|]/;
const RESERVED = new Set([".lock", "con", "prn", "aux", "nul", "desktop.ini",
  ...Array.from({ length: 10 }, (_v, i) => `com${String(i)}`),
  ...Array.from({ length: 10 }, (_v, i) => `lpt${String(i)}`)]);

export function splitName(name: string): { stem: string; extension: string } {
  const cut = name.lastIndexOf(".");
  if (cut <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, cut), extension: name.slice(cut) };
}

/** Why a name cannot be used, or undefined when it can. */
export function invalidNameReason(name: string, atLibraryRoot: boolean): string | undefined {
  if (name.length === 0) return "the name is empty";
  if (FORBIDDEN_CHARACTERS.test(name)) return 'the name contains a character SharePoint forbids (" * : < > ? / \\ |)';
  if (name !== name.trim()) return "the name has a leading or trailing space";
  const lower = name.toLowerCase();
  if (RESERVED.has(lower) || RESERVED.has(splitName(lower).stem)) return `"${name}" is a reserved name in SharePoint`;
  if (name.startsWith("~$")) return "a name may not begin with ~$";
  if (lower.includes("_vti_")) return "a name may not contain _vti_";
  if (atLibraryRoot && lower === "forms") return '"forms" may not be used at the root of a library';
  return undefined;
}
```

Run: `npx vitest run tests/domain/custom/names` and see PASS (write the tests first and see them fail on the missing module).

- [ ] **Step 3: Write the resolver tests**

A shared fixture at the top of both resolver test files:

```ts
import type { CustomStep } from "../../../src/domain/custom/resolve.js";

const FOLDERS = ["Client A", "Client A/2025", "Client A/2026", "Archive", "Archive/2025"];
function f(path: string, modified = "2026-03-01T00:00:00Z") {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), modified };
}
const FILES = [
  f("Client A/2025/Jan report.pdf", "2025-01-31T00:00:00Z"),
  f("Client A/2025/Feb report.pdf", "2025-02-28T00:00:00Z"),
  f("Client A/2025/notes.docx", "2025-03-01T00:00:00Z"),
  f("Client A/2026/Jan report.pdf"),
  f("Archive/2025/old.pdf"),
];
const snapshot = { files: FILES, folderPaths: FOLDERS };
const step = (s: Partial<CustomStep> & { selector: CustomStep["selector"] }): CustomStep => s;
```

`tests/domain/custom/resolve.test.ts` must cover, each as its own `it`, asserting the exact `items`, `exclusions` and `perStep`:
1. Move every PDF in `/Client A/2025` to `/Archive/2025`: two items, targets `Archive/2025/Jan report.pdf` and `Archive/2025/Feb report.pdf`, `perStep` `[2]`.
2. Folder matching ignores case and the target uses the index's casing: `moveTo: "/archive/2025"` yields `targetPath` beginning `Archive/2025/`.
3. `recursive: true` from `/Client A` with `nameContains: "jan"` selects both January reports (case-insensitive).
4. `modifiedAfter: "2025-02-01"` and `modifiedBefore: "2025-03-15"` select only `Feb report.pdf` and `notes.docx`.
5. `addPrefix: "2025 "` renames in place: target `Client A/2025/2025 Jan report.pdf`.
6. `addSuffix: " v2"` inserts before the extension: `Jan report v2.pdf`.
7. `replace: { find: "report", with: "summary" }` replaces every occurrence in the stem only.
8. `setName` on a selector matching exactly one file (`nameEquals: "notes.docx"`) renames it.
9. `moveTo` and `rename` together yield one item with both the new folder and the new name.
10. The library root: `folder: "/"` selects nothing here (no root files), and `folder: ""` is accepted the same way.

`tests/domain/custom/resolve.errors.test.ts` must cover:
1. `unknown_folder` for `folder: "/Client B"`: `nearestExisting` is `""` (the root) and `children` lists up to 10 top-level folders sorted, here `["Archive", "Client A"]`.
2. `unknown_folder` for `moveTo: "/Client A/2027"`: `nearestExisting` `"Client A"`, `children` `["Client A/2025", "Client A/2026"]`, `field` `"moveTo"`.
3. `ambiguous_set_name` when `setName` meets two matches, carrying `matched: 2`.
4. `too_many_files` with 101 distinct matches (build 101 files in one folder), carrying `total: 101`, `limit: 100`, `perStep`.
5. `nothing_matched` when every step matches zero, carrying `perStep` of zeros.
6. `invalid_step` for a step with neither `moveTo` nor `rename`, for a `rename` object with two forms, for an empty `replace.find`, and for more than 20 steps.
7. `matched_by_multiple_steps`: two steps selecting the same file exclude it from both, `steps: [1, 2]`, and it produces no item.
8. `no_change`: `replace` whose `find` is absent from the name.
9. `extension_would_change`: `setName: "notes.pdf"` on `notes.docx`.
10. `invalid_target_name`: `addSuffix: "?"`.
11. `target_path_already_occupied`: renaming `Jan report.pdf` to `Feb report.pdf` in the same folder (compared ignoring case: also test `setName: "FEB REPORT.pdf"`).
12. `two_items_share_one_target`: moving `Client A/2025/Jan report.pdf` and `Client A/2026/Jan report.pdf` both into `Archive/2025` excludes both, with the union of their steps.
13. A file in another library (`library: "Other"`) is never selected.

- [ ] **Step 4: Run them and see them fail**

Run: `npx vitest run tests/domain/custom/resolve`
Expected: FAIL, module not found.

- [ ] **Step 5: Implement `src/domain/custom/resolve.ts`**

Implement exactly the contract above. The algorithm, in this order:

1. If `steps.length` is 0 or more than `MAX_CUSTOM_PLAN_STEPS`, refuse `invalid_step` with step 0 and a detail naming the count and the limit.
2. For each step (1-based), refuse `invalid_step` when: neither `moveTo` nor `rename` is set; `rename` does not have exactly one of the four keys; a `replace.find` is empty; a `setName`, `addPrefix` or `addSuffix` is empty. The detail names which rule.
3. Normalize folders: strip leading and trailing `/`; `""` is the library root, which always exists. Build a map from lowercased folder path to the index's casing from `snapshot.folderPaths`. For each step, resolve `selector.folder` then `moveTo`; an unknown one refuses `unknown_folder`: walk up the requested path's segments to the deepest ancestor present (the root at worst), and list up to 10 of that ancestor's direct child folders from the index, sorted, in the index's casing.
4. Select, per step, from files whose `library` is undefined: direct children of the folder (or any descendant when `recursive`), then each filter present, all compared ignoring case (`extensions` normalized to a leading dot), dates compared with `Date.parse`, `modifiedAfter` exclusive and `modifiedBefore` exclusive. Record `perStep[i]` as that step's match count.
5. Refuse `ambiguous_set_name` for any step using `setName` with a match count above 1.
6. Count distinct matched paths across steps. Zero refuses `nothing_matched`; above `MAX_CUSTOM_PLAN_FILES` refuses `too_many_files`.
7. A path matched by two or more steps becomes one `matched_by_multiple_steps` exclusion (`targetName` its current name, `steps` all its step numbers) and nothing else.
8. For every other match compute the target: `splitName` the name; `setName` uses the given name; `replace` applies `stem.split(find).join(with)` and keeps the extension; `addPrefix` prepends to the whole name; `addSuffix` appends to the stem; no rename keeps the name. The folder is the resolved `moveTo` casing or the file's own folder. Then exclude, first match wins:
   - `no_change` when the target path equals the source path exactly;
   - `extension_would_change` when `splitName(target).extension !== splitName(source).extension` (exact comparison: a case-only extension change is still a change);
   - `invalid_target_name` when `invalidNameReason(targetName, targetFolder === "")` returns a reason;
   - `target_path_already_occupied` when the lowercased target path is a lowercased path of any local file in the snapshot and is not the file's own path, which includes a file this plan would move away, since chains are not ordered.
9. Group the remaining candidates by lowercased target path; every group of two or more becomes `two_items_share_one_target` exclusions, each carrying the union of the group's steps.
10. Return items and exclusions each sorted by `path`.

Every exported function and each rule carries a short comment saying why, in the style of `src/domain/move/plan.ts`.

- [ ] **Step 6: Run tests, lint, typecheck, full suite, commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/domain/custom tests/domain/custom
git commit -m "feat(domain): resolve operator-written plan steps against the repository index"
```

---

## Task 4: Stored plans of kind `custom`

**Files:**
- Modify: `src/store/types.ts`, `src/store/table.ts`, `src/store/memory.ts`, `src/tools/rename/ids.ts`
- Test: `tests/store/conformance.ts` (one added test), `tests/store/plans.errors.test.ts` (one added test)

**Interfaces:**
- Consumes: `CustomStep`, `CustomExclusionReason` (Task 3), type-only imports into `src/store/types.ts`.
- Produces:
  - `PlanKind = "rename" | "move" | "custom"`
  - `AnyExclusionReason = MoveExclusionReason | CustomExclusionReason`; `ExcludedPlanItem<R extends string = AnyExclusionReason>` gains optional `steps?: number[]`
  - `RenamePlanItem` gains optional `step?: number`
  - `StoredPlan` gains optional `steps?: CustomStep[]`
  - `PlanIdPrefix` gains `"cus"`

- [ ] **Step 1: Write the failing tests**

In `tests/store/conformance.ts`, add a round-trip for a plan with `kind: "custom"`, one item carrying `step: 1` and `client: ""`, one exclusion with `reason: "matched_by_multiple_steps"` and `steps: [1, 2]`, and `steps` holding two `CustomStep` objects, asserting `getPlan` returns it `toEqual` the saved plan. In `tests/store/plans.errors.test.ts`, add: a stored entity whose `steps` column is present but not a JSON array is refused with `MalformedPlanEntityError` naming `steps`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/store`
Expected: FAIL (the Table reader refuses kind `custom`).

- [ ] **Step 3: Implement**

- `src/store/types.ts`: the type changes listed above. `client` stays required on items and exclusions; a custom plan writes `""` because it has no client, and a comment says so. `MAX_PLAN_JSON_CHARS`'s comment now says the measured total is `items`, `excluded` and `steps` combined.
- `src/store/table.ts`: the kind check accepts `"custom"` and its message names all three kinds; `savePlan` writes `steps` as a JSON string column only when present and adds its length to the size total; `getPlan` reads it when present, requiring a JSON array (reuse `requiredPlanJsonArray` behind a presence check), and omits the key when absent so a plan of the other kinds reads back unchanged.
- `src/store/memory.ts`: add `steps` to its size total the same way.
- `src/tools/rename/ids.ts`: `PlanIdPrefix = "rnm" | "mov" | "cus" | "rev"`.

Typecheck will now report places that pass `plan.excluded` into an output typed with a narrower reason. `execute_rename_plan` and `execute_move_plan` already narrow through `renameExclusionsOf` and `moveExclusionsOf`; if either still errors, narrow the same way. No behavior changes.

- [ ] **Step 4: Run tests, lint, typecheck, full suite, commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/store src/tools/rename/ids.ts tests/store
git commit -m "feat(store): persist custom plans with the steps an operator wrote"
```

---

## Task 5: `generate_custom_plan`

**Files:**
- Create: `src/tools/custom/output.ts`, `src/tools/custom/text.ts`, `src/tools/custom/generate.ts`, `src/tools/definitions/generate-custom-plan.ts`, `tests/tools/custom/fixtures.ts`
- Modify: `src/tools/registry.ts`
- Test: `tests/tools/custom/generate.test.ts`, `tests/tools/custom/generate.errors.test.ts`, `tests/tools/custom/generate.wire.test.ts`

**Interfaces:**
- Consumes: `resolveCustomPlan`, `CustomStep`, `MAX_CUSTOM_PLAN_FILES` (Task 3); `fetchPlanEtags`, `comparePaths`, `MAX_PLAN_ITEMS_LISTED` (existing, `src/tools/plans/`); `getAny` (Task 1); `newPlanId("cus", now)` (Task 4).
- Produces: `GENERATE_CUSTOM_PLAN_INPUT_SCHEMA`, `GENERATE_CUSTOM_PLAN_OUTPUT_SCHEMA`, `CUSTOM_EXCLUSION_REASONS`, `type GenerateCustomPlanOutput`, `runGenerateCustomPlan(input, context, makePlanId?)`, `generateCustomPlanText(output)`, `CUSTOM_PLAN_INPUT_CONSTRAINTS`.

- [ ] **Step 1: Write the fixtures and failing tests**

`tests/tools/custom/fixtures.ts`: a context whose registry holds `examples/profiles/example.json` and `examples/profiles/library-example.json` (site `https://contoso.sharepoint.com/sites/Example`), whose scan coordinator returns a snapshot built with `file()` and `snapshot()` from `tests/tools/rename/fixtures.ts` over the same `FOLDERS` and `FILES` as Task 3, and whose Graph client is `etagGraphClient` from the same file, keyed by those paths.

`tests/tools/custom/generate.test.ts`, each a separate `it`:
1. For the library profile `shared-docs`, a step moving PDFs from `/Client A/2025` to `/Archive/2025` stores a plan of kind `custom` whose `steps` equal the input, whose items carry `step: 1`, and whose output lists both items and `perStep: [2]`; `etagLookupsIssued` is 2.
2. The same request works for the compliance profile `example`.
3. The text names each move as `source -> target`, reports the plan id, and ends pointing at `execute_custom_plan` with the dry-run default.

`tests/tools/custom/generate.errors.test.ts`, each asserting `isError: true`, no plan stored (`store.getPlan` on the injected id is undefined), and the text:
1. unknown folder: names the requested folder, the nearest existing folder and its children;
2. ambiguous `setName`: names the match count;
3. too many files: names the total, the limit and each step's count, and says nothing was fetched or saved;
4. nothing matched: names each step's zero;
5. invalid step: names the step and the rule;
6. an exclusion does not refuse: a `matched_by_multiple_steps` case still stores a plan, lists the exclusion with its steps, and spends no ETag lookup on the excluded file.

`tests/tools/custom/generate.wire.test.ts`: copy `tests/tools/move/generate.wire.test.ts`, substituting this tool's definition, handler, name and a `cus-` plan id, keeping both of its tests.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/tools/custom/generate`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/tools/custom/output.ts`**

Mirror `src/tools/move/output.ts`'s generate half:
- `CUSTOM_EXCLUSION_REASONS` = the six `CustomExclusionReason`s plus `"no_etag_available"` and `"file_not_found_at_plan_time"`, with an `AssertNever` exhaustiveness check against `CustomExclusionReason | EtagExclusionReason`.
- `GenerateCustomPlanOutput`: `planId`, `profileId`, `library`, `driveId`, `createdAt`, `scannedAt`, `perStep: number[]`, `items: Array<{ path; currentName; targetName; targetPath; step: number }>`, `itemCount`, `itemsOmitted`, `excluded: Array<{ path; currentName; targetName; reason; steps: number[] }>`, `excludedCount`, `excludedOmitted`, `etagLookupsIssued`, `scanGraphRequestsByThisCall`, `scanSharedWithConcurrentCall`.
- `GENERATE_CUSTOM_PLAN_OUTPUT_SCHEMA` with a description on every field in the style of the move schema; `excluded`'s description explains each reason in one clause.

- [ ] **Step 4: Write `src/tools/custom/generate.ts`**

Input schema (every field "for example"; nested objects allowed; no refinement):

```ts
const SelectorSchema = z.object({
  folder: z.string().describe('Library-relative folder to select files from, for example "/Client A/2025". "/" is the library root.'),
  recursive: z.boolean().optional().describe("Also select files in subfolders, for example true. Defaults to false."),
  nameEquals: z.string().min(1).optional().describe('Exact file name, ignoring case, for example "notes.docx".'),
  nameContains: z.string().min(1).optional().describe('Text the file name contains, ignoring case, for example "draft".'),
  extensions: z.array(z.string().min(1)).optional().describe('File extensions to select, for example [".pdf", ".docx"].'),
  modifiedAfter: z.string().optional().describe('Only files modified after this ISO 8601 date, for example "2025-01-01".'),
  modifiedBefore: z.string().optional().describe('Only files modified before this ISO 8601 date, for example "2026-01-01".'),
});

const RenameSchema = z.object({
  setName: z.string().min(1).optional().describe('New full name, for a selector matching exactly one file, for example "2026-05 Client A.pdf".'),
  replace: z
    .object({
      find: z.string().min(1).describe('Literal text to find in the name, for example "DRAFT".'),
      with: z.string().describe('Literal replacement, for example "FINAL". May be empty.'),
    })
    .optional()
    .describe('Replace literal text in the name, keeping the extension, for example {"find": "DRAFT", "with": "FINAL"}.'),
  addPrefix: z.string().min(1).optional().describe('Text to put before the name, for example "2025 ".'),
  addSuffix: z.string().min(1).optional().describe('Text to put before the extension, for example " v2".'),
});

export const GENERATE_CUSTOM_PLAN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('Configured profile to plan against, for example "shared-docs".'),
  steps: z
    .array(
      z.object({
        selector: SelectorSchema.describe("Which files this step selects; every field given must match."),
        moveTo: z.string().optional().describe('Existing library-relative folder to move the files into, for example "/Archive/2025".'),
        rename: RenameSchema.optional().describe('How to rename the files; give exactly one form, for example {"addPrefix": "2025 "}.'),
      }),
    )
    .min(1)
    .max(20)
    .describe('One to 20 steps, each a selector and an action, for example [{"selector": {"folder": "/Client A/2025", "extensions": [".pdf"]}, "moveTo": "/Archive/2025"}].'),
} satisfies z.ZodRawShape;

export const CUSTOM_PLAN_INPUT_CONSTRAINTS =
  "Each step needs moveTo, rename, or both. rename takes exactly one of setName, replace, addPrefix or addSuffix. " +
  "setName is allowed only when the step's selector matches exactly one file.";
```

If the contract test's "for example" rule walks nested fields and rejects a description, adjust the wording, never the rule.

The handler, structured like `src/tools/move/generate.ts`:
1. `const profile = context.profiles.getAny(args.profileId)`; set `subject.siteUrl` and `subject.library`.
2. `const scan = await context.scans.run(profile)`.
3. `const resolution = resolveCustomPlan(args.steps, scan.result.snapshot)`. The zod-parsed steps are structurally a `CustomStep[]`; strip `undefined` optionals if `exactOptionalPropertyTypes` demands it.
4. On a refusal, return `isError: true` with text built by a `refusalText(refusal)` function in `src/tools/custom/text.ts`. Each ends "No plan was saved." and the too-many and unknown-folder cases also say no ETag was fetched. The unknown-folder text lists the children; nothing matched lists each step's count.
5. Otherwise fetch ETags for the items only, through `fetchPlanEtags`, carrying `step` through (items from `fetchPlanEtags` lose extra fields; re-attach `step` by path).
6. Persist a `StoredPlan` of kind `custom` with `client: ""` on every item and exclusion, `steps: args.steps`, items and exclusions sorted by path.
7. Build the output and the text as the move generator does. `etagLookupsIssued` is the number of items sent to `fetchPlanEtags`.

- [ ] **Step 5: Write `src/tools/custom/text.ts` and the definition**

`generateCustomPlanText` mirrors `generateMovePlanText`: one line per item `  ${path} -> ${targetPath} (step ${step})`, exclusions with reason and steps, and the closing line "Review this plan, then apply it with execute_custom_plan. It runs as a dry run unless confirm is true."

`src/tools/definitions/generate-custom-plan.ts`:

```ts
export const generateCustomPlan: ToolDefinition = {
  name: "generate_custom_plan",
  kind: "plan",
  title: "Generate a plan from steps you describe",
  description: [
    "Produce a reviewable plan that renames or moves files you describe with selectors, inside the profile's own document library, with no tracking workbook required. Works with a library-only profile or a compliance profile.",
    "Each step selects files by folder, name, extension or modified date, and moves them to an existing folder, renames them with a literal edit, or both. The server resolves every step against its index of the library, so the plan names exact files; file extensions never change.",
    "A request it cannot resolve is refused with evidence and no plan is saved: an unknown folder (with the nearest existing folder and its subfolders), an ambiguous setName, more than 100 files, or nothing matched. A file it cannot safely change is kept in the plan as excluded, with the reason.",
    CUSTOM_PLAN_INPUT_CONSTRAINTS,
    "Returns a plan id that execute_custom_plan consumes. Review the plan before executing it.",
    SAFETY_SENTENCES.plan,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(GENERATE_CUSTOM_PLAN_INPUT_SCHEMA),
  inputConstraints: CUSTOM_PLAN_INPUT_CONSTRAINTS,
  outputSchema: GENERATE_CUSTOM_PLAN_OUTPUT_SCHEMA,
  handler: runGenerateCustomPlan,
};
```

Add it to `ALL_TOOLS` in `src/tools/registry.ts` after `executeMovePlan`. In `tests/tools/contract.test.ts`, add `"generate_custom_plan"` to `EXPECTED_TOOL_NAMES` and rename the test "registers exactly the ten planned tools" to "registers exactly the planned tools"; change nothing else there.

- [ ] **Step 6: Run tests, lint, typecheck, full suite, commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/tools/custom src/tools/definitions/generate-custom-plan.ts src/tools/registry.ts tests/tools/custom tests/tools/contract.test.ts
git commit -m "feat(tools): wire generate_custom_plan"
```

---

## Task 6: `execute_custom_plan`, and the registry-wide profile-kind test

**Files:**
- Create: `src/tools/custom/execute.ts`, `src/tools/definitions/execute-custom-plan.ts`, `tests/tools/profile-kinds.test.ts`
- Modify: `src/tools/custom/output.ts`, `src/tools/custom/text.ts`, `src/tools/registry.ts`, `tests/tools/contract.test.ts`
- Test: `tests/tools/custom/execute.test.ts`, `tests/tools/custom/execute.errors.test.ts`, `tests/tools/custom/execute.wire.test.ts`

**Interfaces:**
- Consumes: `applyPlan`, `AppliedOutcome`, `comparePaths` (`src/tools/plans/apply.ts`); `noPlanStored`, `wrongPlanKind` (`src/tools/plans/refusals.ts`); `movingLibraryGraphClient` (`tests/tools/move/fixtures.ts`).
- Produces: `EXECUTE_CUSTOM_PLAN_INPUT_SCHEMA`, `EXECUTE_CUSTOM_PLAN_OUTPUT_SCHEMA`, `CUSTOM_ITEM_OUTCOMES = ["applied", "would_apply", "precondition_refused", "target_name_taken", "not_found", "failed"]`, `runExecuteCustomPlan(input, context, makeReversalPlanId?)`, `executeCustomPlanText(output)`.

- [ ] **Step 1: Write the failing tests**

`tests/tools/custom/execute.test.ts`, over `movingLibraryGraphClient` holding the fixture files and folders:
1. A dry run reports `would_apply` for every item and makes zero Graph requests.
2. A confirmed run moves and renames the files (the fake's `paths()` shows the targets), and its reversal plan, of kind `custom` with `reverses` set and no `steps`, moves them back when executed through this same tool.

`tests/tools/custom/execute.errors.test.ts`:
1. A rename plan and a move plan are each refused, naming the right execute tool, with zero Graph requests.
2. An unknown plan id is refused with zero Graph requests.
3. A custom plan whose stored exclusion carries an unknown reason is refused before any write (validate exclusions before `applyPlan`, as the move and rename executors do), with zero Graph requests.
4. A file edited after planning is `precondition_refused` while the others apply.
5. A file that arrived at a target after planning is `target_name_taken`, and nothing is replaced.

`tests/tools/custom/execute.wire.test.ts`: copy `tests/tools/move/execute.wire.test.ts` with this tool substituted, keeping every test.

`tests/tools/profile-kinds.test.ts`, the registry-wide rule from the spec's amendment 3:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ALL_TOOLS } from "../../src/tools/registry.js";
import { createProfileRegistry } from "../../src/profiles/registry.js";
import { createFakeToolContext } from "./fake-context.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";
const REQUIRES_COMPLIANCE = new Set([
  "reconcile_workbook_vs_repository",
  "validate_structure",
  "generate_rename_plan",
  "execute_rename_plan",
  "generate_move_plan",
  "execute_move_plan",
  "replicate_template",
]);
const ACCEPTS_LIBRARY = new Set(["inventory_tree", "query_repository", "generate_custom_plan", "execute_custom_plan"]);
const TAKES_NO_PROFILE = new Set(["describe_workbook"]);

describe("which tools accept a library-only profile", () => {
  it("places every registered tool in exactly one set", () => {
    for (const tool of ALL_TOOLS) {
      const memberships = [REQUIRES_COMPLIANCE, ACCEPTS_LIBRARY, TAKES_NO_PROFILE].filter((set) => set.has(tool.name)).length;
      expect(memberships, `${tool.name} must be classified here; a new tool has to choose`).toBe(1);
    }
  });

  it("refuses a library-only profile before any Graph request in every tool that needs a compliance profile", async () => {
    const profiles = createProfileRegistry(
      [
        { source: "example.json", contents: JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) },
        { source: "library-example.json", contents: JSON.parse(readFileSync("examples/profiles/library-example.json", "utf8")) },
      ],
      SITE,
    );
    for (const tool of ALL_TOOLS.filter((t) => REQUIRES_COMPLIANCE.has(t.name) && t.handler !== undefined)) {
      const context = createFakeToolContext({ profiles });
      const input = { profileId: "shared-docs", planId: "rnm-2026-09-24-00000000", sourceClient: "A", targetClients: ["B"] };
      const result = await tool.handler!(input, context);

      expect(result.isError, tool.name).toBe(true);
      expect(context.graph.requests(), tool.name).toBe(0);
    }
  });
});
```

Stubs without a handler (`replicate_template`) are skipped by the filter and still classified; the tool's input parse must accept the shared input object, so if a handler's strict parse rejects extra keys, build the input per tool from its own schema's required fields.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/tools/custom/execute tests/tools/profile-kinds.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `src/tools/custom/output.ts`: the execute half, mirroring `src/tools/move/output.ts` with `CUSTOM_ITEM_OUTCOMES`, `counts: { applied, wouldApply, preconditionRefused, targetNameTaken, notFound, failed }`, results carrying `step` when the item has one, and the same outcome descriptions the move schema now uses, including the widened `failed` wording.
- `src/tools/custom/execute.ts`: structure it as `src/tools/move/execute.ts`: `getAny` for the profile (a library profile is valid here); refuse an absent plan with `noPlanStored(..., "generate_custom_plan")`; refuse a plan whose kind is not `custom` with `wrongPlanKind(plan, "custom")`; validate exclusions against `CUSTOM_EXCLUSION_REASONS` with `MalformedPlanEntityError` BEFORE `applyPlan`; then `applyPlan` with `toolName: "execute_custom_plan"`; map outcomes one to one (`applied` and `would_apply` keep their names).
- `executeCustomPlanText` in `src/tools/custom/text.ts`, mirroring `executeMovePlanText`, with "applied" for the verb.
- `src/tools/definitions/execute-custom-plan.ts`: `kind: "write"`, `destructiveHint: true`, a description in the style of `execute-move-plan.ts` saying it applies a plan from `generate_custom_plan`, that each write carries the ETag from plan time, that a move never replaces a file at its target, that renames and moves stay inside the profile's own library, that it runs as a dry run unless confirm is true, and `SAFETY_SENTENCES.destructiveWrite`.
- `src/tools/registry.ts`: add it after `generateCustomPlan`. `tests/tools/contract.test.ts`: add `"execute_custom_plan"` to `EXPECTED_TOOL_NAMES`.

- [ ] **Step 4: Run tests, lint, typecheck, full suite, commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/tools/custom src/tools/definitions/execute-custom-plan.ts src/tools/registry.ts tests/tools/custom tests/tools/profile-kinds.test.ts tests/tools/contract.test.ts
git commit -m "feat(tools): wire execute_custom_plan and pin which tools accept a library-only profile"
```

---

## Task 7: Live sitting and documents (controller-run)

**Operator prerequisite:** the grant issuer's secret expires 2026-10-01; after that, run `--create-bootstrap` first. The grant is widened to write for the sitting and restored to read at the end.

- [ ] **Step 1: A library-only profile on the sandbox**

Add `profiles/archive.json` (gitignored): `{"kind":"library","profileId":"archive","identity":{"siteUrl":"<sandbox>","library":"Archive"}}`. Start the server from source with writes enabled, under `timeout`, and confirm both profiles load.

- [ ] **Step 2: The sitting**

Through `.superpowers/live-sitting/call-tool.ts`:
1. `inventory_tree` on `archive` answers; `reconcile_workbook_vs_repository` and `validate_structure` on `archive` refuse naming the profile as library-only; `query_repository` answers `empty_folders` and refuses `naming_violations`.
2. `generate_custom_plan` with an unknown folder is refused with suggestions drawn from the real index.
3. On the compliance profile's `Documents` library, seed a scratch folder with a few files and a subfolder (as the 6b-1 sitting did with `g.ts`), then generate a mixed plan: a multi-file move by extension, a prefix rename, a single `setName`, and one move plus rename in one step. Read it.
4. Dry run, confirmed run, confirm with `inventory_tree`, roll back through the reversal plan, confirm again.
5. Generate again, edit one planned file, execute: that item alone is `precondition_refused`.
6. Observe a `matched_by_multiple_steps` and a `target_path_already_occupied` exclusion from real data.
7. Remove the scratch folder's seeded content, restore the grant to read, stop the server this session started.

- [ ] **Step 3: Documents, one commit with the sitting's record**

- `CLAUDE.md`: amend the Mission to say the product also covers general file work inside a granted site through operator-authored plans, still path-native and plan-then-execute, never per-call Graph wrappers; the Tool Set table gains the two custom tools, with a sentence on profile kinds; the Build Sequence gains a 6d entry recording completion and the sitting.
- `docs/superpowers/specs/2026-09-11-repository-reconciliation-mcp-design.md`: the tool table gains the two tools.
- `docs/SETUP.md`: a library-only profile example and which tools work with it.
- `docs/OPEN-ITEMS.md`: the sitting's record and what it did not establish; the deferred operations from the spec (folder creation, deletion, cross-library, folder selection, chains and swaps, regex and templates), noting the recycle-bin idea from the prior-art read under folder creation for 6c.

```bash
npm run lint && npm run typecheck && npm test
git add CLAUDE.md docs
git commit -m "docs: record phase 6d and its live sitting"
```

---

## What the controller owes after the last task

A whole-branch review aimed at the joins: that every tool classified as needing a compliance profile really refuses a library one before any Graph request; that a library profile's scan never runs the cross-check; that the resolver's exclusions and refusals state only what it observed; that `execute_custom_plan` validates before writing; and that the two custom tools' descriptions match their behavior. Then a PR.
