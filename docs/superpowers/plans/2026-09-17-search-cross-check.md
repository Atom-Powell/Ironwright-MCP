# Microsoft Search Cross-Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find correctly named deliverables filed into other document libraries of the profile's own site, so the engine stops reporting them as missing and a report can stop declaring itself degraded.

**Architecture:** A thin Graph layer issues `POST /search/query` for `driveItem` with a region and a path scope, paging to a cap. A composition layer lists the site's drives, excludes the profile's own, searches each remaining one, and converts hits into repository files carrying a library qualifier. The engine gains one matcher rule and one orphan-exclusion rule; no new artifact state.

**Tech Stack:** TypeScript, Node, vitest, plain `fetch` through the existing `GraphClient`. No new dependency.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-17-search-cross-check-design.md`. It is binding.
- No emojis or icons anywhere, including logs, comments and docs. US English throughout.
- No em dash or en dash characters in tracked prose. A repo test enforces this over `.ts`, `.js`, `.json`, `.md` and `.yml`.
- Comments explain why, not what.
- A function that cannot observe an outcome must not assert it. This applies with force to every degraded reason in this plan: the report must distinguish skipped, failed and truncated, because the remedy differs for each.
- `src/domain/` and `src/workbook/` are pure. No I/O, enforced by lint.
- Every new module gets both a `.test.ts` and an `.errors.test.ts`.
- Conventional commits. Run `npm run lint && npm run typecheck && npm test` before every commit.
- No new dependency.
- Baseline at plan time: 1555 tests across 108 files, all gates green on `main` at `35759d4`.

## Verified before this plan was written

A live probe on 2026-09-17 against the `helloironwright` tenant, with the server's own `Sites.Selected` token, established:

- `POST /search/query` for `driveItem` works app-only.
- It requires `region` in the request. Without it: 400, `Region is required when request with application permission.`
- Results are trimmed to the granted site. A broad query returned 220 hits, all under the granted site.
- Hits carry `webUrl` in URL-name form, `.../Shared Documents/...`, while profiles carry the display name, `Documents`.

Do not redesign around these. They are measured, not assumed.

---

### Task 1: `listDrives` and `identity.searchRegion`

**Files:**
- Modify: `src/graph/drive.ts` (extract the drive enumeration `resolveDrive` performs inline)
- Modify: `src/domain/profile/schema.ts:75-79` (`IdentitySchema`)
- Test: `tests/graph/drive.test.ts`, `tests/domain/profile.test.ts`

**Interfaces:**
- Consumes: `GraphClient` from `src/graph/client.js`.
- Produces: `interface SiteDrive { id: string; name: string }`, `listDrives(client: Pick<GraphClient, "get">, siteUrl: string): Promise<{ siteId: string; drives: SiteDrive[] }>`, and `identity.searchRegion?: string` on the profile.

`resolveDrive` currently lists the site's drives inline and returns the single match. Task 4 needs the list. Extract the enumeration and rewrite `resolveDrive` to call it, so there is one description of how a site's libraries are found. This matters concretely: `resolveDrive` matches exact-then-case-insensitive precisely because SharePoint permits two libraries whose names differ only in case, and a second copy of that enumeration is where the rule would go missing.

`resolveDrive`'s parameter is already `Pick<GraphClient, "get">`, narrowed in phase 2b-2. Keep it, and give `listDrives` the same.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/graph/drive.test.ts, added to the existing describe
it("lists every drive on the site with its id and name", async () => {
  const client = {
    get: (async (path: string) => {
      if (path.includes("/drives")) {
        return { value: [{ id: "d1", name: "Documents" }, { id: "d2", name: "Archive" }] };
      }
      return { id: "site-1" };
    }) as never,
  };

  const result = await listDrives(client, "https://contoso.sharepoint.com/sites/Example");

  expect(result.siteId).toBe("site-1");
  expect(result.drives).toEqual([
    { id: "d1", name: "Documents" },
    { id: "d2", name: "Archive" },
  ]);
});

it("still resolves one library by name through the extracted enumeration", async () => {
  // Pins that the extraction did not change resolveDrive's own behavior,
  // including the exact-before-case-insensitive rule.
  const client = {
    get: (async (path: string) => {
      if (path.includes("/drives")) {
        return { value: [{ id: "d1", name: "documents" }, { id: "d2", name: "Documents" }] };
      }
      return { id: "site-1" };
    }) as never,
  };

  const result = await resolveDrive(client, "https://contoso.sharepoint.com/sites/Example", "Documents");

  expect(result.driveId).toBe("d2");
});
```

```typescript
// tests/domain/profile.test.ts
it("accepts a profile carrying a search region", () => {
  const profile = { ...validProfile, identity: { ...validProfile.identity, searchRegion: "NAM" } };
  expect(ProfileSchema.parse(profile).identity.searchRegion).toBe("NAM");
});

it("accepts a profile with no search region, because the cross-check is optional", () => {
  expect(ProfileSchema.parse(validProfile).identity.searchRegion).toBeUndefined();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/graph/drive.test.ts tests/domain/profile.test.ts`
Expected: FAIL, `listDrives` is not exported and `searchRegion` is stripped by the schema.

- [ ] **Step 3: Extract `listDrives`**

In `src/graph/drive.ts`, move the site lookup and the `/drives` call out of `resolveDrive` into an exported `listDrives`, returning `{ siteId, drives }`. `resolveDrive` then calls it and applies its existing exact-then-case-insensitive match and its existing `LibraryNotFoundError`. Do not change either behavior or either message.

- [ ] **Step 4: Add `searchRegion`**

In `src/domain/profile/schema.ts`, add to `IdentitySchema`:

```typescript
  /**
   * The Microsoft Search region, such as "NAM". Required by Graph on any
   * search issued with an application permission, and there is no discovery
   * call this project has verified, so it is configured rather than detected.
   * Optional because a profile without it is still valid: the cross-check is
   * skipped and the report says that is why, rather than failing a run over a
   * field that only affects one of its checks.
   */
  searchRegion: z.string().min(1).optional(),
```

- [ ] **Step 5: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS. An existing `resolveDrive` test breaking means the extraction changed behavior.

- [ ] **Step 6: Commit**

```bash
git add src/graph/drive.ts src/domain/profile/schema.ts tests/graph/drive.test.ts tests/domain/profile.test.ts
git commit -m "feat(graph): expose the site's drives and accept a search region"
```

---

### Task 2: The Search client

**Files:**
- Create: `src/graph/search.ts`
- Test: `tests/graph/search.test.ts`, `tests/graph/search.errors.test.ts`

**Interfaces:**
- Consumes: `GraphClient` from `src/graph/client.js`.
- Produces:

```typescript
export interface SearchHit { name: string; webUrl: string; size: number; lastModified: string; etag: string }
export interface SearchOutcome { hits: SearchHit[]; complete: boolean }
export const SEARCH_PAGE_SIZE = 200;
export const SEARCH_PAGE_CAP = 25;
export async function searchDriveItems(
  client: Pick<GraphClient, "post">,
  args: { region: string; pathScope: string; extension?: string },
): Promise<SearchOutcome>;
```

`complete` is false when the cap was reached with results still outstanding. It is never false for any other reason: a failure throws rather than returning a partial success, so a caller cannot mistake one for the other.

The request body shape, measured against the live API:

```json
{ "requests": [ { "entityTypes": ["driveItem"], "query": { "queryString": "..." }, "from": 0, "size": 200, "region": "NAM" } ] }
```

The query string is `path:"<pathScope>"`, plus ` filetype:<extension>` when an extension is given. Paging advances `from` by `SEARCH_PAGE_SIZE`. Stop when a page returns fewer hits than requested, or when `moreResultsAvailable` is false, or at the cap.

This module carries no domain knowledge. It does not know what a client, a deliverable or a profile is.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/graph/search.test.ts
import { describe, expect, it } from "vitest";
import { searchDriveItems, SEARCH_PAGE_SIZE } from "../../src/graph/search.js";

function hit(name: string): unknown {
  return {
    resource: {
      name,
      webUrl: `https://contoso.sharepoint.com/sites/Example/Archive/${name}`,
      size: 10,
      lastModifiedDateTime: "2026-01-01T00:00:00Z",
      eTag: `"{etag-${name}}"`,
    },
  };
}

function page(hits: unknown[], more: boolean): unknown {
  return { value: [{ hitsContainers: [{ hits, moreResultsAvailable: more }] }] };
}

describe("searchDriveItems", () => {
  it("sends the region and a path scope, and returns the hits", async () => {
    const bodies: unknown[] = [];
    const client = {
      post: (async (_path: string, body?: unknown) => {
        bodies.push(body);
        return page([hit("a.xlsx")], false);
      }) as never,
    };

    const result = await searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive" });

    expect(result.complete).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.name).toBe("a.xlsx");
    const sent = bodies[0] as { requests: Array<{ region: string; query: { queryString: string }; size: number }> };
    expect(sent.requests[0]?.region).toBe("NAM");
    expect(sent.requests[0]?.query.queryString).toContain('path:"https://x/Archive"');
    expect(sent.requests[0]?.size).toBe(SEARCH_PAGE_SIZE);
  });

  it("narrows by file extension when one is given", async () => {
    const bodies: unknown[] = [];
    const client = {
      post: (async (_p: string, body?: unknown) => { bodies.push(body); return page([], false); }) as never,
    };

    await searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive", extension: "xlsx" });

    const sent = bodies[0] as { requests: Array<{ query: { queryString: string } }> };
    expect(sent.requests[0]?.query.queryString).toContain("filetype:xlsx");
  });

  it("pages until the results run out", async () => {
    let call = 0;
    const client = {
      post: (async () => {
        call += 1;
        return call === 1 ? page(Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) => hit(`a${String(i)}.xlsx`)), true)
                          : page([hit("last.xlsx")], false);
      }) as never,
    };

    const result = await searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive" });

    expect(call).toBe(2);
    expect(result.hits).toHaveLength(SEARCH_PAGE_SIZE + 1);
    expect(result.complete).toBe(true);
  });
});
```

```typescript
// tests/graph/search.errors.test.ts
import { describe, expect, it } from "vitest";
import { searchDriveItems, SEARCH_PAGE_CAP, SEARCH_PAGE_SIZE } from "../../src/graph/search.js";

describe("searchDriveItems limits and failures", () => {
  it("reports incomplete rather than truncating silently when the cap is reached", async () => {
    let call = 0;
    const client = {
      post: (async () => {
        call += 1;
        return {
          value: [{ hitsContainers: [{
            hits: Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) => ({
              resource: { name: `f${String(i)}.xlsx`, webUrl: "https://x/Archive/f.xlsx", size: 1, lastModifiedDateTime: "2026-01-01T00:00:00Z", eTag: '"{e}"' },
            })),
            moreResultsAvailable: true,
          }] }],
        };
      }) as never,
    };

    const result = await searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive" });

    // The cap is a refusal to claim completeness, not a quiet truncation.
    expect(call).toBe(SEARCH_PAGE_CAP);
    expect(result.complete).toBe(false);
    expect(result.hits).toHaveLength(SEARCH_PAGE_CAP * SEARCH_PAGE_SIZE);
  });

  it("propagates a failure rather than returning a partial success", async () => {
    const client = { post: (async () => { throw new Error("search exploded"); }) as never };
    await expect(searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive" })).rejects.toThrow(/search exploded/);
  });

  it("treats a response with no hits container as an empty complete result", async () => {
    const client = { post: (async () => ({ value: [] })) as never };
    const result = await searchDriveItems(client, { region: "NAM", pathScope: "https://x/Archive" });
    expect(result).toEqual({ hits: [], complete: true });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/graph/search.test.ts tests/graph/search.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/graph/search.js`.

- [ ] **Step 3: Implement `src/graph/search.ts`**

Constants carry their reasoning:

```typescript
/**
 * 200 per page and 25 pages, so at most 5000 hits from one library. A
 * tracking repository's deliverables number in the hundreds, and a live
 * probe against a real site returned 220 hits for a broad single term, so
 * the cap sits about an order of magnitude above any plausible real answer
 * while still bounding a pathological one. Constants rather than profile
 * configuration because no real customer library has been measured, so a
 * knob would be a guess at a shape nobody has seen.
 */
export const SEARCH_PAGE_SIZE = 200;
export const SEARCH_PAGE_CAP = 25;
```

Read each hit from `value[0].hitsContainers[0]`. Map `resource.name`, `resource.webUrl`, `resource.size`, `resource.lastModifiedDateTime` and `resource.eTag`, skipping any hit missing a name or a webUrl rather than inventing values for it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/graph/search.test.ts tests/graph/search.errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph/search.ts tests/graph/search.test.ts tests/graph/search.errors.test.ts
git commit -m "feat(graph): query Microsoft Search for driveItems with a page cap"
```

---

### Task 3: The engine contract, the matcher rule and the orphan exclusion

**Files:**
- Modify: `src/domain/reconcile/types.ts` (`RepositoryFile`)
- Modify: `src/domain/reconcile/match.ts:92-105` (`computeState`) and both orphan push sites inside `matchArtifacts`, at `match.ts:165` and `match.ts:177`
- Test: `tests/domain/reconcile/match.test.ts`, `tests/domain/reconcile/match.errors.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RepositoryFile.library?: string`.

Three changes, and the third is the one that decides whether this product is usable at a customer with more than one library.

**The qualifier.** `RepositoryFile` gains `library?: string`. Absent means the profile's own library, which is exactly today's meaning, so every existing fixture and the golden report stay valid untouched. Present names another library in the same site.

**The matcher rule.** In `computeState`, a candidate whose `parsed.file.library` is present is in the wrong location by definition, whatever its path looks like. `locationCorrect` must be false for it. Do not add a state; the existing four cover it, and the result is `misplaced` or `misnamed_and_misplaced` according to the name.

**The orphan exclusion.** A file carrying a `library` never becomes an orphan. Both push sites at `match.ts:165` and `match.ts:177` must skip it. Without this, every unrelated file in every other library of the site arrives in a compliance report as an orphan: HR documents, meeting notes, scanned invoices. The tool becomes unusable at exactly the customers it is for. Write that reasoning in the comment.

- [ ] **Step 1: Write the failing tests**

The matcher's entry is `matchArtifacts(profile, expected, parsed)`, and it takes ALREADY PARSED
files, not raw ones. Parsing happens first, through `createFileParser(profile)` or `parseFile` in
`src/domain/reconcile/parse.ts`, and a `ParsedFile` carries its originating `RepositoryFile` as
`.file`. So the library qualifier reaches `computeState` through `parsed.file.library`, and your
tests must build a `RepositoryFile`, parse it, then match. Read `tests/domain/reconcile/match.test.ts`
for how the existing cases assemble that pair before writing new ones.

```typescript
// tests/domain/reconcile/match.test.ts, following the file's existing setup
it("treats a correctly named file in another library as misplaced, not compliant", () => {
  // Its path inside that other library may be identical to the expected one.
  // The location is wrong because the library is wrong, and a library
  // relative path alone cannot express that.
  const file = { ...compliantFile, library: "Archive" };
  const result = matchArtifacts(profile, expected, [parseFile(profile, file)]);
  expect(result.artifacts[0]?.state).toBe("misplaced");
});

it("treats a misnamed file in another library as misnamed and misplaced", () => {
  const file = { ...misnamedFile, library: "Archive" };
  const result = matchArtifacts(profile, expected, [parseFile(profile, file)]);
  expect(result.artifacts[0]?.state).toBe("misnamed_and_misplaced");
});

it("keeps today's meaning for a file with no library qualifier", () => {
  const result = matchArtifacts(profile, expected, [parseFile(profile, compliantFile)]);
  expect(result.artifacts[0]?.state).toBe("compliant");
});
```

```typescript
// tests/domain/reconcile/match.errors.test.ts
it("never reports a file from another library as an unrecognized orphan", () => {
  // The rule that makes this tool usable at a customer with more than one
  // library. Without it every unrelated document in every other library
  // lands in the compliance report.
  const stranger = { path: "Policies/handbook.xlsx", name: "handbook.xlsx", size: 1, modified: "2026-01-01T00:00:00Z", etag: '"{e}"', library: "Archive" };
  const result = matchArtifacts(profile, expected, [parseFile(profile, stranger)]);
  expect(result.orphans).toEqual([]);
});

it("never reports a file from another library as an unexpected orphan either", () => {
  // Parses cleanly but names a slot nobody owes. Both orphan push sites must
  // skip a qualified file, not just the unrecognized one.
  const stranger = { ...fileNamingAnUnownedSlot, library: "Archive" };
  const result = matchArtifacts(profile, expected, [parseFile(profile, stranger)]);
  expect(result.orphans).toEqual([]);
});

it("still reports an unrecognized file in the profile's own library as an orphan", () => {
  const stranger = { path: "handbook.xlsx", name: "handbook.xlsx", size: 1, modified: "2026-01-01T00:00:00Z", etag: '"{e}"' };
  const result = matchArtifacts(profile, expected, [parseFile(profile, stranger)]);
  expect(result.orphans).toHaveLength(1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/domain/reconcile/`
Expected: FAIL on the new cases; every existing case still passes, because an absent qualifier changes nothing.

- [ ] **Step 3: Implement the three changes**

- [ ] **Step 4: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS, golden report included. A golden mismatch means an absent qualifier changed behavior, which it must not.

- [ ] **Step 5: Commit**

```bash
git add src/domain/reconcile/types.ts src/domain/reconcile/match.ts tests/domain/reconcile/
git commit -m "feat(reconcile): qualify a file by library and never orphan a foreign one"
```

---

### Task 4: The cross-check composition

**Files:**
- Create: `src/scan/cross-check.ts`
- Test: `tests/scan/cross-check.test.ts`, `tests/scan/cross-check.errors.test.ts`

**Interfaces:**
- Consumes: `listDrives` and `SiteDrive` from `src/graph/drive.js`, `searchDriveItems` from `src/graph/search.js`, `RepositoryFile` from `src/domain/reconcile/index.js`, `Profile` from `src/domain/profile/schema.js`.
- Produces:

```typescript
export type CrossCheckSkipReason = "no-region" | "search-failed" | "page-cap-reached";
export interface CrossCheckResult {
  files: RepositoryFile[];
  complete: boolean;
  reason?: CrossCheckSkipReason;
}
export async function crossCheckOtherLibraries(
  client: Pick<GraphClient, "get" | "post">,
  profile: Profile,
): Promise<CrossCheckResult>;
```

`complete` is true only when every other library was searched exhaustively. `reason` is present exactly when `complete` is false, and the three values are distinguishable because the operator's remedy differs: configure a region, investigate a failure, or narrow the scope.

**The extension.** Derived from `profile.naming.template`: the literal suffix from its final `.` onward. For `{year}-{month:02}_{client}_{deliverable}.xlsx` that is `xlsx`. If the segment after the final `.` contains `{`, the extension is not literal and no narrowing is applied. That is not an error: an unnarrowed search is correct, merely more expensive, and refusing to run would trade a working cross-check for none.

**The library qualifier** on each produced file is the name of the drive that was being searched, taken from `listDrives`. It is never parsed out of a hit's `webUrl`. The URL carries the library's URL name, `Shared Documents`, while a profile carries its display name, `Documents`, and the two differ. Parsing would work against every fixture this repository can write and break on the first customer with a renamed library.

**The path** on each produced file is the hit's `webUrl` path relative to the searched library's own root, so a qualified file's path means the same thing a local file's path means.

- [ ] **Step 1: Write the failing tests**

Cover: a profile with no `searchRegion` returning `complete: false` and `reason: "no-region"` with no search issued at all; a site with only the profile's own library returning `complete: true` and no files; a site with one other library returning its hits qualified by that library's name; a search throwing being caught and returning `reason: "search-failed"` rather than propagating; one library hitting the page cap making the whole result incomplete with `reason: "page-cap-reached"` even when other libraries completed; and a template with a non-literal extension issuing an unnarrowed search rather than failing.

```typescript
it("issues no search at all when the profile carries no region", async () => {
  let calls = 0;
  const client = { get: (async () => { calls += 1; return {}; }) as never, post: (async () => { calls += 1; return {}; }) as never };

  const result = await crossCheckOtherLibraries(client, profileWithoutRegion);

  expect(result).toEqual({ files: [], complete: false, reason: "no-region" });
  // Not merely "returns incomplete": it must not spend a request either.
  expect(calls).toBe(0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/scan/cross-check.test.ts tests/scan/cross-check.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/scan/cross-check.js`.

- [ ] **Step 3: Implement `src/scan/cross-check.ts`**

- [ ] **Step 4: Run the tests**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scan/cross-check.ts tests/scan/cross-check.test.ts tests/scan/cross-check.errors.test.ts
git commit -m "feat(scan): search the site's other libraries for filed-away deliverables"
```

---

### Task 5: Wire it in, and say which degradation this is

**Files:**
- Modify: `src/scan/snapshot.ts:49-56` (`assembleSnapshot`)
- Modify: `src/scan/run.ts` or the caller that assembles a snapshot, to invoke the cross-check
- Modify: `src/tools/reconciliation/text.ts:151-158` (the degraded sentence)
- Modify: `src/tools/reconciliation/output.ts` and `shape.ts` if the reason must reach `structuredContent`
- Test: `tests/scan/snapshot.test.ts`, `tests/tools/reconciliation/text.test.ts`

**Interfaces:**
- Consumes: `crossCheckOtherLibraries` and `CrossCheckSkipReason` from `src/scan/cross-check.js`.
- Produces: no new public signature; `searchCrossCheckIncluded` becomes true when the cross-check completed.

`assembleSnapshot` currently hardcodes `searchCrossCheckIncluded: false` with a comment saying phase 2a runs no cross-check. Both must change. The flag becomes true only when the cross-check completed, and the cross-check's files join the snapshot's files.

**The report text.** `src/tools/reconciliation/text.ts:151` prints one sentence for every degradation. There are now three causes with three different remedies, and one sentence cannot serve them. An operator who has not configured a region needs to know that; one whose search failed needs to know something went wrong; one who hit the page cap needs to know the scan was too large. Give each its own sentence. Keep the existing consequence clause, that a correctly named file outside the taxonomy is invisible, since it is true in all three cases.

Do not write a sentence that names a cause the code did not establish. If the reason is absent, say only that the cross-check did not run.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/tools/reconciliation/text.test.ts
it("names the missing region as the reason when that is why the cross-check was skipped", () => {
  const text = renderText(outputWithReason("no-region"));
  expect(text).toContain("searchRegion");
  expect(text).not.toContain("failed");
});

it("says a search failed when that is what happened", () => {
  const text = renderText(outputWithReason("search-failed"));
  expect(text).toContain("failed");
});

it("says the scan was too large when the page cap was reached", () => {
  const text = renderText(outputWithReason("page-cap-reached"));
  expect(text).toMatch(/too many|page cap|too large/i);
});

it("claims no cause when none was recorded", () => {
  const text = renderText(outputWithoutReason());
  expect(text).toContain("did not run");
});
```

```typescript
// tests/scan/snapshot.test.ts
it("marks the snapshot complete only when the cross-check completed", () => {
  expect(assembleSnapshot(records, at, undefined, { files: [], complete: true }).searchCrossCheckIncluded).toBe(true);
  expect(assembleSnapshot(records, at, undefined, { files: [], complete: false, reason: "no-region" }).searchCrossCheckIncluded).toBe(false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/scan/snapshot.test.ts tests/tools/reconciliation/`
Expected: FAIL.

- [ ] **Step 3: Implement the wiring**

- [ ] **Step 4: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(scan): include the cross-check in the snapshot and name its degradations"
```

---

## What this plan does not do

It does not search other sites. The server holds `Sites.Selected` on one site and Search is trimmed to that grant, verified live, so cross-site would require widening a permission the Decision Record protects.

It does not run against a tenant. When this is finished the cross-check should be exercised on the `helloironwright` site by creating a second document library, moving one seeded deliverable into it, and confirming the report moves that artifact from `missing` to `misplaced` while reporting no new orphans. That is a sitting, not part of this plan, and the no-new-orphans half is the more important of the two checks.
