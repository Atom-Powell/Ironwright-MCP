# Phase 9b: Core Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server becomes a core that hosts domain modules: tools are the union of what the modules register, a profile addresses a set of sites, every request is authenticated at the door, a fourth tool kind exists for lifecycle writes, and the store can journal them. Compliance and library keep answering exactly as they do today.

**Architecture:** A `DomainModule` is one object per kind (its profile schema and its tools) under `src/modules/<kind>/`; the pure domain code stays under `src/domain/` where the lint rule already guards it. The profile loaders accept `sites` alongside the old `identity` and normalize one into the other before validation, so eighteen existing consumers of `profile.identity` are untouched. Inbound authentication is the probe server's key check lifted into `src/server/auth.ts` and wired in front of `/mcp`. The journal is a new pair of methods on `StateStore` with both implementations. Nothing in this plan calls Graph in a new way, which is why it needs no probe and can run in parallel with plan 9a.

**Tech Stack:** TypeScript, Node 22, express 5, zod, vitest, supertest, `@azure/data-tables` behind the existing `TableClientLike` seam.

## Global Constraints

From `CLAUDE.md` and the spec at `docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md`:

- **No em dashes and no en dashes anywhere**, including string literals, comments and commit messages. `tests/source-hygiene.test.ts` enforces it.
- **No emojis. US English.**
- **The domain layer is pure.** `src/domain/**` imports zod and its own siblings only; the eslint rule enforces it. New pure code goes there, wiring goes elsewhere.
- **A message states only what the code observed.**
- **Never log the inbound key**, in any message, trace or error.
- **Existing tests pass unedited except where a task names the edit.** The registry test in Task 2 is the proof that the module move changed nothing.
- **Every profile written before this plan loads unchanged.** `examples/profiles/example.json` and `library-example.json` are not edited.
- **Test file naming:** happy path in `X.test.ts`, failures in `X.errors.test.ts`.
- **Conventional commits**, each ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `npm run lint`, `npm run typecheck` and `npm test` before every commit.

One deviation from the spec's wording, recorded here and to be noted in the spec's amendments section at the end of this plan: the spec says compliance and library tools move under `src/modules/`. This plan establishes the module boundary with module objects that reference the existing definition files in place, and defers the physical relocation. Moving twelve definition files and their handler folders is a large rename-only diff that would make the weekend's review harder and prove nothing the registry test does not already prove. The boundary is what matters, and the files can follow in a rename-only commit later.

---

## File Structure

**Created:**
- `src/tools/kinds.ts` gains `lifecycle` (modified, not created).
- `src/modules/types.ts`: the `DomainModule` interface.
- `src/modules/compliance/index.ts`, `src/modules/library/index.ts`, `src/modules/index.ts`.
- `src/domain/profile/base.ts`: `SiteEntrySchema`, `normalizeProfileSites`.
- `src/server/auth.ts`: inbound authentication middleware and its config loader.
- `tests/tools/modules.test.ts`, `tests/domain/profile/base.test.ts`, `tests/domain/profile/base.errors.test.ts`, `tests/profiles/modules-dispatch.test.ts`, `tests/profiles/modules-dispatch.errors.test.ts`, `tests/server/auth.test.ts`, `tests/server/auth.errors.test.ts`, `tests/server/disconnect.test.ts`.

**Modified:**
- `src/tools/kinds.ts`, `src/tools/registry.ts`, `tests/tools/contract.test.ts`.
- `src/domain/profile/schema.ts`, `src/domain/profile/library.ts`, `src/domain/profile/load.ts`.
- `src/profiles/registry.ts`.
- `src/server/app.ts`, `src/server/main.ts`, `src/config.ts`.
- `scripts/copilot-probe/app.ts` (uses the core middleware).
- `src/store/types.ts`, `src/store/memory.ts`, `src/store/table.ts`, `tests/store/conformance.ts`, `tests/store/fake-table-client.ts` if it needs a fourth table.
- `docs/SETUP.md`, `docs/OPEN-ITEMS.md`, the spec (amendments section).

---

## Task 1: The lifecycle tool kind

**Files:**
- Modify: `src/tools/kinds.ts`
- Test: `tests/tools/contract.test.ts`

**Interfaces:**
- Produces: `ToolKind` includes `"lifecycle"`; `SAFETY_SENTENCES.lifecycle`; `requiredSentence("lifecycle", false)` returns it. Plan 9c's tools use these.

- [ ] **Step 1: Write the failing tests.** In `tests/tools/contract.test.ts`, inside `describe("safety sentences")`, extend the first test and the second:

```ts
    expect(SAFETY_SENTENCES.lifecycle).toBe(
      "Not read-only: this tool advances an assessment by one stage when its preconditions hold. It creates records and files only at paths the server computes, overwrites only files it created and only under an ETag precondition, refuses when the prior stage is not verified, and records every write in the assessment journal. It needs no confirm flag and is safe to retry: a stage already completed is reported, not repeated.",
    );
```

```ts
    expect(requiredSentence("lifecycle", false)).toBe(SAFETY_SENTENCES.lifecycle);
```

And in `describe("tool contract")`, extend the "annotations consistent with its kind" test body:

```ts
      if (tool.kind === "lifecycle") {
        expect(tool.annotations.destructiveHint).toBe(false);
        expect(tool.annotations.idempotentHint).toBe(true);
      }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools/contract.test.ts`
Expected: FAIL, `SAFETY_SENTENCES.lifecycle` is undefined.

- [ ] **Step 3: Implement**

In `src/tools/kinds.ts`:

```ts
export type ToolKind = "read" | "plan" | "write" | "lifecycle";
```

Add to `SAFETY_SENTENCES`:

```ts
  lifecycle:
    "Not read-only: this tool advances an assessment by one stage when its preconditions hold. It creates records and files only at paths the server computes, overwrites only files it created and only under an ETag precondition, refuses when the prior stage is not verified, and records every write in the assessment journal. It needs no confirm flag and is safe to retry: a stage already completed is reported, not repeated.",
```

And in `requiredSentence`, before the write branch:

```ts
  if (kind === "lifecycle") return SAFETY_SENTENCES.lifecycle;
```

Update the doc comment above `SAFETY_SENTENCES` with one sentence: a lifecycle tool is gated by live preconditions and a journal rather than a dry run, per the 2026-11-06 Decision Record amendment.

- [ ] **Step 4: Run the whole tools suite**

Run: `npx vitest run tests/tools`
Expected: PASS. `selectTools` in `src/tools/registry.ts` filters `kind !== "write"`, so a lifecycle tool would currently pass the write gate. Fix that in the same task: change the filter to `tool.kind !== "write" && tool.kind !== "lifecycle"`, and add to `tests/tools/write-gate.test.ts` a fixture tool of kind `lifecycle` and an assertion that `selectTools(false, [fixture])` is empty and `selectTools(true, [fixture])` contains it. The write gate's comment says it is the one place the predicate is written; keep it that way.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/tools/kinds.ts src/tools/registry.ts tests/tools/contract.test.ts tests/tools/write-gate.test.ts
git commit -m "feat(tools): add the lifecycle tool kind and gate it with writes"
```

---

## Task 2: Domain modules and the registry union

**Files:**
- Create: `src/modules/types.ts`, `src/modules/compliance/index.ts`, `src/modules/library/index.ts`, `src/modules/index.ts`
- Modify: `src/tools/registry.ts`
- Test: `tests/tools/modules.test.ts`

**Interfaces:**
- Produces:

```ts
// src/modules/types.ts
export interface DomainModule {
  kind: ProfileKind;                         // "compliance" | "library" (plan 9c adds "assessment")
  profileSchema: z.ZodTypeAny;               // validates a normalized profile of this kind
  tools: ToolDefinition[];
}
export const ALL_MODULES: DomainModule[];     // src/modules/index.ts
```
- `ProfileKind` is defined in Task 3 (`src/domain/profile/base.ts`). For this task, declare it locally in `src/modules/types.ts` as `"compliance" | "library"` and Task 3 replaces the local type with the import.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/modules.test.ts
import { describe, expect, it } from "vitest";
import { ALL_MODULES } from "../../src/modules/index.js";
import { ALL_TOOLS } from "../../src/tools/registry.js";

describe("domain modules", () => {
  it("registers compliance and library, each with a distinct kind", () => {
    expect(ALL_MODULES.map((m) => m.kind)).toEqual(["compliance", "library"]);
  });

  it("owns every tool exactly once across modules", () => {
    const names = ALL_MODULES.flatMap((m) => m.tools.map((t) => t.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it("is the source of the registry's tool list, in module order", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toEqual(ALL_MODULES.flatMap((m) => m.tools.map((t) => t.name)));
  });

  it("keeps the twelve tools that existed before modules did, under the same names", () => {
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "inventory_tree", "describe_workbook", "reconcile_workbook_vs_repository", "query_repository", "validate_structure",
        "generate_rename_plan", "execute_rename_plan", "generate_move_plan", "execute_move_plan",
        "generate_custom_plan", "execute_custom_plan", "replicate_template",
      ].sort(),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tools/modules.test.ts`
Expected: FAIL, cannot find `src/modules/index.js`.

- [ ] **Step 3: Implement**

```ts
// src/modules/types.ts
import type { z } from "zod";
import type { ToolDefinition } from "../tools/types.js";

export type ProfileKind = "compliance" | "library";

/**
 * One domain, as the core sees it: which profile kind it owns, how to
 * validate that kind, and which tools it registers. The core knows nothing
 * else about a domain. A tool may accept profiles of other kinds (inventory
 * works over a compliance profile too); ownership here is about which module
 * registers it, and acceptance is declared per tool and pinned by
 * tests/tools/profile-kinds.test.ts.
 */
export interface DomainModule {
  kind: ProfileKind;
  profileSchema: z.ZodTypeAny;
  tools: ToolDefinition[];
}
```

```ts
// src/modules/compliance/index.ts
import { ProfileSchema } from "../../domain/profile/schema.js";
import type { DomainModule } from "../types.js";
import { describeWorkbook } from "../../tools/definitions/describe-workbook.js";
import { reconcileWorkbookVsRepository } from "../../tools/definitions/reconcile.js";
import { validateStructure } from "../../tools/definitions/validate-structure.js";
import { generateRenamePlan } from "../../tools/definitions/generate-rename-plan.js";
import { executeRenamePlan } from "../../tools/definitions/execute-rename-plan.js";
import { generateMovePlan } from "../../tools/definitions/generate-move-plan.js";
import { executeMovePlan } from "../../tools/definitions/execute-move-plan.js";
import { replicateTemplate } from "../../tools/definitions/replicate-template.js";

/**
 * Recurring-deliverable compliance: the original domain and still the
 * centerpiece. Its definitions stay where phases 4 and 6 put them; this
 * object is the boundary, and a rename-only move can follow.
 */
export const complianceModule: DomainModule = {
  kind: "compliance",
  profileSchema: ProfileSchema,
  tools: [
    describeWorkbook,
    reconcileWorkbookVsRepository,
    validateStructure,
    generateRenamePlan,
    executeRenamePlan,
    generateMovePlan,
    executeMovePlan,
    replicateTemplate,
  ],
};
```

```ts
// src/modules/library/index.ts
import { LibraryProfileSchema } from "../../domain/profile/library.js";
import type { DomainModule } from "../types.js";
import { inventoryTree } from "../../tools/definitions/inventory-tree.js";
import { queryRepository } from "../../tools/definitions/query-repository.js";
import { generateCustomPlan } from "../../tools/definitions/generate-custom-plan.js";
import { executeCustomPlan } from "../../tools/definitions/execute-custom-plan.js";

/**
 * A site and a library with no compliance definition. Owns the tools that
 * work over any site profile; compliance profiles use them too.
 */
export const libraryModule: DomainModule = {
  kind: "library",
  profileSchema: LibraryProfileSchema,
  tools: [inventoryTree, queryRepository, generateCustomPlan, executeCustomPlan],
};
```

```ts
// src/modules/index.ts
import { complianceModule } from "./compliance/index.js";
import { libraryModule } from "./library/index.js";
import type { DomainModule } from "./types.js";

export type { DomainModule, ProfileKind } from "./types.js";

/** Module order is tool order in the registry; the contract test pins the names, not the order. */
export const ALL_MODULES: DomainModule[] = [complianceModule, libraryModule];

export function moduleForKind(kind: string, modules: readonly DomainModule[] = ALL_MODULES): DomainModule | undefined {
  return modules.find((m) => m.kind === kind);
}
```

In `src/tools/registry.ts`, replace the twelve imports and the literal array with:

```ts
import { ALL_MODULES } from "../modules/index.js";

export const ALL_TOOLS: ToolDefinition[] = ALL_MODULES.flatMap((module) => module.tools);
```

Keep `selectTools` and its comment exactly as they are.

- [ ] **Step 4: Run the whole suite.** The order of `ALL_TOOLS` changes (compliance tools first, then library). `tests/tools/contract.test.ts` sorts before comparing, so it passes. Any test that asserted order fails here and is the one place order was silently depended on; fix that test to sort, and say so in the commit.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck
git add src/modules src/tools/registry.ts tests/tools/modules.test.ts
git commit -m "feat(core): register tools through domain modules"
```

---

## Task 3: Profile base and site sets

**Files:**
- Create: `src/domain/profile/base.ts`
- Modify: `src/domain/profile/schema.ts`, `src/domain/profile/library.ts`, `src/domain/profile/load.ts`, `src/modules/types.ts` (import `ProfileKind`)
- Test: `tests/domain/profile/base.test.ts`, `tests/domain/profile/base.errors.test.ts`

**Interfaces:**
- Produces:

```ts
// src/domain/profile/base.ts
export const PROFILE_KINDS = ["compliance", "library"] as const;   // plan 9c appends "assessment"
export type ProfileKind = (typeof PROFILE_KINDS)[number];
export const SiteEntrySchema: z.ZodObject<...>;   // { siteUrl, library, searchRegion?, clientId?, workbookPath? }
export type SiteEntry = z.infer<typeof SiteEntrySchema>;
export function normalizeProfileSites(input: unknown): unknown;
```
- After this task every parsed profile of any kind has both `identity` (the first site, as today) and `sites` (the full list). Consumers keep reading `identity`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/domain/profile/base.test.ts
import { describe, expect, it } from "vitest";
import { normalizeProfileSites, SiteEntrySchema } from "../../../src/domain/profile/base.js";
import { loadAnyProfile } from "../../../src/domain/profile/library.js";
import { readFileSync } from "node:fs";

const example = () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;
const libraryExample = () => JSON.parse(readFileSync("examples/profiles/library-example.json", "utf8")) as Record<string, unknown>;

describe("normalizeProfileSites", () => {
  it("turns a legacy identity into a one-entry sites list and keeps identity", () => {
    const out = normalizeProfileSites(example()) as { identity: unknown; sites: unknown[] };
    expect(out.sites).toEqual([out.identity]);
  });

  it("derives identity from the first site when only sites is given", () => {
    const input = { ...example() };
    const identity = input.identity;
    delete input.identity;
    input.sites = [identity, { ...(identity as object), siteUrl: "https://contoso.sharepoint.com/sites/Second" }];
    const out = normalizeProfileSites(input) as { identity: unknown; sites: unknown[] };
    expect(out.identity).toEqual(identity);
    expect(out.sites).toHaveLength(2);
  });

  it("leaves a non-object alone for the schema to reject", () => {
    expect(normalizeProfileSites("nope")).toBe("nope");
  });
});

describe("profiles with sites", () => {
  it("a compliance profile written with sites loads, and identity is its first site", () => {
    const input = { ...example() };
    const identity = input.identity;
    delete input.identity;
    input.sites = [identity];
    const profile = loadAnyProfile(input);
    expect(profile.identity).toEqual(identity);
    expect((profile as { sites: unknown[] }).sites).toEqual([identity]);
  });

  it("a library profile written with two sites loads with both", () => {
    const input = { ...libraryExample() };
    const identity = input.identity as { siteUrl: string; library: string };
    delete input.identity;
    input.sites = [identity, { siteUrl: "https://contoso.sharepoint.com/sites/Two", library: "Documents", clientId: "24001.10" }];
    const profile = loadAnyProfile(input) as { sites: Array<{ clientId?: string }> };
    expect(profile.sites).toHaveLength(2);
    expect(profile.sites[1]!.clientId).toBe("24001.10");
  });

  it("the two example profiles load exactly as before, with a one-entry sites list added", () => {
    for (const input of [example(), libraryExample()]) {
      const profile = loadAnyProfile(input) as { identity: unknown; sites: unknown[] };
      expect(profile.sites).toEqual([profile.identity]);
    }
  });

  it("a site entry accepts an optional clientId and searchRegion", () => {
    expect(SiteEntrySchema.safeParse({ siteUrl: "https://c.sharepoint.com/sites/A", library: "Docs", clientId: "1", searchRegion: "NAM" }).success).toBe(true);
  });
});
```

```ts
// tests/domain/profile/base.errors.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadAnyProfile } from "../../../src/domain/profile/library.js";
import { ProfileValidationError } from "../../../src/domain/profile/load.js";

const example = () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;

describe("site sets, refused", () => {
  it("refuses a profile whose identity and first site disagree, naming both", () => {
    const input = { ...example() };
    const identity = input.identity as { siteUrl: string };
    input.sites = [{ ...identity, siteUrl: "https://contoso.sharepoint.com/sites/Other" }];
    expect(() => loadAnyProfile(input)).toThrow(ProfileValidationError);
    expect(() => loadAnyProfile(input)).toThrow(/identity.*sites\[0\]/);
  });

  it("refuses an empty sites list", () => {
    const input = { ...example() };
    delete input.identity;
    input.sites = [];
    expect(() => loadAnyProfile(input)).toThrow(/sites/);
  });

  it("refuses a compliance profile whose second site has no workbookPath", () => {
    const input = { ...example() };
    const identity = input.identity as { siteUrl: string; library: string; workbookPath: string };
    delete input.identity;
    input.sites = [identity, { siteUrl: "https://contoso.sharepoint.com/sites/Two", library: identity.library }];
    expect(() => loadAnyProfile(input)).toThrow(/sites\.1\.workbookPath/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/domain/profile/base.test.ts tests/domain/profile/base.errors.test.ts`
Expected: FAIL, cannot find `base.js`.

- [ ] **Step 3: Implement**

```ts
// src/domain/profile/base.ts
import { z } from "zod";

/**
 * What every profile kind shares. A profile addresses a set of sites rather
 * than one: the compliance and library domains use a one-entry set today, and
 * the CPA practice domain, one site per client, is why the shape is settled
 * now rather than retrofitted. `clientId` exists for that case, where the
 * client is the site rather than a folder segment.
 *
 * `identity` is kept as the first site so the eighteen places that read
 * `profile.identity` stay as they are. `normalizeProfileSites` makes the two
 * agree before any schema runs.
 */
export const PROFILE_KINDS = ["compliance", "library"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export const SiteEntrySchema = z.object({
  siteUrl: z.string().url(),
  library: z.string().min(1),
  /** Microsoft Search region such as "NAM"; optional, and the cross-check is skipped without it. */
  searchRegion: z.string().min(1).optional(),
  /** The customer's own id for the client this site belongs to, when the client is the site. */
  clientId: z.string().min(1).optional(),
  /** Library-relative path of the tracking workbook. Required on every site of a compliance profile, refused on a library profile. */
  workbookPath: z.string().startsWith("/").optional(),
});
export type SiteEntry = z.infer<typeof SiteEntrySchema>;

export const SitesSchema = z.array(SiteEntrySchema).min(1);

/**
 * Accepts the legacy single `identity`, the new `sites` list, or both, and
 * returns an object carrying both so one schema shape serves every profile
 * ever written. Pure and tolerant: anything that is not a plain object is
 * returned untouched for the schema to reject with its own message. When
 * both are present and disagree, both are left in place and the schema's
 * superRefine reports it, so the message names the path of the mismatch.
 */
export function normalizeProfileSites(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const hasIdentity = record.identity !== undefined;
  const hasSites = Array.isArray(record.sites);
  if (hasIdentity && !hasSites) return { ...record, sites: [record.identity] };
  if (!hasIdentity && hasSites) return { ...record, identity: (record.sites as unknown[])[0] };
  return record;
}

/** The superRefine every kind runs: identity and sites[0] must be the same entry. */
export function refineIdentityAgreesWithSites(profile: { identity: unknown; sites: unknown[] }, ctx: z.RefinementCtx): void {
  if (JSON.stringify(profile.identity) !== JSON.stringify(profile.sites[0])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["identity"],
      message: "identity must equal sites[0]; write the profile with sites only, or make the two agree",
    });
  }
}
```

In `src/domain/profile/schema.ts`:
- Import `SitesSchema`, `refineIdentityAgreesWithSites` from `./base.js`.
- Keep `IdentitySchema` as it is (it is the compliance site entry with `workbookPath` required).
- Add to the `ProfileSchema` object: `sites: SitesSchema,`.
- In the existing `superRefine`, first line: `refineIdentityAgreesWithSites(profile, ctx);` and then, for compliance, every site needs a workbook:

```ts
    profile.sites.forEach((site, index) => {
      if (site.workbookPath === undefined) {
        ctx.addIssue({ code: custom, path: ["sites", index, "workbookPath"], message: "a compliance profile needs a workbookPath on every site" });
      }
    });
```

In `src/domain/profile/load.ts`, `loadProfile` parses `normalizeProfileSites(input)` instead of `input`.

In `src/domain/profile/library.ts`:
- `LibraryProfileSchema` gains `sites: SitesSchema` and a `.superRefine` that calls `refineIdentityAgreesWithSites` and refuses `workbookPath` on any site (`path: ["sites", index, "workbookPath"]`, message: a library profile has no workbook). Because `.strict()` objects with `.superRefine` become `ZodEffects`, change the reference in the same file from `ProfileSchema.innerType().shape.profileId` to importing a shared `ProfileIdSchema` that you add to `base.ts`:

```ts
export const ProfileIdSchema = z.string().min(1).regex(/^[a-z0-9-]+$/, "must be lowercase letters, digits, and hyphens");
```

and use it in both `schema.ts` and `library.ts`.
- `loadAnyProfile` calls `normalizeProfileSites(input)` first, then the existing kind dispatch.
- `AnyProfile` stays a union; both members now carry `sites`.

In `src/modules/types.ts`, replace the local `ProfileKind` with `import type { ProfileKind } from "../domain/profile/base.js";`.

- [ ] **Step 4: Run the whole suite.** Existing profile tests under `tests/domain/profile/` and `tests/profiles/` must pass unedited: the examples normalize to one-entry lists and `identity` is unchanged. If a snapshot-style test compares a whole parsed profile and now sees `sites`, that test is asserting more than it meant to; narrow it to the fields it is about and say so in the commit.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck
git add src/domain/profile src/modules/types.ts tests/domain/profile/base.test.ts tests/domain/profile/base.errors.test.ts
git commit -m "feat(domain): a profile addresses a set of sites, with identity kept as the first"
```

---

## Task 4: The registry dispatches by kind through the modules and checks every site

**Files:**
- Modify: `src/profiles/registry.ts`
- Test: `tests/profiles/modules-dispatch.test.ts`, `tests/profiles/modules-dispatch.errors.test.ts`

**Interfaces:**
- `createProfileRegistry(entries, grantedSiteUrl, modules = ALL_MODULES)`: the third parameter is new and optional, so every existing caller compiles. `loadProfileDirectory(dir, grantedSiteUrl, modules = ALL_MODULES)` likewise.
- The registry reads `kind` (absent means `compliance`), finds the module, validates with `module.profileSchema` after `normalizeProfileSites`. An unknown kind is one issue naming the configured kinds. Every entry in `profile.sites` must match `grantedSiteUrl`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/profiles/modules-dispatch.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { createProfileRegistry } from "../../src/profiles/registry.js";
import type { DomainModule } from "../../src/modules/types.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";
const example = () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;

describe("registry dispatch by kind", () => {
  it("validates a profile with the module that owns its kind", () => {
    const seen: string[] = [];
    const fake: DomainModule = {
      kind: "library",
      profileSchema: z.any().transform((v: { profileId: string }) => {
        seen.push(v.profileId);
        return { ...v, kind: "library" };
      }),
      tools: [],
    };
    const registry = createProfileRegistry(
      [{ source: "lib.json", contents: { kind: "library", profileId: "lib-one", identity: { siteUrl: SITE, library: "Docs" } } }],
      SITE,
      [fake],
    );
    expect(seen).toEqual(["lib-one"]);
    expect(registry.ids()).toEqual(["lib-one"]);
  });

  it("treats an absent kind as compliance, so the example profile loads through the compliance module", () => {
    const registry = createProfileRegistry([{ source: "example.json", contents: example() }], SITE);
    expect(registry.get("example").profileId).toBe("example");
  });

  it("accepts a profile whose every site is the granted site", () => {
    const input = example();
    const identity = input.identity as object;
    delete input.identity;
    input.sites = [identity, { ...identity }];
    const registry = createProfileRegistry([{ source: "two.json", contents: input }], SITE);
    expect(registry.ids()).toEqual(["example"]);
  });
});
```

```ts
// tests/profiles/modules-dispatch.errors.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createProfileRegistry, ProfileRegistryError } from "../../src/profiles/registry.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";
const example = () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;

describe("registry dispatch by kind, refused", () => {
  it("names the configured kinds when a profile declares one no module owns", () => {
    expect(() => createProfileRegistry([{ source: "x.json", contents: { ...example(), kind: "vendor-risk" } }], SITE)).toThrow(
      /kind "vendor-risk".*compliance.*library/,
    );
  });

  it("refuses a profile when any site in its set is not the granted site, naming the index", () => {
    const input = example();
    const identity = input.identity as object;
    delete input.identity;
    input.sites = [identity, { ...identity, siteUrl: "https://contoso.sharepoint.com/sites/Other" }];
    let caught: unknown;
    try {
      createProfileRegistry([{ source: "two.json", contents: input }], SITE);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProfileRegistryError);
    expect((caught as ProfileRegistryError).issues[0]).toMatch(/sites\[1\].*sites\/Other.*grant covers/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/profiles/modules-dispatch.test.ts tests/profiles/modules-dispatch.errors.test.ts`
Expected: FAIL: the third argument is ignored today and the unknown-kind message does not list kinds.

- [ ] **Step 3: Implement.** In `src/profiles/registry.ts`:

Replace the `loadAnyProfile(entry.contents)` call with a local function:

```ts
import { ALL_MODULES, type DomainModule } from "../modules/index.js";
import { normalizeProfileSites } from "../domain/profile/base.js";

function loadThroughModule(contents: unknown, modules: readonly DomainModule[]): AnyProfile {
  const normalized = normalizeProfileSites(contents);
  const kind =
    typeof normalized === "object" && normalized !== null ? ((normalized as { kind?: unknown }).kind ?? "compliance") : "compliance";
  const module = modules.find((m) => m.kind === kind);
  if (module === undefined) {
    throw new ProfileValidationError([
      `kind "${String(kind)}" is not one this server has a module for; the configured kinds are ${modules.map((m) => `"${m.kind}"`).join(", ")}`,
    ]);
  }
  const result = module.profileSchema.safeParse(normalized);
  if (result.success) return result.data as AnyProfile;
  throw new ProfileValidationError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
}
```

Change the signature to `createProfileRegistry(entries, grantedSiteUrl, modules: readonly DomainModule[] = ALL_MODULES)` and call `loadThroughModule(entry.contents, modules)`.

Replace the single `sameSite(profile.identity.siteUrl, grantedSiteUrl)` check with a loop:

```ts
    const foreign = profile.sites.findIndex((site) => !sameSite(site.siteUrl, grantedSiteUrl));
    if (foreign >= 0) {
      issues.push(
        `${entry.source}: profile "${profile.profileId}" sites[${foreign}] names site ${profile.sites[foreign]!.siteUrl}, but this ` +
          `server's Sites.Selected grant covers ${grantedSiteUrl}. A profile pointed at a site the grant does ` +
          "not cover would fail as a 403 on its first Graph call rather than at startup.",
      );
      continue;
    }
```

`loadProfileDirectory` gains the same optional third parameter and passes it through. Keep `loadAnyProfile` exported from `src/domain/profile/library.ts` for the scan CLI and the seed script, which still use it; it dispatches on the two kinds it knows and that is correct for them.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS. The old mismatch message changed shape (`sites[0]` now appears); `tests/profiles/registry.errors.test.ts` may match on the old wording. Update that one assertion to the new wording in this task and say so in the commit.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck
git add src/profiles/registry.ts tests/profiles/modules-dispatch.test.ts tests/profiles/modules-dispatch.errors.test.ts tests/profiles/registry.errors.test.ts
git commit -m "feat(profiles): dispatch profile validation through domain modules and check every site"
```

---

## Task 5: Inbound authentication

**Files:**
- Create: `src/server/auth.ts`
- Modify: `src/config.ts` (loader), `src/server/app.ts` (option), `src/server/main.ts` (wiring and the startup line), `scripts/copilot-probe/app.ts` (use the core middleware)
- Test: `tests/server/auth.test.ts`, `tests/server/auth.errors.test.ts`, `tests/config.errors.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
// src/server/auth.ts
export type InboundAuthMode = "apikey" | "bearer" | "none";
export interface InboundAuthConfig { mode: InboundAuthMode; key?: string; header: string }
export function inboundAuthMiddleware(config: InboundAuthConfig): express.RequestHandler;
export function credentialPresent(req: express.Request, config: InboundAuthConfig): boolean | null;  // null in mode none; for traces
// src/config.ts
export function loadInboundAuth(env: NodeJS.ProcessEnv): InboundAuthConfig;
```
- `createApp` gains `auth: InboundAuthConfig` (required). `/health` is served before the middleware. Every other route is behind it.

Environment: `IW_INBOUND_AUTH` (`apikey` default, `bearer`, `none`), `IW_INBOUND_KEY` (at least 16 characters, required unless mode is `none`), `IW_INBOUND_KEY_HEADER` (default `x-api-key`), `IW_ALLOW_ANONYMOUS` (must be `1` for mode `none`).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/server/auth.test.ts
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { buildServer } from "../../src/mcp/build-server.js";
import { createFakeToolContext } from "../tools/fake-context.js";
import { loadInboundAuth } from "../../src/config.js";

const KEY = "test-key-0123456789abcdef";
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };

function app(auth = loadInboundAuth({ IW_INBOUND_KEY: KEY })) {
  const context = createFakeToolContext();
  return createApp({ auth, serverFactory: () => buildServer({ allowWrites: false, context }) });
}

describe("inbound authentication", () => {
  it("serves /health with no credential", async () => {
    const res = await request(app()).get("/health");
    expect(res.status).toBe(200);
  });

  it("accepts the key in the default header", async () => {
    const res = await request(app()).post("/mcp").set(MCP_HEADERS).set("x-api-key", KEY).send(listTools);
    expect(res.status).toBe(200);
  });

  it("accepts the key in a configured header", async () => {
    const auth = loadInboundAuth({ IW_INBOUND_KEY: KEY, IW_INBOUND_KEY_HEADER: "x-ironwright-key" });
    const res = await request(app(auth)).post("/mcp").set(MCP_HEADERS).set("x-ironwright-key", KEY).send(listTools);
    expect(res.status).toBe(200);
  });

  it("accepts a bearer token in bearer mode", async () => {
    const auth = loadInboundAuth({ IW_INBOUND_AUTH: "bearer", IW_INBOUND_KEY: KEY });
    const res = await request(app(auth)).post("/mcp").set(MCP_HEADERS).set("authorization", `Bearer ${KEY}`).send(listTools);
    expect(res.status).toBe(200);
  });

  it("lets everything through in mode none when anonymous is explicitly allowed", async () => {
    const auth = loadInboundAuth({ IW_INBOUND_AUTH: "none", IW_ALLOW_ANONYMOUS: "1" });
    const res = await request(app(auth)).post("/mcp").set(MCP_HEADERS).send(listTools);
    expect(res.status).toBe(200);
  });
});
```

```ts
// tests/server/auth.errors.test.ts
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { buildServer } from "../../src/mcp/build-server.js";
import { createFakeToolContext } from "../tools/fake-context.js";
import { loadInboundAuth } from "../../src/config.js";

const KEY = "test-key-0123456789abcdef";
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };

function app(auth = loadInboundAuth({ IW_INBOUND_KEY: KEY })) {
  const context = createFakeToolContext();
  return createApp({ auth, serverFactory: () => buildServer({ allowWrites: false, context }) });
}

describe("inbound authentication, refused", () => {
  it("answers 401 as a JSON-RPC error with no credential, and never builds a server", async () => {
    let built = 0;
    const context = createFakeToolContext();
    const a = createApp({
      auth: loadInboundAuth({ IW_INBOUND_KEY: KEY }),
      serverFactory: () => {
        built += 1;
        return buildServer({ allowWrites: false, context });
      },
    });
    const res = await request(a).post("/mcp").set(MCP_HEADERS).send(listTools);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized." }, id: null });
    expect(built).toBe(0);
  });

  it("rejects a wrong key of any length, and the body never echoes what was sent", async () => {
    for (const wrong of ["x", `${KEY}x`, KEY.toUpperCase()]) {
      const res = await request(app()).post("/mcp").set(MCP_HEADERS).set("x-api-key", wrong).send(listTools);
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain(wrong);
    }
  });

  it("in bearer mode, a key in the api-key header is not accepted and WWW-Authenticate is set", async () => {
    const auth = loadInboundAuth({ IW_INBOUND_AUTH: "bearer", IW_INBOUND_KEY: KEY });
    const res = await request(app(auth)).post("/mcp").set(MCP_HEADERS).set("x-api-key", KEY).send(listTools);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });

  it("guards the 404 fallthrough and the 405 routes too, so an unauthenticated scan learns nothing", async () => {
    expect((await request(app()).get("/mcp")).status).toBe(401);
    expect((await request(app()).get("/anything")).status).toBe(401);
  });
});

describe("loadInboundAuth", () => {
  it("refuses to start with no key in apikey mode, naming the variable and the length floor", () => {
    expect(() => loadInboundAuth({})).toThrow(/IW_INBOUND_KEY.*16/);
  });

  it("refuses a short key", () => {
    expect(() => loadInboundAuth({ IW_INBOUND_KEY: "short" })).toThrow(/16/);
  });

  it("refuses mode none without IW_ALLOW_ANONYMOUS=1", () => {
    expect(() => loadInboundAuth({ IW_INBOUND_AUTH: "none" })).toThrow(/IW_ALLOW_ANONYMOUS/);
  });

  it("refuses an unknown mode, naming the three", () => {
    expect(() => loadInboundAuth({ IW_INBOUND_AUTH: "oauth", IW_INBOUND_KEY: "test-key-0123456789abcdef" })).toThrow(/apikey.*bearer.*none/);
  });

  it("never echoes the key in any message", () => {
    const key = "short";
    let message = "";
    try {
      loadInboundAuth({ IW_INBOUND_KEY: key });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(key);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/server/auth.test.ts tests/server/auth.errors.test.ts`
Expected: FAIL, `loadInboundAuth` not exported; `createApp` rejects the `auth` option at typecheck.

- [ ] **Step 3: Implement**

```ts
// src/server/auth.ts
import { timingSafeEqual } from "node:crypto";
import type express from "express";

/**
 * The server's own front door. It exists because the product is self-hosted
 * behind whatever ingress the customer chooses, and a tunnel terminates TLS
 * and nothing else, so nothing in front of this process can be relied on to
 * have checked a credential. Lifted from the Copilot Studio probe server,
 * which now uses this implementation rather than its own copy.
 *
 * Two modes carry the same shared key, because Copilot Studio's add-tool
 * dialog offers one or the other depending on probe A3's answer. Mode none
 * exists for loopback development only and the loader makes an operator say
 * so in the environment.
 */
export type InboundAuthMode = "apikey" | "bearer" | "none";

export interface InboundAuthConfig {
  mode: InboundAuthMode;
  key?: string;
  header: string;
}

export const MIN_INBOUND_KEY_LENGTH = 16;

function keysMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on unequal lengths, and a length difference is
  // itself a rejection, so check it first rather than catching.
  return a.length === b.length && timingSafeEqual(a, b);
}

function suppliedKey(req: express.Request, config: InboundAuthConfig): string | undefined {
  if (config.mode === "apikey") {
    const value = req.header(config.header);
    return value === undefined || value === "" ? undefined : value;
  }
  if (config.mode === "bearer") {
    const header = req.header("authorization");
    const match = header === undefined ? null : /^Bearer (.+)$/i.exec(header);
    return match?.[1];
  }
  return undefined;
}

/** Presence only, for a trace. The value of a credential is never recorded. */
export function credentialPresent(req: express.Request, config: InboundAuthConfig): boolean | null {
  return config.mode === "none" ? null : suppliedKey(req, config) !== undefined;
}

export function inboundAuthMiddleware(config: InboundAuthConfig): express.RequestHandler {
  if (config.mode !== "none" && (config.key === undefined || config.key.length < MIN_INBOUND_KEY_LENGTH)) {
    throw new Error(`inbound authentication needs a key of at least ${MIN_INBOUND_KEY_LENGTH} characters unless the mode is none`);
  }
  return (req, res, next) => {
    if (config.mode === "none") {
      next();
      return;
    }
    const supplied = suppliedKey(req, config);
    if (supplied !== undefined && keysMatch(supplied, config.key as string)) {
      next();
      return;
    }
    if (config.mode === "bearer") res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized." }, id: null });
  };
}
```

In `src/config.ts`, add:

```ts
import { MIN_INBOUND_KEY_LENGTH, type InboundAuthConfig, type InboundAuthMode } from "./server/auth.js";

/**
 * Fails closed: no key means no start, and mode none needs a second variable
 * that says the operator meant it. The key is never echoed, for the same
 * reason the client secret above is not.
 */
export function loadInboundAuth(env: NodeJS.ProcessEnv): InboundAuthConfig {
  const rawMode = env.IW_INBOUND_AUTH?.trim() ?? "apikey";
  if (rawMode !== "apikey" && rawMode !== "bearer" && rawMode !== "none") {
    throw new Error(`IW_INBOUND_AUTH must be apikey, bearer or none, received "${rawMode}"`);
  }
  const mode: InboundAuthMode = rawMode;
  const header = env.IW_INBOUND_KEY_HEADER?.trim() || "x-api-key";

  if (mode === "none") {
    if (env.IW_ALLOW_ANONYMOUS !== "1") {
      throw new Error(
        "IW_INBOUND_AUTH=none starts a server that answers anyone who can reach it. Set IW_ALLOW_ANONYMOUS=1 " +
          "as well to confirm that this process is reachable from loopback only.",
      );
    }
    return { mode, header };
  }

  const key = env.IW_INBOUND_KEY;
  if (!present(key) || key.length < MIN_INBOUND_KEY_LENGTH) {
    throw new Error(
      `IW_INBOUND_KEY is required and must be at least ${MIN_INBOUND_KEY_LENGTH} characters: it is the shared key every ` +
        "request to this server must carry. Generate one with: node -e \"console.log(require('node:crypto').randomBytes(24).toString('hex'))\"",
    );
  }
  return { mode, key, header };
}
```

Note the import direction: `src/config.ts` importing from `src/server/auth.ts` is fine; `auth.ts` imports nothing from config.

In `src/server/app.ts`:
- `AppOptions` gains `auth: InboundAuthConfig;`.
- After the `/health` route and before `app.post("/mcp", ...)`, add `app.use(inboundAuthMiddleware(opts.auth));`. The 404 fallthrough and the 405 routes are already after it, so they are guarded, which the errors test checks.

In `src/server/main.ts`:
- `const inboundAuth = loadInboundAuth(process.env);` with the other loaders.
- Pass `auth: inboundAuth` to `createApp`.
- The listening line gains `, inbound auth ${inboundAuth.mode}` and nothing else about it.

In `scripts/copilot-probe/app.ts`: delete `keysMatch` and `suppliedKey`, import `credentialPresent` and `inboundAuthMiddleware` from `../../src/server/auth.js`, build `const auth: InboundAuthConfig = { mode: opts.authMode, header: opts.apiKeyHeader, ...(opts.apiKey === undefined ? {} : { key: opts.apiKey }) }`, use `credentialPresent(req, auth)` in the trace and `app.use(inboundAuthMiddleware(auth))` in place of the inline middleware. Its tests in `tests/scripts/copilot-probe.test.ts` pass unedited.

Also update every existing test that calls `createApp` to pass `auth: { mode: "none", header: "x-api-key" }`, which is `tests/server/health.test.ts`, `http-errors.errors.test.ts`, `isolation.errors.test.ts`, `mcp-transport.test.ts`, `write-gate.errors.test.ts` and `tests/tools/wire-contract.test.ts`. That is the one edit to existing tests this task makes, and it is mechanical.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck
git add src/server/auth.ts src/config.ts src/server/app.ts src/server/main.ts scripts/copilot-probe/app.ts tests/server tests/config.errors.test.ts
git commit -m "feat(server): authenticate every inbound request with a shared key"
```

---

## Task 6: The assessment journal in the store

**Files:**
- Modify: `src/store/types.ts`, `src/store/memory.ts`, `src/store/table.ts`, `src/store/keys.ts`
- Test: `tests/store/conformance.ts` (extend), `tests/store/fake-table-client.ts` (a fourth table if the fake is per-table), `tests/store/table.errors.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
// src/store/types.ts
export interface JournalEntry {
  at: string;                 // ISO instant
  correlationId: string;
  stage: string;              // the module's stage name, e.g. "ID", "DOSSIER"
  operation: "list_item_created" | "list_item_updated" | "folder_created" | "file_created" | "file_overwritten";
  target: string;             // list name plus item id, or library-relative path, as the server computed it
  etagBefore?: string;
  etagAfter?: string;
  contentHash?: string;       // sha256 hex of what was written, for files
  versionId?: string;         // the SharePoint version that held the prior content, on an overwrite
}
// on StateStore:
appendJournalEntry(profileId: string, assessmentId: string, entry: JournalEntry): Promise<void>;
listJournal(profileId: string, assessmentId: string): Promise<JournalEntry[]>;   // ascending by at, then correlationId
```
- `journalPartitionKey(profileId, assessmentId)` in `keys.ts`, same forbidden-character check as the inventory key, `${profileId}|journal|${assessmentId}`.
- `ensureTables` creates a fourth table, `journal`.

- [ ] **Step 1: Write the failing conformance tests.** In `tests/store/conformance.ts`, inside `stateStoreConformance`, append:

```ts
  it("lists no journal entries before any are appended", async () => {
    await expect(create().listJournal("example", "ASM-2026-00001")).resolves.toEqual([]);
  });

  it("appends journal entries and lists them in time order regardless of append order", async () => {
    const store = create();
    const later = { at: "2026-11-07T10:00:01.000Z", correlationId: "c2", stage: "DOSSIER", operation: "file_created" as const, target: "Assessments/V/ASM-2026-00001/Research/V_Research_Dossier.md", etagAfter: "e2", contentHash: "h" };
    const earlier = { at: "2026-11-07T10:00:00.000Z", correlationId: "c1", stage: "ID", operation: "list_item_created" as const, target: "Assessments#17" };
    await store.appendJournalEntry("example", "ASM-2026-00001", later);
    await store.appendJournalEntry("example", "ASM-2026-00001", earlier);
    await expect(store.listJournal("example", "ASM-2026-00001")).resolves.toEqual([earlier, later]);
  });

  it("keeps journals apart by profile and by assessment", async () => {
    const store = create();
    const entry = { at: "2026-11-07T10:00:00.000Z", correlationId: "c1", stage: "ID", operation: "list_item_created" as const, target: "Assessments#17" };
    await store.appendJournalEntry("example", "ASM-2026-00001", entry);
    await expect(store.listJournal("example", "ASM-2026-00002")).resolves.toEqual([]);
    await expect(store.listJournal("other", "ASM-2026-00001")).resolves.toEqual([]);
  });

  it("refuses an assessment id that cannot be a table key", async () => {
    const entry = { at: "2026-11-07T10:00:00.000Z", correlationId: "c1", stage: "ID", operation: "list_item_created" as const, target: "x" };
    await expect(create().appendJournalEntry("example", "bad/id", entry)).rejects.toBeInstanceOf(UnsafeKeyError);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/store`
Expected: FAIL on both implementations, `appendJournalEntry` is not a function.

- [ ] **Step 3: Implement**

`src/store/keys.ts`:

```ts
/**
 * One partition per assessment. The assessment id is rendered by the module
 * from a profile template, so its alphabet is the customer's choice and it
 * is checked rather than encoded, like the drive id: a forbidden character
 * here means the template needs changing, which is worth failing loudly on.
 */
export function journalPartitionKey(profileId: string, assessmentId: string): string {
  if (FORBIDDEN.test(profileId)) throw new UnsafeKeyError("profile id", profileId);
  if (FORBIDDEN.test(assessmentId)) throw new UnsafeKeyError("assessment id", assessmentId);
  return `${profileId}|journal|${assessmentId}`;
}

/** Sorts ascending by time, then by correlation id, as a row key and as a comparator. */
export function journalRowKey(entry: { at: string; correlationId: string }): string {
  return `${entry.at}|${entry.correlationId}`;
}
```

`src/store/types.ts`: the `JournalEntry` interface above, and the two methods on `StateStore` with this comment on `appendJournalEntry`:

```ts
  /**
   * Appends one entry to an assessment's journal. Append, never replace: the
   * journal is the audit record of what a lifecycle tool did, and the
   * reversal record for what is reversible, so an entry once written is
   * never edited. Ordering is by `at` then `correlationId`, which is why
   * both are required.
   */
```

`src/store/memory.ts`: a `journals = new Map<string, JournalEntry[]>()` keyed by `journalPartitionKey`; `appendJournalEntry` pushes a `structuredClone`; `listJournal` returns a sorted copy by `journalRowKey`.

`src/store/table.ts`: add `journal: TableClientLike` to `TableStateStoreClients`; `appendJournalEntry` upserts `{ partitionKey: journalPartitionKey(...), rowKey: encodeRowKey(journalRowKey(entry)), entry: JSON.stringify(entry) }` (the entry as one JSON string property, which is under the 32 KB cap by a wide margin for every field above; the target is a path and the hash is 64 characters); `listJournal` lists the partition, parses `entry`, sorts by `journalRowKey`. `ensureTables` creates the fourth table, and `tableStateStoreFromConnectionString` constructs the fourth client the same way as the other three. The fake in `tests/store/fake-table-client.ts` gets a fourth instance in whatever way it supplies the first three.

- [ ] **Step 4: Run the store suite and the whole suite**

Run: `npm test`
Expected: PASS for memory and table.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck
git add src/store tests/store
git commit -m "feat(store): journal lifecycle writes per assessment"
```

---

## Task 7: A handler keeps running after its client disconnects

**Files:**
- Test: `tests/server/disconnect.test.ts`

This is the suite row from the spec's Assumptions table. It does not test the scan coordinator; it tests the one thing the ingress documentation will claim, that the server does not cancel a tool handler when the edge drops the connection, so a long first scan started through a tunnel completes and the next call answers from it. The coordinator's single-flight behavior is already covered by `tests/scan/`.

- [ ] **Step 1: Write the test**

```ts
// tests/server/disconnect.test.ts
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../../src/server/app.js";
import { buildServer } from "../../src/mcp/build-server.js";
import { createFakeToolContext } from "../tools/fake-context.js";
import type { ToolDefinition } from "../../src/tools/types.js";

describe("a tool handler survives its client going away", () => {
  it("completes the handler after the socket is destroyed mid-call", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed = false;

    const slow: ToolDefinition = {
      name: "slow_fixture",
      kind: "read",
      title: "Slow",
      description: "Fixture. Read-only: this tool makes no changes and is safe to repeat.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      outputSchema: { ok: z.boolean() },
      handler: async () => {
        await gate;
        completed = true;
        return { structuredContent: { ok: true }, content: [{ type: "text", text: "ok" }] };
      },
    };

    const context = createFakeToolContext();
    const app = createApp({
      auth: { mode: "none", header: "x-api-key" },
      serverFactory: () => buildServer({ allowWrites: false, context, tools: [slow] }),
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow_fixture", arguments: {} } });
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(body) },
    });
    req.on("error", () => {});
    req.end(body);

    // Give the server time to enter the handler, then drop the connection
    // the way an edge timeout does.
    await new Promise((resolve) => setTimeout(resolve, 100));
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completed).toBe(false);

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completed).toBe(true);

    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/server/disconnect.test.ts`
Expected: PASS. If it fails because `completed` stays false after release, the server is cancelling handlers on disconnect, which contradicts what `app.ts`'s close handler says it does; stop and report, since that changes what plan 9d may document.

- [ ] **Step 3: Commit**

```bash
git add tests/server/disconnect.test.ts
git commit -m "test(server): a tool handler completes after its client disconnects"
```

---

## Task 8: Documentation and status

**Files:**
- Modify: `docs/SETUP.md`, `docs/OPEN-ITEMS.md`, `docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md`

- [ ] **Step 1: SETUP.md.** Under "Deployment configuration contract", add the four inbound variables with one line each, copied from Task 5's environment table, and a paragraph: the server refuses to start without a key; mode `none` is for loopback development and needs `IW_ALLOW_ANONYMOUS=1`; the key never appears in logs. Under "Running the server", add a short "Ingress" subsection naming the three paths from the spec in one sentence each and pointing to plan 9d for the full procedure.

- [ ] **Step 2: OPEN-ITEMS.md.** Change the 9b row to `Complete <date>` with the PR number once it exists.

- [ ] **Step 3: Spec amendments.** Append a section `## Amendments, 2026-11-0X, during plan 9b` recording the one deviation at the top of this plan: module objects reference definitions in place; the physical move is deferred and is a rename-only commit when it happens.

- [ ] **Step 4: Commit**

```bash
git add docs/SETUP.md docs/OPEN-ITEMS.md docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md
git commit -m "docs: inbound authentication, ingress paths and the module boundary as built"
```

---

## Self-review against the spec

- **Core and domain modules:** Task 2 (module objects, registry union), Task 4 (dispatch by kind, unknown kind names the kinds). The "byte for byte" claim is carried by the unchanged tool definitions plus `tests/tools/modules.test.ts` and the untouched tool suites.
- **Site sets:** Task 3 (schema, normalize, identity kept), Task 4 (every site checked against the grant).
- **Lifecycle kind:** Task 1, including the write gate.
- **Journal:** Task 6, both stores, conformance.
- **Inbound authentication:** Task 5, both modes, health exempt, key never echoed, probe server reuses it.
- **Scan survives disconnect:** Task 7.
- **Graph additions:** deliberately not here; they go to plan 9c with their first caller, after plan 9a's evidence.
- **Names across tasks:** `ProfileKind` (Task 3 defines, Task 2 imports after Task 3), `DomainModule`, `ALL_MODULES`, `moduleForKind` (Task 2, used by Task 4), `normalizeProfileSites` (Task 3, used by Task 4), `InboundAuthConfig`, `loadInboundAuth`, `inboundAuthMiddleware`, `credentialPresent` (Task 5, used by Task 7), `JournalEntry`, `appendJournalEntry`, `listJournal`, `journalPartitionKey`, `journalRowKey` (Task 6). Consistent.
- **Placeholders:** none. Task 8's `<date>` and `9X` are filled at execution from the calendar and the PR.
