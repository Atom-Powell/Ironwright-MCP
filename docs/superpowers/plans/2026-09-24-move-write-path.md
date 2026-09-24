# Phase 6b-1 Same-Library Move Write Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `generate_move_plan` and `execute_move_plan` for files the reconciliation engine finds in the wrong folder of the profile's own library, by generalizing phase 6a's rename write path rather than duplicating it.

**Architecture:** One Graph verb, `relocateDriveItem`, changes a driveItem's name, folder, or both in one PATCH. One executor, `applyPlan` in `src/tools/plans/apply.ts`, applies any stored plan; `execute_rename_plan` and `execute_move_plan` are thin wrappers that each refuse the other's plan kind. The pure pairing of misplaced artifacts to their canonical paths lives in `src/domain/move/plan.ts`, sharing collision rules with the rename pairing through `src/domain/plans/collisions.ts`.

**Tech Stack:** TypeScript, Node, `@modelcontextprotocol/sdk` 1.30.0, Zod, `@azure/data-tables`, vitest.

## Global Constraints

Every task's requirements implicitly include all of these. They come from `CLAUDE.md` and from the spec at `docs/superpowers/specs/2026-09-22-move-write-path-design.md`, including its section "What the probe found, 2026-09-24".

- **No em dashes and no en dashes anywhere**, including inside string literals, comments, docs and commit messages. `tests/source-hygiene.test.ts` enforces it across tracked TS, JS, JSON, Markdown and YAML.
- **No emojis or icons anywhere.** **US English throughout.**
- **The domain layer is pure.** Nothing under `src/domain/` may perform I/O. Lint enforces it.
- **A function that cannot observe an outcome must not assert it.** No message may claim something the code did not verify.
- **Comments explain why, not what**, especially around Graph behavior.
- **Counts are computed over the complete set before any truncation.** A listing may be a prefix; its count must not be.
- **Every tool input field description contains the words "for example"**, enforced by `tests/tools/contract.test.ts`.
- **A tool's `inputSchema` is a plain `z.object({...})`**, never a refined schema.
- **The refactor in Task 4 is behavior-preserving.** Every existing test under `tests/tools/rename/`, `tests/graph/rename*.test.ts` and `tests/domain/rename/` passes with no edits beyond import paths. If a rename assertion has to change in Task 4, stop and report: the refactor changed behavior. The only task allowed to change rename assertions is Task 8, which changes them deliberately.
- **Every move sends `"@microsoft.graph.conflictBehavior": "fail"` in the PATCH body.** A rename that keeps its folder sends exactly `{ name }` as today.
- **Test file naming:** happy-path assertions in `X.test.ts`, failure and edge assertions in `X.errors.test.ts`.
- **Conventional commits**, ending with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Run `npm run lint`, `npm run typecheck` and `npm test` before every commit.

---

## File Structure

**Created:**

- `.superpowers/live-sitting/probe-move-encoding.ts` : a throwaway probe, not committed (`.superpowers/` is gitignored).
- `src/graph/relocate.ts` : `relocateDriveItem`, `parentReferencePath`, `etagOf`, `EmptyRelocationError`.
- `src/domain/plans/collisions.ts` : collision rules shared by the rename and move pairings, extracted from `src/domain/rename/plan.ts`.
- `src/domain/move/plan.ts` : `pairMisplacedArtifacts`, pure.
- `src/tools/plans/limits.ts` : `MAX_PLAN_ITEMS` and `MAX_PLAN_ITEMS_LISTED`, moved out of `src/tools/rename/output.ts`.
- `src/tools/plans/etags.ts` : the plan-time ETag fetch both generators use.
- `src/tools/plans/apply.ts` : the shared executor loop.
- `src/tools/plans/refusals.ts` : the "no such plan" and "wrong kind" refusals.
- `src/tools/move/output.ts`, `src/tools/move/generate.ts`, `src/tools/move/execute.ts`, `src/tools/move/text.ts`.
- Tests mirroring each under `tests/`.

**Modified:**

- `src/graph/rename.ts` : `renameDriveItem` delegates to `relocateDriveItem`; `etagOf` moves out.
- `src/store/types.ts`, `src/store/table.ts` : plan kind widens to `"rename" | "move"`, exclusion reasons widen.
- `src/tools/rename/ids.ts` : `"mov"` prefix.
- `src/tools/rename/output.ts`, `src/tools/rename/generate.ts`, `src/tools/rename/execute.ts` : use the shared modules.
- `src/domain/rename/plan.ts` : imports the shared collision rules.
- `src/tools/definitions/generate-move-plan.ts`, `src/tools/definitions/execute-move-plan.ts` : wired.
- `tests/tools/contract.test.ts` : one comment only (Task 7).
- `CLAUDE.md`, `docs/OPEN-ITEMS.md`, `docs/superpowers/specs/2026-09-11-repository-reconciliation-mcp-design.md`, `docs/superpowers/specs/2026-09-22-move-write-path-design.md` (Task 9).

---

## Task 1: Probe how `parentReference.path` must be encoded

The 2026-09-24 probe moved files only between folders named `src` and `dst`. Real taxonomy folders contain spaces (`09-September` does not, but a client named `Client A` does), and Graph returns `parentReference.path` percent-encoded. Which form a PATCH accepts, and how the library root is addressed, is unmeasured. This project's rule is that an unmeasured API surface gets the cheapest probe before code assumes it.

**Operator prerequisite:** the grant issuer is standing (secret expires 2026-10-01) and `.superpowers/live-sitting/env.sh` holds all six values. The grant is at `read`.

**Files:**
- Create: `.superpowers/live-sitting/probe-move-encoding.ts` (not committed)
- Modify: `docs/superpowers/specs/2026-09-22-move-write-path-design.md`

- [ ] **Step 1: Write the probe**

```ts
/**
 * Phase 6b-1 follow-up probe: how must parentReference.path be written?
 *
 *   Q7a a target folder containing a space, path segments unencoded
 *   Q7b the same folder, each segment encodeURIComponent-encoded
 *   Q7c a target folder containing "#" and "%", encoded
 *   Q7d the library root as "/drives/{id}/root:"
 *
 * Runs as the SERVER application. Creates and deletes its own scratch folder.
 *
 *   set -a; source .superpowers/live-sitting/env.sh; set +a
 *   npx tsx .superpowers/live-sitting/probe-move-encoding.ts
 */
import { writeFileSync } from "node:fs";
import { clientCredentialsTokenProvider } from "../../src/graph/token.js";
import { createGraphClient, GRAPH_BASE } from "../../src/graph/client.js";
import { resolveDrive } from "../../src/graph/drive.js";
import { driveItemPath } from "../../src/graph/paths.js";

const tokenProvider = clientCredentialsTokenProvider({
  tenantId: process.env.IW_TENANT_ID ?? "",
  clientId: process.env.IW_CLIENT_ID ?? "",
  clientSecret: process.env.IW_CLIENT_SECRET ?? "",
});
const token = await tokenProvider.getToken();
const client = createGraphClient({ tokenProvider });
const { driveId } = await resolveDrive(client, process.env.IW_SITE_URL ?? "", "Documents");
const scratch = `_iw-probe-6b-enc-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const results: Record<string, unknown> = { scratch, ranAt: new Date().toISOString() };

async function call(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...extra };
  let payload: string | undefined;
  if (typeof body === "string") {
    headers["content-type"] = "text/plain";
    payload = body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${GRAPH_BASE}${url}`, { method, headers, body: payload });
  const text = await response.text();
  const json = text.length === 0 ? undefined : (JSON.parse(text) as Record<string, unknown>);
  return { status: response.status, text, json };
}
const item = (path: string) => driveItemPath(driveId, path);
const encoded = (folder: string) => folder.split("/").map(encodeURIComponent).join("/");

async function folder(parent: string, name: string) {
  const at = parent === "" ? `/drives/${driveId}/root/children` : `${item(parent)}/children`;
  const raw = await call("POST", at, { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
  if (raw.status >= 300) throw new Error(`create ${parent}/${name}: ${raw.status} ${raw.text}`);
}
async function upload(path: string) {
  const raw = await call("PUT", `${item(path)}/content`, "x");
  if (raw.status >= 300) throw new Error(`upload ${path}: ${raw.status} ${raw.text}`);
  return String(raw.json?.eTag ?? "");
}
async function present(path: string) {
  return (await call("GET", item(path))).status === 200;
}
async function move(label: string, from: string, parentPath: string, expectAt: string) {
  const etag = await upload(from);
  const raw = await call(
    "PATCH",
    item(from),
    { parentReference: { path: parentPath }, "@microsoft.graph.conflictBehavior": "fail" },
    { "if-match": etag },
  );
  results[label] = { sent: parentPath, status: raw.status, body: raw.status >= 300 ? raw.text : undefined, landed: await present(expectAt), leftSource: await present(from) };
  console.log(label, JSON.stringify(results[label]));
}

await folder("", scratch);
try {
  await folder(scratch, "src");
  await folder(scratch, "Client A");
  await folder(scratch, "hash#pct%");
  const s = `${scratch}/src`;
  await move("Q7a space, unencoded", `${s}/a.txt`, `/drives/${driveId}/root:/${scratch}/Client A`, `${scratch}/Client A/a.txt`);
  await move("Q7b space, encoded", `${s}/b.txt`, `/drives/${driveId}/root:/${encoded(`${scratch}/Client A`)}`, `${scratch}/Client A/b.txt`);
  await move("Q7c hash and percent, encoded", `${s}/c.txt`, `/drives/${driveId}/root:/${encoded(`${scratch}/hash#pct%`)}`, `${scratch}/hash#pct%/c.txt`);
  const rootName = `${scratch}-root-probe.txt`;
  await move("Q7d library root", `${s}/${rootName}`, `/drives/${driveId}/root:`, rootName);
  await call("DELETE", item(rootName));
} finally {
  const removed = await call("DELETE", item(scratch));
  results.cleanup = removed.status;
  console.log("cleanup", removed.status);
  writeFileSync(new URL("./probe-move-encoding-results.json", import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
}
```

- [ ] **Step 2: Widen the grant, run the probe, restore the grant**

```bash
set -a; source .superpowers/live-sitting/env.sh; set +a
npx tsx .superpowers/live-sitting/set-site-role.ts write
timeout 300 npx tsx .superpowers/live-sitting/probe-move-encoding.ts
npx tsx .superpowers/live-sitting/set-site-role.ts read
```

Expected: the second `set-site-role` prints `after: roles=["read"]` whatever the probe did. Run it even if the probe throws.

- [ ] **Step 3: Record the answer and settle the encoding rule**

Add a subsection "Question 7, 2026-09-24: encoding" under "What the probe found" in the 6b-1 spec, stating each case's status and whether the file landed. Then settle one rule:

- If Q7b and Q7c landed: the verb encodes each segment with `encodeURIComponent`. This is what Task 2's code does.
- If only Q7a landed: the verb sends segments unencoded, and a folder whose name contains `#` or `%` cannot be moved into. Change `parentReferencePath` in Task 2 to join raw segments, change its test expectations to match, and add a plan-time exclusion reason for such a folder before Task 5 is started. Stop and ask the operator before proceeding, since this adds an exclusion reason the spec does not list.
- If Q7d did not land: a move into the library root is excluded at plan time as `target_folder_absent` would be. Stop and ask the operator how to name that reason.

- [ ] **Step 4: Commit the spec change**

```bash
git add docs/superpowers/specs/2026-09-22-move-write-path-design.md
git commit -m "docs(spec): record how a move's parentReference path must be encoded"
```

---

## Task 2: The `relocateDriveItem` verb

**Files:**
- Create: `src/graph/relocate.ts`
- Modify: `src/graph/rename.ts`
- Test: `tests/graph/relocate.test.ts`, `tests/graph/relocate.errors.test.ts`

**Interfaces:**
- Produces:
  - `relocateDriveItem(client: Pick<GraphClient, "patch">, args: { driveId: string; path: string; etag: string; newName?: string; newParentPath?: string }): Promise<RelocateOutcome>`
  - `type RelocateOutcome = { kind: "relocated"; etag: string | undefined } | { kind: "precondition_failed" } | { kind: "not_found" }`
  - `parentReferencePath(driveId: string, folder: string): string`
  - `etagOf(item: unknown): string | undefined`
  - `class EmptyRelocationError extends Error`

- [ ] **Step 1: Write the failing tests**

`tests/graph/relocate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parentReferencePath, relocateDriveItem } from "../../src/graph/relocate.js";

function recordingClient(response: unknown = { eTag: '"{GUID},2"' }) {
  const calls: Array<{ path: string; body: unknown; headers?: Record<string, string> }> = [];
  return {
    calls,
    patch: async <T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> => {
      calls.push({ path, body, ...(headers === undefined ? {} : { headers }) });
      return response as T;
    },
  };
}

describe("parentReferencePath", () => {
  it("writes the folder path raw, since it travels in the JSON body and Graph rejects an encoded one", () => {
    expect(parentReferencePath("d1", "2026/Client A/hash#pct%")).toBe("/drives/d1/root:/2026/Client A/hash#pct%");
  });

  it("addresses the library root with no trailing segment", () => {
    expect(parentReferencePath("d1", "")).toBe("/drives/d1/root:");
  });
});

describe("relocateDriveItem", () => {
  it("sends only the name for a rename, with no conflict behavior", async () => {
    const client = recordingClient();
    await relocateDriveItem(client, { driveId: "d1", path: "a/old.xlsx", etag: "e1", newName: "new.xlsx" });

    expect(client.calls[0]?.body).toEqual({ name: "new.xlsx" });
    expect(client.calls[0]?.headers?.["if-match"]).toBe("e1");
  });

  it("sends the parent reference and conflictBehavior fail for a move", async () => {
    const client = recordingClient();
    await relocateDriveItem(client, { driveId: "d1", path: "a/f.xlsx", etag: "e1", newParentPath: "b" });

    expect(client.calls[0]?.path).toBe("/drives/d1/root:/a/f.xlsx:");
    expect(client.calls[0]?.body).toEqual({
      parentReference: { path: "/drives/d1/root:/b" },
      "@microsoft.graph.conflictBehavior": "fail",
    });
  });

  it("sends name and parent together for a move that also renames", async () => {
    const client = recordingClient();
    await relocateDriveItem(client, { driveId: "d1", path: "a/x.xlsx", etag: "e1", newName: "y.xlsx", newParentPath: "b" });

    expect(client.calls[0]?.body).toEqual({
      name: "y.xlsx",
      parentReference: { path: "/drives/d1/root:/b" },
      "@microsoft.graph.conflictBehavior": "fail",
    });
  });

  it("returns the new etag the response carries", async () => {
    const client = recordingClient({ eTag: '"{GUID},9"' });
    await expect(
      relocateDriveItem(client, { driveId: "d1", path: "a/f.xlsx", etag: "e1", newParentPath: "b" }),
    ).resolves.toEqual({ kind: "relocated", etag: '"{GUID},9"' });
  });
});
```

`tests/graph/relocate.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EmptyRelocationError, relocateDriveItem } from "../../src/graph/relocate.js";
import { GraphRequestError } from "../../src/graph/errors.js";

function failingClient(status: number, body = "{}") {
  return {
    patch: async <T>(path: string): Promise<T> => {
      throw new GraphRequestError({ method: "PATCH", path, status, body });
    },
  };
}

const MOVE = { driveId: "d1", path: "a/f.xlsx", etag: "e1", newParentPath: "b" };

describe("relocateDriveItem failures", () => {
  it("refuses a call that changes neither name nor folder, before any request", async () => {
    let called = false;
    const client = { patch: async <T>(): Promise<T> => { called = true; return {} as T; } };

    await expect(relocateDriveItem(client, { driveId: "d1", path: "a/f.xlsx", etag: "e1" })).rejects.toBeInstanceOf(
      EmptyRelocationError,
    );
    expect(called).toBe(false);
  });

  it("maps a 412 to a failed precondition", async () => {
    await expect(relocateDriveItem(failingClient(412), MOVE)).resolves.toEqual({ kind: "precondition_failed" });
  });

  it("maps a 404 to not found", async () => {
    await expect(relocateDriveItem(failingClient(404), MOVE)).resolves.toEqual({ kind: "not_found" });
  });

  it("rethrows the 400 an absent target folder answers, which is indistinguishable from any bad request", async () => {
    await expect(relocateDriveItem(failingClient(400, '{"error":{"code":"invalidRequest"}}'), MOVE)).rejects.toBeInstanceOf(
      GraphRequestError,
    );
  });

  it("reports an absent etag for each shape a bodiless response can take", async () => {
    for (const response of [{}, undefined, null]) {
      const client = { patch: async <T>(): Promise<T> => response as T };
      await expect(relocateDriveItem(client, MOVE)).resolves.toEqual({ kind: "relocated", etag: undefined });
    }
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/graph/relocate`
Expected: FAIL, cannot find module `src/graph/relocate.js`.

- [ ] **Step 3: Write `src/graph/relocate.ts`**

```ts
import type { GraphClient } from "./client.js";
import { GraphRequestError } from "./errors.js";
import { driveItemPath } from "./paths.js";

/**
 * The three responses a relocation can produce, kept apart rather than
 * collapsed into success-or-throw, for the reasons `renameDriveItem` records:
 * a 412 is the expected outcome of a plan applied against a library other
 * people use, and Graph evaluates If-Match before existence, so a 404 is
 * unreachable while every call carries a precondition. It is mapped anyway,
 * since a branch on a write path is not removed on the strength of a negative
 * nobody can prove.
 *
 * An absent target folder answers 400 `invalidRequest` with the generic message
 * "Invalid request" (measured 2026-09-24), which cannot be told apart from any
 * other malformed request, so it is rethrown rather than given an outcome of
 * its own. Plan generation excludes that case before it can reach here.
 */
export type RelocateOutcome =
  | { kind: "relocated"; etag: string | undefined }
  | { kind: "precondition_failed" }
  | { kind: "not_found" };

export class EmptyRelocationError extends Error {
  constructor(path: string) {
    super(
      `A relocation of "${path}" named neither a new name nor a new folder. Refused before any request, because ` +
        "a PATCH with an empty body would succeed while changing nothing, and the executor would count it as applied.",
    );
    this.name = "EmptyRelocationError";
  }
}

/**
 * An empty string is treated as absent. Graph does not return one, but an
 * empty etag is not a usable If-Match precondition either way.
 *
 * The null and undefined guard is not defensive padding. `createGraphClient`'s
 * `request()` returns `undefined as T` for a zero-length body, and a 204 passes
 * its success check, so a PATCH answered with no body reaches this function as
 * `undefined`. Reading a property off that once made the executor report a
 * rename that HAD happened as failed.
 */
export function etagOf(item: unknown): string | undefined {
  if (item === null || item === undefined) return undefined;
  const value = (item as { eTag?: unknown }).eTag;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The target folder of a move, in the form the 2026-09-24 probes measured
 * Graph accepting: `/drives/{driveId}/root:/{folder}` with the folder written
 * RAW. Unlike `driveItemPath`, this value travels in the JSON body rather than
 * the URL, and Graph answered an `encodeURIComponent`-encoded folder with the
 * same generic 400 an absent folder gets, while raw names containing a space,
 * `#`, `%`, `&`, `'`, `+`, `;`, `,` and non-ASCII letters all landed. Encoding
 * it because Graph returns `parentReference.path` encoded is the natural
 * mistake, and it would read as a missing folder rather than an encoding
 * error. The library root is `root:` with nothing after it, also measured.
 */
export function parentReferencePath(driveId: string, folder: string): string {
  const trimmed = folder.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return `/drives/${driveId}/root:`;
  return `/drives/${driveId}/root:/${trimmed}`;
}

/**
 * Renames a driveItem, moves it to another folder of the same drive, or both,
 * in one PATCH addressed by path. The 2026-09-24 probe measured one PATCH
 * carrying `name` and `parentReference` applying both.
 *
 * A move always sends `conflictBehavior: fail`. Graph's default already refused
 * an occupied target name with 409 when measured, but that default is
 * undocumented, and a replace would silently destroy the file already there. A
 * rename that keeps its folder sends exactly `{ name }`, the body phase 6a
 * verified live, so nothing about a rename changes.
 *
 * The etag is supplied by the caller rather than read here, for the reason
 * `renameDriveItem` gives: a verb that fetched its own precondition would race
 * itself.
 */
export async function relocateDriveItem(
  client: Pick<GraphClient, "patch">,
  args: { driveId: string; path: string; etag: string; newName?: string; newParentPath?: string },
): Promise<RelocateOutcome> {
  if (args.newName === undefined && args.newParentPath === undefined) {
    throw new EmptyRelocationError(args.path);
  }

  const body: Record<string, unknown> = {};
  if (args.newName !== undefined) body.name = args.newName;
  if (args.newParentPath !== undefined) {
    body.parentReference = { path: parentReferencePath(args.driveId, args.newParentPath) };
    body["@microsoft.graph.conflictBehavior"] = "fail";
  }

  try {
    const updated = await client.patch<unknown>(driveItemPath(args.driveId, args.path), body, {
      "if-match": args.etag,
    });
    return { kind: "relocated", etag: etagOf(updated) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 412) return { kind: "precondition_failed" };
    if (error instanceof GraphRequestError && error.status === 404) return { kind: "not_found" };
    throw error;
  }
}
```

- [ ] **Step 4: Make `renameDriveItem` delegate**

In `src/graph/rename.ts`, delete the local `etagOf` function and its comment, import `etagOf` and `relocateDriveItem` from `./relocate.js`, and replace the body of `renameDriveItem` (keep its doc comment, adding one sentence at the end: "It is now a thin form of `relocateDriveItem` that never changes the folder, kept so the body phase 6a verified live stays pinned by 6a's own tests."):

```ts
export async function renameDriveItem(
  client: Pick<GraphClient, "patch">,
  args: { driveId: string; path: string; newName: string; etag: string },
): Promise<RenameOutcome> {
  const outcome = await relocateDriveItem(client, {
    driveId: args.driveId,
    path: args.path,
    etag: args.etag,
    newName: args.newName,
  });
  return outcome.kind === "relocated" ? { kind: "renamed", etag: outcome.etag } : outcome;
}
```

Remove the now-unused `GraphRequestError` import only if lint reports it unused; `readDriveItemEtag` still uses it.

- [ ] **Step 5: Run the new and the existing verb tests**

Run: `npx vitest run tests/graph/relocate tests/graph/rename`
Expected: PASS, with `tests/graph/rename*.test.ts` unedited.

- [ ] **Step 6: Commit**

```bash
git add src/graph/relocate.ts src/graph/rename.ts tests/graph/relocate.test.ts tests/graph/relocate.errors.test.ts
git commit -m "feat(graph): add relocateDriveItem for a move, a rename, or both in one PATCH"
```

---

## Task 3: Stored plans of kind `move`

**Files:**
- Modify: `src/store/types.ts`, `src/store/table.ts`, `src/tools/rename/ids.ts`
- Test: `tests/store/conformance.ts`, `tests/store/plans.errors.test.ts`

**Interfaces:**
- Produces:
  - `type PlanKind = "rename" | "move"`
  - `type MoveOnlyExclusionReason = "in_another_library" | "target_folder_absent"`
  - `type MoveExclusionReason = PlanExclusionReason | MoveOnlyExclusionReason`
  - `interface ExcludedPlanItem<R extends string = MoveExclusionReason> { path; currentName; targetName; client; reason: R; library?: string }`
  - `StoredPlan.kind: PlanKind`, `StoredPlan.excluded: ExcludedPlanItem[]`
  - `type PlanIdPrefix = "rnm" | "mov" | "rev"`

- [ ] **Step 1: Write the failing tests**

In `tests/store/conformance.ts`, inside `stateStoreConformance`, after "round-trips a plan with all of its items and exclusions", add:

```ts
  it("round-trips a move plan, including an exclusion that names another library", async () => {
    const store = create();
    const plan: StoredPlan = {
      planId: "mov-2026-09-24-a1b2c3d4",
      profileId: "example",
      kind: "move",
      driveId: "d1",
      createdAt: "2026-09-24T12:00:00Z",
      items: [
        {
          path: "2026/CLIENTA/08-August/2026-09_CLIENTA_MonthlyTraining.xlsx",
          currentName: "2026-09_CLIENTA_MonthlyTraining.xlsx",
          targetName: "2026-09_CLIENTA_MonthlyTraining.xlsx",
          targetPath: "2026/CLIENTA/09-September/2026-09_CLIENTA_MonthlyTraining.xlsx",
          etag: '"{GUID},1"',
          client: "CLIENTA",
        },
      ],
      excluded: [
        {
          path: "2026/CLIENTB/09-September/2026-09_CLIENTB_MonthlyTraining.xlsx",
          currentName: "2026-09_CLIENTB_MonthlyTraining.xlsx",
          targetName: "2026-09_CLIENTB_MonthlyTraining.xlsx",
          client: "CLIENTB",
          reason: "in_another_library",
          library: "Archive",
        },
      ],
    };

    await store.savePlan("example", plan);

    await expect(store.getPlan("example", plan.planId)).resolves.toEqual(plan);
  });
```

In `tests/store/plans.errors.test.ts`, after the existing kind test, add:

```ts
  it("names both accepted kinds when it refuses an unknown one", async () => {
    const plans = new FakeTableClient();
    await plans.upsertEntity({ ...validEntity(), kind: "reversal" });
    const store = createTableStateStore({ deltaLinks: new FakeTableClient(), inventory: new FakeTableClient(), plans });

    await expect(store.getPlan("example", planId)).rejects.toThrow(/not "rename" or "move"/);
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/store`
Expected: FAIL. The conformance test fails typecheck-free at runtime on the Table store with `MalformedPlanEntityError` naming `kind`; the new errors test fails on the message.

- [ ] **Step 3: Widen the types**

In `src/store/types.ts`:

1. After `PlanExclusionReason`, add:

```ts
/**
 * Reasons only a move plan records. `in_another_library` means the Microsoft
 * Search cross-check found the file in a different document library of the
 * same site, and this server does not yet move files between libraries.
 * `target_folder_absent` means the folder the file belongs in does not exist,
 * and this slice creates no folders, since a folder's reversal is a delete.
 */
export type MoveOnlyExclusionReason = "in_another_library" | "target_folder_absent";

export type MoveExclusionReason = PlanExclusionReason | MoveOnlyExclusionReason;

export type PlanKind = "rename" | "move";
```

2. Replace `ExcludedPlanItem` with:

```ts
/**
 * Generic over its reason so each tool's output can state the narrower set its
 * own plans carry, while a stored plan holds the union.
 */
export interface ExcludedPlanItem<R extends string = MoveExclusionReason> {
  path: string;
  currentName: string;
  targetName: string;
  client: string;
  reason: R;
  /** The library the file was found in, present only for `in_another_library`. */
  library?: string;
}
```

3. In `RenamePlanItem`, change the `targetPath` comment to: `/** Library-relative path this item occupies once applied. The same folder as \`path\` for a rename, another folder for a move. */`

4. In `StoredPlan`, change `kind: "rename";` to `kind: PlanKind;`.

- [ ] **Step 4: Accept `move` in the Table reader**

In `src/store/table.ts`, replace:

```ts
        if (kind !== "rename") {
          throw new MalformedPlanEntityError(planId, "kind", `is "${kind}", not "rename"`);
        }
```

with:

```ts
        if (kind !== "rename" && kind !== "move") {
          throw new MalformedPlanEntityError(planId, "kind", `is "${kind}", not "rename" or "move"`);
        }
```

- [ ] **Step 5: Add the `mov` prefix**

In `src/tools/rename/ids.ts`: `export type PlanIdPrefix = "rnm" | "mov" | "rev";`

- [ ] **Step 6: Fix the one compile error the widening causes**

Run: `npm run typecheck`. `src/tools/rename/generate.ts` assigns `plan.excluded` (now the wider reason type) into `GenerateRenamePlanOutput.excluded`. Type the local array narrowly and build the output from it rather than from `plan.excluded`:

```ts
    const excluded: ExcludedPlanItem<PlanExclusionReason>[] = collisions.map(/* unchanged */);
    // ...
    const sortedExcluded = [...excluded].sort(comparePaths);
    const plan: StoredPlan = { /* unchanged fields */, excluded: sortedExcluded };
    // in the output:
      excluded: sortedExcluded.slice(0, MAX_PLAN_ITEMS_LISTED),
      excludedCount: sortedExcluded.length,
      excludedOmitted: Math.max(0, sortedExcluded.length - MAX_PLAN_ITEMS_LISTED),
```

and import `PlanExclusionReason` from `../../store/types.js`. `src/tools/rename/execute.ts` has the same error at its `excluded` output; leave it for Task 4, which rewrites that file, and silence nothing here: if typecheck still reports `execute.ts`, apply this minimal narrowing now so the commit is green:

```ts
    const excluded = [...plan.excluded].sort(comparePaths) as ExcludedPlanItem<PlanExclusionReason>[];
```

with a comment `// Narrowed properly in the next commit, which refuses a plan of any other kind first.`

- [ ] **Step 7: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/store/types.ts src/store/table.ts src/tools/rename/ids.ts src/tools/rename/generate.ts src/tools/rename/execute.ts tests/store/conformance.ts tests/store/plans.errors.test.ts
git commit -m "feat(store): persist move plans alongside rename plans"
```

---

## Task 4: One executor for every plan kind

Behavior-preserving. Every existing rename test passes unedited.

**Files:**
- Create: `src/tools/plans/limits.ts`, `src/tools/plans/etags.ts`, `src/tools/plans/apply.ts`, `src/tools/plans/refusals.ts`
- Modify: `src/tools/rename/output.ts`, `src/tools/rename/generate.ts`, `src/tools/rename/execute.ts`
- Test: `tests/tools/plans/apply.test.ts`, `tests/tools/rename/execute.errors.test.ts` (one added test)

**Interfaces:**
- Consumes: `relocateDriveItem` (Task 2), `StoredPlan` with `kind: PlanKind` (Task 3).
- Produces:
  - `MAX_PLAN_ITEMS = 200`, `MAX_PLAN_ITEMS_LISTED = 50` from `src/tools/plans/limits.ts`, still re-exported by `src/tools/rename/output.ts`.
  - `interface PlanCandidate { path: string; currentName: string; targetName: string; targetPath: string; client: string }`
  - `fetchPlanEtags(graph: Pick<GraphClient, "get">, driveId: string, candidates: readonly PlanCandidate[]): Promise<{ items: RenamePlanItem[]; excluded: ExcludedPlanItem<"no_etag_available" | "file_not_found_at_plan_time">[] }>`
  - `type AppliedOutcome = "applied" | "would_apply" | "precondition_refused" | "not_found" | "failed"`
  - `applyPlan(plan: StoredPlan, options: { confirm: boolean; context: ToolContext; profileId: string; toolName: string; makeReversalPlanId: () => string }): Promise<{ results: Array<{ item: RenamePlanItem; outcome: AppliedOutcome }>; graphOperationsIssued: number; reversalEntriesNotRefreshed: number; reversalPlanId?: string }>`
  - `comparePaths(a: { path: string }, b: { path: string }): number`
  - `noPlanStored(planId: string, profileId: string, generator: string): CallToolResult`
  - `wrongPlanKind(plan: StoredPlan, expected: PlanKind): CallToolResult`

- [ ] **Step 1: Write the failing tests**

`tests/tools/plans/apply.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyPlan } from "../../../src/tools/plans/apply.js";
import type { StoredPlan } from "../../../src/store/types.js";
import type { GraphClient } from "../../../src/graph/client.js";
import { createFakeToolContext } from "../fake-context.js";

/**
 * Records every PATCH body and answers with a fresh etag. Local rather than
 * shared: the rename fixtures' fakes read `body.name`, which a move that keeps
 * its name does not send.
 */
function recordingGraph(): GraphClient & { bodies: unknown[] } {
  const bodies: unknown[] = [];
  let requestCount = 0;
  let version = 0;
  const reject = () => {
    requestCount += 1;
    return Promise.reject(new Error("the recording fake implements only patch"));
  };
  return {
    bodies,
    get: reject,
    post: reject,
    getBytes: reject,
    async patch<T>(_path: string, body: unknown): Promise<T> {
      requestCount += 1;
      bodies.push(body);
      version += 1;
      return { eTag: `"{GUID},${String(version)}"` } as unknown as T;
    },
    requests: () => requestCount,
  };
}

function plan(kind: StoredPlan["kind"], items: StoredPlan["items"]): StoredPlan {
  return { planId: "p1", profileId: "example", kind, driveId: "drive-1", createdAt: "2026-09-24T12:00:00Z", items, excluded: [] };
}

const MOVED = {
  path: "2026/ACME/08-August/2026-09_ACME_MonthlyTraining.xlsx",
  currentName: "2026-09_ACME_MonthlyTraining.xlsx",
  targetName: "2026-09_ACME_MonthlyTraining.xlsx",
  targetPath: "2026/ACME/09-September/2026-09_ACME_MonthlyTraining.xlsx",
  etag: '"{GUID},1"',
  client: "ACME",
};

describe("applyPlan", () => {
  it("sends a folder change and no name for an item that keeps its name", async () => {
    const graph = recordingGraph();
    const context = createFakeToolContext({ graph });

    const result = await applyPlan(plan("move", [MOVED]), {
      confirm: true,
      context,
      profileId: "example",
      toolName: "execute_move_plan",
      makeReversalPlanId: () => "rev-1",
    });

    expect(result.results[0]?.outcome).toBe("applied");
    expect(graph.bodies[0]).toEqual({
      parentReference: { path: "/drives/drive-1/root:/2026/ACME/09-September" },
      "@microsoft.graph.conflictBehavior": "fail",
    });
  });

  it("writes a reversal of the same kind that returns each item to its original folder", async () => {
    const context = createFakeToolContext({ graph: recordingGraph() });

    const result = await applyPlan(plan("move", [MOVED]), {
      confirm: true,
      context,
      profileId: "example",
      toolName: "execute_move_plan",
      makeReversalPlanId: () => "rev-1",
    });
    const reversal = await context.store.getPlan("example", result.reversalPlanId ?? "");

    expect(reversal?.kind).toBe("move");
    expect(reversal?.reverses).toBe("p1");
    expect(reversal?.items[0]?.path).toBe(MOVED.targetPath);
    expect(reversal?.items[0]?.targetPath).toBe(MOVED.path);
  });

  it("contacts Graph not at all on a dry run", async () => {
    const graph = recordingGraph();
    const result = await applyPlan(plan("move", [MOVED]), {
      confirm: false,
      context: createFakeToolContext({ graph }),
      profileId: "example",
      toolName: "execute_move_plan",
      makeReversalPlanId: () => "rev-1",
    });

    expect(result.results[0]?.outcome).toBe("would_apply");
    expect(graph.requests()).toBe(0);
    expect(result.reversalPlanId).toBeUndefined();
  });
});
```

In `tests/tools/rename/execute.errors.test.ts`, add inside its top-level `describe` (import `createFakeToolContext` and `planWith` if not already imported there):

```ts
  it("refuses a move plan rather than applying it as a rename", async () => {
    const graph = renamingGraphClient();
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", { ...planWith([ITEM_A]), kind: "move" });

    const result = await runExecuteRenamePlan({ profileId: "example", planId: "rnm-2026-09-18-a1b2c3d4", confirm: true }, context);

    expect(result.isError).toBe(true);
    expect(result.content.map((c) => ("text" in c ? c.text : "")).join("")).toContain("execute_move_plan");
    expect(graph.calls).toEqual([]);
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/tools/plans tests/tools/rename/execute.errors.test.ts`
Expected: FAIL, module `src/tools/plans/apply.js` not found, and the rename refusal test fails because the move plan is applied.

- [ ] **Step 3: Create `src/tools/plans/limits.ts`**

Move the two constants and their full doc comments out of `src/tools/rename/output.ts` into this file unchanged, each `export const`. In `src/tools/rename/output.ts` replace them with:

```ts
export { MAX_PLAN_ITEMS, MAX_PLAN_ITEMS_LISTED } from "../plans/limits.js";
```

- [ ] **Step 4: Create `src/tools/plans/etags.ts`**

```ts
import type { GraphClient } from "../../graph/client.js";
import { readDriveItemEtag } from "../../graph/rename.js";
import type { ExcludedPlanItem, RenamePlanItem } from "../../store/types.js";

export interface PlanCandidate {
  path: string;
  currentName: string;
  targetName: string;
  targetPath: string;
  client: string;
}

export type EtagExclusionReason = "no_etag_available" | "file_not_found_at_plan_time";

/**
 * Fetches each candidate's precondition now rather than reading it from the
 * inventory. The inventory's etag comes from a delta snapshot that may be
 * hours old and is recorded as `item.eTag ?? ""`, so it can be empty; this
 * fetch measures the window that matters, generate to execute. The same call
 * confirms the file is still at that path under that name, because path
 * addressing puts the filename in the URL.
 *
 * Sequential, one lookup per candidate, which phase 6a measured as the whole
 * plan-time cost. The caller reports `candidates.length` as the lookup count.
 */
export async function fetchPlanEtags(
  graph: Pick<GraphClient, "get">,
  driveId: string,
  candidates: readonly PlanCandidate[],
): Promise<{ items: RenamePlanItem[]; excluded: ExcludedPlanItem<EtagExclusionReason>[] }> {
  const items: RenamePlanItem[] = [];
  const excluded: ExcludedPlanItem<EtagExclusionReason>[] = [];

  for (const candidate of candidates) {
    const lookup = await readDriveItemEtag(graph, { driveId, path: candidate.path });
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

  return { items, excluded };
}

function excludedFrom(candidate: PlanCandidate, reason: EtagExclusionReason): ExcludedPlanItem<EtagExclusionReason> {
  return {
    path: candidate.path,
    currentName: candidate.currentName,
    targetName: candidate.targetName,
    client: candidate.client,
    reason,
  };
}
```

In `src/tools/rename/generate.ts`, replace the `for (const candidate of candidates)` loop, the local `items` array, and the local `excludedFrom` function with:

```ts
    const fetched = await fetchPlanEtags(context.graph, scan.result.driveId, candidates);
    const items = fetched.items;
    excluded.push(...fetched.excluded);
```

keeping the comment that preceded the loop's fetch inside `fetchPlanEtags` only. Drop the `readDriveItemEtag` and `RenameCandidate` imports if they become unused.

- [ ] **Step 5: Create `src/tools/plans/refusals.ts`**

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PlanKind, StoredPlan } from "../../store/types.js";

export function noPlanStored(planId: string, profileId: string, generator: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `No plan "${planId}" is stored for profile "${profileId}". Generate one with ` +
          `${generator} and pass the id it returns. Nothing was changed.`,
      },
    ],
  };
}

/**
 * One reviewed tool name corresponds to one kind of write. Applying a move
 * plan through execute_rename_plan would work mechanically, since both run
 * the same executor, and that is exactly why it is refused: an operator who
 * approved "execute a rename plan" did not approve moving files.
 */
export function wrongPlanKind(plan: StoredPlan, expected: PlanKind): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `Plan "${plan.planId}" is a ${plan.kind} plan, and this tool applies only ${expected} plans. Apply it ` +
          `with execute_${plan.kind}_plan instead. Nothing was changed.`,
      },
    ],
  };
}
```

- [ ] **Step 6: Create `src/tools/plans/apply.ts`**

Move the loop out of `src/tools/rename/execute.ts` with every comment it carries, generalized as below. Comments that said "rename" now say "write" or "relocation" where they describe the loop rather than a rename specifically.

```ts
import { relocateDriveItem, type RelocateOutcome } from "../../graph/relocate.js";
import { readDriveItemEtag } from "../../graph/rename.js";
import type { RenamePlanItem, StoredPlan } from "../../store/types.js";
import type { ToolContext } from "../context.js";

export type AppliedOutcome = "applied" | "would_apply" | "precondition_refused" | "not_found" | "failed";

export interface AppliedItem {
  item: RenamePlanItem;
  outcome: AppliedOutcome;
}

export interface ApplyPlanResult {
  results: AppliedItem[];
  graphOperationsIssued: number;
  reversalEntriesNotRefreshed: number;
  reversalPlanId?: string;
}

export function comparePaths(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * (Carry the full comment from `reversalItemsFor` in rename/execute.ts.) The
 * swap is kind-independent: an item's `path` and `targetPath` are both full
 * paths, so swapping them undoes a rename, a move, or both at once.
 */
export function reversalItemsFor(items: readonly RenamePlanItem[]): RenamePlanItem[] {
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
 * What one item asks Graph to change, derived from the item rather than from
 * the plan's kind: a field is sent only when it differs. A rename item keeps
 * its folder, so it sends exactly `{ name }`, the body phase 6a verified live.
 */
function relocationFor(item: RenamePlanItem): { newName?: string; newParentPath?: string } {
  const from = parentOf(item.path);
  const to = parentOf(item.targetPath);
  return {
    ...(item.currentName === item.targetName ? {} : { newName: item.targetName }),
    ...(from === to ? {} : { newParentPath: to }),
  };
}

/**
 * Applies a stored plan of any kind, or previews it. (Carry the rest of
 * `runExecuteRenamePlan`'s doc comment about one loop for dry and confirmed
 * runs.)
 */
export async function applyPlan(
  plan: StoredPlan,
  options: { confirm: boolean; context: ToolContext; profileId: string; toolName: string; makeReversalPlanId: () => string },
): Promise<ApplyPlanResult> {
  const { confirm, context, profileId, toolName } = options;
  const sorted = [...plan.items].sort(comparePaths);
  const results: AppliedItem[] = [];
  let graphOperationsIssued = 0;
  let reversalEntriesNotRefreshed = 0;

  // (Carry the comment on the early reversal write.)
  let reversal: StoredPlan | undefined;
  if (confirm) {
    reversal = {
      planId: options.makeReversalPlanId(),
      profileId,
      kind: plan.kind,
      driveId: plan.driveId,
      createdAt: context.now().toISOString(),
      items: reversalItemsFor(sorted),
      excluded: [],
      reverses: plan.planId,
    };
    await context.store.savePlan(profileId, reversal);
  }

  for (const [index, item] of sorted.entries()) {
    if (!confirm) {
      results.push({ item, outcome: "would_apply" });
      continue;
    }
    if (reversal === undefined) continue; // (carry the "cannot happen" comment)

    // (Carry the comment on the PATCH's own error boundary.)
    let written: RelocateOutcome | "failed";
    try {
      graphOperationsIssued += 1;
      written = await relocateDriveItem(context.graph, {
        driveId: plan.driveId,
        path: item.path,
        etag: item.etag,
        ...relocationFor(item),
      });
    } catch (error) {
      console.error(`${toolName} could not apply "${item.path}" under plan "${plan.planId}"`, error);
      written = "failed";
    }

    let outcome: AppliedOutcome;
    if (written === "failed") {
      outcome = "failed";
    } else if (written.kind === "precondition_failed") {
      outcome = "precondition_refused";
    } else if (written.kind === "not_found") {
      // (Carry the unreachable-404 comment.)
      outcome = "not_found";
    } else {
      outcome = "applied";
      try {
        let fresh = written.etag;
        if (fresh === undefined) {
          // (Carry the "should is not does" comment.)
          graphOperationsIssued += 1;
          const lookup = await readDriveItemEtag(context.graph, { driveId: plan.driveId, path: item.targetPath });
          fresh = lookup.kind === "found" ? lookup.etag : undefined;
        }
        if (fresh === undefined) {
          reversalEntriesNotRefreshed += 1;
        } else {
          const entry = reversal.items[index];
          if (entry !== undefined) reversal.items[index] = { ...entry, etag: fresh };
          await context.store.savePlan(profileId, reversal);
        }
      } catch (error) {
        // (Carry the comment on why a bookkeeping failure never changes a settled outcome.)
        console.error(
          `${toolName} applied "${item.path}" under plan "${plan.planId}" but could not refresh its reversal entry`,
          error,
        );
        reversalEntriesNotRefreshed += 1;
      }
    }
    results.push({ item, outcome });
  }

  return {
    results,
    graphOperationsIssued,
    reversalEntriesNotRefreshed,
    ...(reversal === undefined ? {} : { reversalPlanId: reversal.planId }),
  };
}
```

Replace every `(Carry ...)` marker above with the verbatim comment it names from the current `src/tools/rename/execute.ts`. The markers exist in this plan only to avoid printing those comments twice; none may survive into the source.

- [ ] **Step 7: Rewrite `src/tools/rename/execute.ts` as a thin wrapper**

Keep `EXECUTE_RENAME_PLAN_INPUT_SCHEMA`, `InputObject`, `resultFor` and `countOf` exactly. Remove `comparePaths` and `reversalItemsFor` (now in `apply.ts`). The handler becomes:

```ts
const RENAME_OUTCOME: Record<AppliedOutcome, RenameItemOutcome> = {
  applied: "renamed",
  would_apply: "would_rename",
  precondition_refused: "precondition_refused",
  not_found: "not_found",
  failed: "failed",
};

function isRenameExclusionReason(reason: string): reason is PlanExclusionReason {
  return (PLAN_EXCLUSION_REASONS as readonly string[]).includes(reason);
}

/**
 * A rename plan's generator writes only rename reasons, so a foreign reason
 * here means the stored row contradicts its own kind. Refused rather than
 * passed through, because the output schema would reject it at the SDK and the
 * operator would see a validation error instead of the cause.
 */
function renameExclusionsOf(plan: StoredPlan): ExcludedPlanItem<PlanExclusionReason>[] {
  return plan.excluded.map((item) => {
    if (!isRenameExclusionReason(item.reason)) {
      throw new MalformedPlanEntityError(plan.planId, "excluded", `holds the reason "${item.reason}", which a rename plan cannot carry`);
    }
    return { ...item, reason: item.reason };
  });
}

export async function runExecuteRenamePlan(
  input: unknown,
  context: ToolContext,
  makeReversalPlanId: () => string = () => newPlanId("rev", context.now()),
): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "execute_rename_plan", profileId: args.profileId };

  try {
    const profile = context.profiles.get(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    const plan = await context.store.getPlan(args.profileId, args.planId);
    // (Keep the existing comment about the profileId half of this condition.)
    if (plan === undefined || plan.profileId !== args.profileId) {
      return noPlanStored(args.planId, args.profileId, "generate_rename_plan");
    }
    if (plan.kind !== "rename") return wrongPlanKind(plan, "rename");

    const applied = await applyPlan(plan, {
      confirm: args.confirm,
      context,
      profileId: args.profileId,
      toolName: "execute_rename_plan",
      makeReversalPlanId,
    });
    const results = applied.results.map((entry) => resultFor(entry.item, RENAME_OUTCOME[entry.outcome]));
    const excluded = renameExclusionsOf(plan).sort(comparePaths);

    const output: ExecuteRenamePlanOutput = {
      // Every field exactly as before, reading reversalPlanId,
      // reversalEntriesNotRefreshed and graphOperationsIssued from `applied`.
    };
    // return and catch exactly as before
  }
}
```

Fill `output` field by field from the existing code, which it must match exactly; the only differences are that `results` comes from `applied.results` and the three counters come from `applied`. Delete the Task 3 cast and its comment.

- [ ] **Step 8: Run the whole suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS. `git diff --stat tests/` shows only the two files this task added to or created. If any other rename test needed an edit, stop and report.

- [ ] **Step 9: Commit**

```bash
git add src/tools/plans src/tools/rename tests/tools/plans tests/tools/rename/execute.errors.test.ts
git commit -m "refactor(tools): share one plan executor and etag fetch across plan kinds"
```

---

## Task 5: The pure move pairing

**Files:**
- Create: `src/domain/plans/collisions.ts`, `src/domain/move/plan.ts`
- Modify: `src/domain/rename/plan.ts`
- Test: `tests/domain/move/plan.reconcile.test.ts`, `tests/domain/move/plan.errors.test.ts`

**Interfaces:**
- Produces:
  - From `collisions.ts`: `type CollisionReason`, `interface PlanCollision { path; currentName; targetName; client; reason: CollisionReason }`, `class RenameSlotContradictionError`, `parentOf(path)`, `joinPath(folder, name)`, `occupiedPaths(report): Set<string>`, `duplicateCollision(report, duplicate): PlanCollision`.
  - From `move/plan.ts`: `interface MoveCandidate { path; currentName; targetName; targetPath; client }`, `interface MoveExclusion extends ExcludedPlanItem<MoveExclusionReason>`-shaped object, `interface MovePairing { candidates: MoveCandidate[]; exclusions: MoveExclusion[] }`, `class MisplacedArtifactShapeError`, `pairMisplacedArtifacts(report: ReconciliationReport, folderPaths: readonly string[]): MovePairing`.

- [ ] **Step 1: Write the failing tests**

`tests/domain/move/plan.reconcile.test.ts`. Every test obtains its report from the real `reconcile()`, per the rule in `CLAUDE.md`:

```ts
import { describe, expect, it } from "vitest";
import { pairMisplacedArtifacts } from "../../../src/domain/move/plan.js";
import { reconcile } from "../../../src/domain/reconcile/index.js";
import type { RepositoryFile, RepositorySnapshot, WorkbookSnapshot } from "../../../src/domain/reconcile/index.js";
import { loadProfile } from "../reconcile/fixtures/load.js";

const PROFILE = loadProfile();
const CLIENT = "CLIENTX";
const JUNE = "2026/CLIENTX/06-June";
const MAY = "2026/CLIENTX/05-May";
const CANONICAL = "2026-06_CLIENTX_Safety.xlsx";
const MISNAMED = "CLIENTX Safety - June 2026.xlsx";
const AS_OF = { year: 2026, month: 6 };

function workbook(): WorkbookSnapshot {
  return { rows: [{ client: CLIENT, fields: { monthlySafety: true } }], rejectedRows: [], source: "test-fixture" };
}

function file(path: string, library?: string): RepositoryFile {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    size: 1,
    modified: "2026-06-14T09:00:00Z",
    etag: "e",
    ...(library === undefined ? {} : { library }),
  };
}

function repo(files: RepositoryFile[], folders: string[] = ["2026", `2026/${CLIENT}`, JUNE, MAY]): RepositorySnapshot {
  return { files, folderPaths: folders, scannedAt: "2026-06-14T09:00:00Z", searchCrossCheckIncluded: false };
}

function june(report: ReturnType<typeof reconcile>) {
  return report.artifacts.find((a) => a.client === CLIENT && a.period.month === 6);
}

describe("pairMisplacedArtifacts against a real reconcile() report", () => {
  it("moves a correctly named file into the folder it belongs in, keeping its name", () => {
    const snapshot = repo([file(`${MAY}/${CANONICAL}`)]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("misplaced");

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.exclusions).toEqual([]);
    expect(pairing.candidates).toEqual([
      { path: `${MAY}/${CANONICAL}`, currentName: CANONICAL, targetName: CANONICAL, targetPath: `${JUNE}/${CANONICAL}`, client: CLIENT },
    ]);
  });

  it("moves and renames a file that is both misnamed and misplaced, as one candidate", () => {
    const snapshot = repo([file(`${MAY}/${MISNAMED}`)]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("misnamed_and_misplaced");

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.candidates).toEqual([
      { path: `${MAY}/${MISNAMED}`, currentName: MISNAMED, targetName: CANONICAL, targetPath: `${JUNE}/${CANONICAL}`, client: CLIENT },
    ]);
  });

  it("excludes a file whose target folder does not exist", () => {
    const snapshot = repo([file(`${MAY}/${CANONICAL}`)], ["2026", `2026/${CLIENT}`, MAY]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.candidates).toEqual([]);
    expect(pairing.exclusions).toEqual([
      { path: `${MAY}/${CANONICAL}`, currentName: CANONICAL, targetName: CANONICAL, client: CLIENT, reason: "target_folder_absent" },
    ]);
  });

  it("excludes a file found in another library, naming that library", () => {
    const snapshot = repo([file(`${JUNE}/${CANONICAL}`, "Archive")]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("misplaced");

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.candidates).toEqual([]);
    expect(pairing.exclusions).toEqual([
      { path: `${JUNE}/${CANONICAL}`, currentName: CANONICAL, targetName: CANONICAL, client: CLIENT, reason: "in_another_library", library: "Archive" },
    ]);
  });

  it("excludes a misplaced copy when the canonical path is already filled", () => {
    const snapshot = repo([file(`${JUNE}/${CANONICAL}`), file(`${MAY}/${CANONICAL}`)]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("compliant");

    const pairing = pairMisplacedArtifacts(report, snapshot.folderPaths);

    expect(pairing.candidates).toEqual([]);
    expect(pairing.exclusions).toEqual([
      { path: `${MAY}/${CANONICAL}`, currentName: CANONICAL, targetName: CANONICAL, client: CLIENT, reason: "target_path_already_occupied" },
    ]);
  });

  it("leaves a misnamed file in the right folder to the rename plan", () => {
    const snapshot = repo([file(`${JUNE}/${MISNAMED}`)]);
    const report = reconcile(PROFILE, workbook(), snapshot, AS_OF);
    expect(june(report)?.state).toBe("misnamed");

    expect(pairMisplacedArtifacts(report, snapshot.folderPaths)).toEqual({ candidates: [], exclusions: [] });
  });
});
```

If any `expect(june(report)?.state)` precondition fails, the fixture is wrong about the engine, not the code under test: fix the fixture by tracing `computeState` in `src/domain/reconcile/match.ts`, never the assertion after it.

`tests/domain/move/plan.errors.test.ts` (a hand-built report is correct here, since the point is a shape the engine cannot produce):

```ts
import { describe, expect, it } from "vitest";
import { MisplacedArtifactShapeError, pairMisplacedArtifacts } from "../../../src/domain/move/plan.js";
import type { ReconciliationReport } from "../../../src/domain/reconcile/index.js";

function reportWith(artifact: ReconciliationReport["artifacts"][number]): ReconciliationReport {
  return { artifacts: [artifact], duplicates: [], orphans: [] } as unknown as ReconciliationReport;
}

describe("pairMisplacedArtifacts refusals", () => {
  it("refuses a misplaced finding whose file already sits in its expected folder", () => {
    const report = reportWith({
      client: "C",
      deliverable: "d",
      period: { year: 2026, month: 6 },
      expectedPath: "2026/C/06-June",
      expectedName: "right.xlsx",
      state: "misplaced",
      matched: { path: "2026/C/06-June/right.xlsx", name: "right.xlsx", etag: "e" },
    });

    expect(() => pairMisplacedArtifacts(report, ["2026/C/06-June"])).toThrow(MisplacedArtifactShapeError);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/domain/move`
Expected: FAIL, module `src/domain/move/plan.js` not found.

- [ ] **Step 3: Extract `src/domain/plans/collisions.ts`**

Move these out of `src/domain/rename/plan.ts` with their full comments, exported: `CollisionReason`, `RenameSlotContradictionError`, `parentOf`, `occupiedPaths`, `slotKeyOf` (not exported), `winnerFor` (not exported). Rename `RenameCollision` to `PlanCollision` here and `excludedFromDuplicate` to `duplicateCollision`, both exported. Add:

```ts
/**
 * A library-root artifact renders an empty expectedPath (an empty taxonomy),
 * so the join must not always insert a slash: that would produce a
 * leading-slash path this library's paths never carry.
 */
export function joinPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}
```

and use `joinPath` inside `duplicateCollision` where it previously built `targetPath` inline. Where a moved comment says "a rename plan", keep it; the rules were written for renames and still describe them.

In `src/domain/rename/plan.ts`, import those names from `../plans/collisions.js`, and keep the public surface unchanged with:

```ts
export { RenameSlotContradictionError, type CollisionReason } from "../plans/collisions.js";
export type RenameCollision = PlanCollision;
```

Use `joinPath` in `candidateFrom` in place of its inline ternary.

- [ ] **Step 4: Write `src/domain/move/plan.ts`**

`src/domain/` may not import from `src/store/` (the purity lint denies it), so the exclusion reason type is defined here rather than imported from `MoveExclusionReason`. The two must stay equal; Task 6's `AssertNever` over `MOVE_EXCLUSION_REASONS` catches a drift on the store side, and assigning a `MoveExclusion` into an `ExcludedPlanItem` in Task 6 catches one on this side.

```ts
import type { ArtifactFinding, ArtifactState, ReconciliationReport } from "../reconcile/index.js";
import { duplicateCollision, joinPath, occupiedPaths, parentOf, type CollisionReason } from "../plans/collisions.js";

export interface MoveCandidate {
  /** Library-relative, no leading slash. */
  path: string;
  currentName: string;
  targetName: string;
  /** Library-relative full path the file occupies once moved, in a different folder from `path`. */
  targetPath: string;
  client: string;
}

export type MoveExclusionKind = CollisionReason | "in_another_library" | "target_folder_absent";

export interface MoveExclusion {
  path: string;
  currentName: string;
  targetName: string;
  client: string;
  reason: MoveExclusionKind;
  /** Present only for `in_another_library`. */
  library?: string;
}

export interface MovePairing {
  candidates: MoveCandidate[];
  exclusions: MoveExclusion[];
}

/**
 * The states a move corrects. `misnamed` alone belongs to the rename plan, so
 * a file lands in exactly one kind of plan.
 */
const MOVE_STATES: ReadonlySet<ArtifactState> = new Set(["misplaced", "misnamed_and_misplaced"]);

export class MisplacedArtifactShapeError extends Error {
  constructor(detail: string) {
    super(
      `A misplaced artifact finding has a shape a move cannot act on: ${detail}. Misplaced means the file is in ` +
        "the wrong folder, so its match must sit outside the folder its expected path names. Refused rather than " +
        "guessed at, because a plan feeds straight into moving real files.",
    );
    this.name = "MisplacedArtifactShapeError";
  }
}

function base(artifact: ArtifactFinding, matched: NonNullable<ArtifactFinding["matched"]>) {
  return { path: matched.path, currentName: matched.name, targetName: artifact.expectedName, client: artifact.client };
}

/**
 * Turns a reconciliation report into the moves a plan holds, plus the files it
 * will not attempt and why. Pure, and over the whole report; the caller
 * narrows to the clients it was asked about, because the occupancy rule reads
 * paths belonging to clients a scoped call is excluding.
 *
 * Only a slot's winning artifact is ever a candidate. Every other file matching
 * that slot is a `DuplicateFinding`, demoted by `matchArtifacts`, and is
 * reported through the same duplicate rules the rename plan uses, never moved.
 *
 * `folderPaths` is the snapshot's own folder list. A target folder absent from
 * it is excluded rather than created, since creating a folder makes its
 * reversal a delete. The library root always exists, so an empty expected
 * path is never excluded on this ground.
 */
export function pairMisplacedArtifacts(report: ReconciliationReport, folderPaths: readonly string[]): MovePairing {
  const occupied = occupiedPaths(report);
  const folders = new Set(folderPaths);
  const candidates: MoveCandidate[] = [];
  const exclusions: MoveExclusion[] = [];

  for (const artifact of report.artifacts) {
    if (!MOVE_STATES.has(artifact.state)) continue;
    const matched = artifact.matched;
    // A misplaced finding with no match is not reachable from today's engine,
    // and names no contradiction: there is simply nothing to move.
    if (matched === undefined) continue;

    if (matched.library !== undefined) {
      // Found by the Microsoft Search cross-check in another library of the
      // same site. Moving between libraries is phase 6b-2, which begins with a
      // live probe of how Graph does it. No Graph request is spent here.
      exclusions.push({ ...base(artifact, matched), reason: "in_another_library", library: matched.library });
      continue;
    }
    if (parentOf(matched.path) === artifact.expectedPath) {
      throw new MisplacedArtifactShapeError(
        `"${matched.path}" already sits in its expected folder "${artifact.expectedPath}"`,
      );
    }
    if (artifact.expectedPath !== "" && !folders.has(artifact.expectedPath)) {
      exclusions.push({ ...base(artifact, matched), reason: "target_folder_absent" });
      continue;
    }

    const targetPath = joinPath(artifact.expectedPath, artifact.expectedName);
    // Expected to be unreachable for the reason occupiedPaths records: a file
    // at the canonical path parses to the same slot and wins it as compliant,
    // leaving this file a duplicate. Kept as a guard rather than removed.
    if (occupied.has(targetPath)) {
      exclusions.push({ ...base(artifact, matched), reason: "target_path_already_occupied" });
      continue;
    }
    candidates.push({ ...base(artifact, matched), targetPath });
  }

  for (const duplicate of report.duplicates) {
    // A duplicate carrying a library lives in another library and is not this
    // plan's to report, the same way the rename pairing skips one.
    if (!MOVE_STATES.has(duplicate.state) || duplicate.library !== undefined) continue;
    exclusions.push(duplicateCollision(report, duplicate));
  }

  return { candidates, exclusions };
}
```

- [ ] **Step 5: Run the domain suites and lint**

Run: `npm run lint && npx vitest run tests/domain`
Expected: PASS, with `tests/domain/rename/` unedited.

- [ ] **Step 6: Commit**

```bash
git add src/domain/plans src/domain/move src/domain/rename/plan.ts tests/domain/move
git commit -m "feat(domain): pair misplaced artifacts with their canonical paths"
```

---

## Task 6: Wire `generate_move_plan`

**Files:**
- Create: `src/tools/move/output.ts`, `src/tools/move/generate.ts`, `src/tools/move/text.ts`, `tests/tools/move/fixtures.ts`
- Modify: `src/tools/definitions/generate-move-plan.ts`
- Test: `tests/tools/move/generate.test.ts`, `tests/tools/move/generate.errors.test.ts`, `tests/tools/move/generate.wire.test.ts`

**Interfaces:**
- Consumes: `pairMisplacedArtifacts` (Task 5), `fetchPlanEtags`, `MAX_PLAN_ITEMS`, `MAX_PLAN_ITEMS_LISTED`, `comparePaths` (Task 4), `newPlanId("mov", ...)` (Task 3).
- Produces: `GENERATE_MOVE_PLAN_INPUT_SCHEMA`, `GENERATE_MOVE_PLAN_OUTPUT_SCHEMA`, `MOVE_EXCLUSION_REASONS`, `type GenerateMovePlanOutput`, `runGenerateMovePlan(input, context, readWorkbook?, makePlanId?)`, `generateMovePlanText(output): string[]`.

- [ ] **Step 1: Write the fixtures**

`tests/tools/move/fixtures.ts`, built on the example profile the tool tests use (taxonomy `{year}/{client}/{month:02}-{monthName}`, template `{year}-{month:02}_{client}_{deliverable}.xlsx`, clock 2026-09-14):

```ts
import type { RepositorySnapshot } from "../../../src/domain/reconcile/index.js";
import { file, snapshot } from "../rename/fixtures.js";

export const SEPT = "2026/ACME/09-September";
export const AUG = "2026/ACME/08-August";
export const CANONICAL_NAME = "2026-09_ACME_MonthlyTraining.xlsx";
export const MISNAMED_NAME = "2026-09_ACME_VendorTraining.xlsx";
export const MISPLACED_PATH = `${AUG}/${CANONICAL_NAME}`;
export const BOTH_WRONG_PATH = `${AUG}/${MISNAMED_NAME}`;
export const TARGET_PATH = `${SEPT}/${CANONICAL_NAME}`;

const FOLDERS = ["2026", "2026/ACME", AUG, SEPT];

/** September's report filed in August's folder under its canonical name. */
export function snapshotWithMisplacedFile(folders: string[] = FOLDERS): RepositorySnapshot {
  return snapshot([file(MISPLACED_PATH)], folders);
}

/** September's report filed in August's folder under the vendor-token name. */
export function snapshotWithBothWrong(): RepositorySnapshot {
  return snapshot([file(BOTH_WRONG_PATH)], FOLDERS);
}
```

- [ ] **Step 2: Write the failing tests**

`tests/tools/move/generate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runGenerateMovePlan } from "../../../src/tools/move/generate.js";
import type { GenerateMovePlanOutput } from "../../../src/tools/move/output.js";
import { contextWith, etagGraphClient, textOf, workbookFixture } from "../rename/fixtures.js";
import { BOTH_WRONG_PATH, CANONICAL_NAME, MISPLACED_PATH, TARGET_PATH, snapshotWithBothWrong, snapshotWithMisplacedFile } from "./fixtures.js";

const PLAN_ID = "mov-2026-09-14-a1b2c3d4";

async function generate(context: Parameters<typeof runGenerateMovePlan>[1], input: unknown = { profileId: "example" }) {
  return runGenerateMovePlan(input, context, () => Promise.resolve(workbookFixture()), () => PLAN_ID);
}

function outputOf(result: Awaited<ReturnType<typeof generate>>): GenerateMovePlanOutput {
  return result.structuredContent as unknown as GenerateMovePlanOutput;
}

describe("generate_move_plan", () => {
  it("plans a misplaced file into its canonical folder and persists the plan as kind move", async () => {
    const context = contextWith(etagGraphClient({ [MISPLACED_PATH]: '"{GUID},3"' }), snapshotWithMisplacedFile());

    const output = outputOf(await generate(context));
    const stored = await context.store.getPlan("example", PLAN_ID);

    expect(output.items).toEqual([
      { path: MISPLACED_PATH, currentName: CANONICAL_NAME, targetName: CANONICAL_NAME, targetPath: TARGET_PATH, client: "ACME" },
    ]);
    expect(stored?.kind).toBe("move");
    expect(stored?.items[0]?.etag).toBe('"{GUID},3"');
    expect(output.etagLookupsIssued).toBe(1);
  });

  it("plans a misnamed and misplaced file as one item that changes folder and name", async () => {
    const context = contextWith(etagGraphClient({ [BOTH_WRONG_PATH]: '"{GUID},3"' }), snapshotWithBothWrong());

    const output = outputOf(await generate(context));

    expect(output.items[0]).toMatchObject({ path: BOTH_WRONG_PATH, targetName: CANONICAL_NAME, targetPath: TARGET_PATH });
  });

  it("points the reader at execute_move_plan", async () => {
    const context = contextWith(etagGraphClient({ [MISPLACED_PATH]: '"{GUID},3"' }), snapshotWithMisplacedFile());

    expect(textOf(await generate(context))).toContain("execute_move_plan");
  });
});
```

`tests/tools/move/generate.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runGenerateMovePlan } from "../../../src/tools/move/generate.js";
import type { GenerateMovePlanOutput } from "../../../src/tools/move/output.js";
import { contextWith, etagGraphClient, workbookFixture } from "../rename/fixtures.js";
import { AUG, MISPLACED_PATH, snapshotWithMisplacedFile } from "./fixtures.js";

async function generate(context: Parameters<typeof runGenerateMovePlan>[1]) {
  return runGenerateMovePlan({ profileId: "example" }, context, () => Promise.resolve(workbookFixture()), () => "mov-1");
}

describe("generate_move_plan exclusions", () => {
  it("excludes a file whose target folder is absent and spends no etag lookup on it", async () => {
    const graph = etagGraphClient({});
    const context = contextWith(graph, snapshotWithMisplacedFile(["2026", "2026/ACME", AUG]));

    const output = (await generate(context)).structuredContent as unknown as GenerateMovePlanOutput;

    expect(output.itemCount).toBe(0);
    expect(output.excluded[0]).toMatchObject({ path: MISPLACED_PATH, reason: "target_folder_absent" });
    expect(graph.lookups).toEqual([]);
  });

  it("excludes a file that is gone by plan time", async () => {
    const context = contextWith(etagGraphClient({ [MISPLACED_PATH]: 404 }), snapshotWithMisplacedFile());

    const output = (await generate(context)).structuredContent as unknown as GenerateMovePlanOutput;

    expect(output.excluded[0]).toMatchObject({ reason: "file_not_found_at_plan_time" });
  });
});
```

`tests/tools/move/generate.wire.test.ts`: copy `tests/tools/rename/generate.wire.test.ts`, replacing `generateRenamePlan` with `generateMovePlan` (from `src/tools/definitions/generate-move-plan.js`), `runGenerateRenamePlan` with `runGenerateMovePlan`, the tool name string with `"generate_move_plan"`, the plan id with `"mov-2026-09-14-deadbeef"`, and the fixture with `etagGraphClient({ [MISPLACED_PATH]: '"{GUID},4"' })` over `snapshotWithMisplacedFile()`. Both of its tests stay: the error result has no `structuredContent`, and a success passes the SDK's output validation.

- [ ] **Step 3: Run them and see them fail**

Run: `npx vitest run tests/tools/move`
Expected: FAIL, module `src/tools/move/generate.js` not found.

- [ ] **Step 4: Write `src/tools/move/output.ts`**

Mirror `src/tools/rename/output.ts`'s generate half:

```ts
import { z } from "zod";
import type { MoveExclusionReason } from "../../store/types.js";
import { PLAN_EXCLUSION_REASONS } from "../rename/output.js";

export const MOVE_EXCLUSION_REASONS = [
  ...PLAN_EXCLUSION_REASONS,
  "in_another_library",
  "target_folder_absent",
] as const satisfies readonly MoveExclusionReason[];

// Exhaustive, for the reason rename/output.ts gives for its own list.
type AssertNever<T extends never> = T;
type _MoveExclusionReasonsExhaustive = AssertNever<Exclude<MoveExclusionReason, (typeof MOVE_EXCLUSION_REASONS)[number]>>;

export interface MoveExcludedItem {
  path: string;
  currentName: string;
  targetName: string;
  client: string;
  reason: MoveExclusionReason;
  library?: string;
}

export interface GenerateMovePlanOutput {
  planId: string;
  profileId: string;
  library: string;
  driveId: string;
  createdAt: string;
  scannedAt: string;
  items: Array<{ path: string; currentName: string; targetName: string; targetPath: string; client: string }>;
  itemCount: number;
  itemsOmitted: number;
  excluded: MoveExcludedItem[];
  excludedCount: number;
  excludedOmitted: number;
  workbookReadGraphRequestsByThisCall: number;
  etagLookupsIssued: number;
  scanGraphRequestsByThisCall: number;
  scanSharedWithConcurrentCall: boolean;
}

const EXCLUDED_ITEM = z.object({
  path: z.string(),
  currentName: z.string(),
  targetName: z.string(),
  client: z.string(),
  reason: z.enum(MOVE_EXCLUSION_REASONS),
  library: z.string().optional(),
});
```

then `GENERATE_MOVE_PLAN_OUTPUT_SCHEMA` with the same fields and descriptions as `GENERATE_RENAME_PLAN_OUTPUT_SCHEMA`, except:

- `planId`: "The id execute_move_plan consumes to apply this plan."
- `items` description: "What will be moved, sorted by path. targetPath is the full path the file occupies afterward; when targetName differs from currentName the same write also renames it. May be a prefix of the stored plan; see itemCount and itemsOmitted."
- `excluded` uses `z.array(EXCLUDED_ITEM)` and the description: "Misplaced files this plan will NOT attempt, each with why. in_another_library names the library the file was found in, which this server does not yet move files out of. target_folder_absent means the folder the file belongs in does not exist, and this server creates no folders. The three collision reasons mean the canonical path is already spoken for. no_etag_available and file_not_found_at_plan_time mean the file had no usable precondition when the plan was generated."

Export `EXCLUDED_ITEM` as `MOVE_EXCLUDED_ITEM_SCHEMA` for Task 7.

- [ ] **Step 5: Write `src/tools/move/text.ts`**

```ts
import type { GenerateMovePlanOutput } from "./output.js";

/** Every line states something the output carries, for the reason rename/text.ts gives. */
export function generateMovePlanText(output: GenerateMovePlanOutput): string[] {
  const lines = [
    `Plan ${output.planId} for profile "${output.profileId}", library "${output.library}".`,
    `${String(output.itemCount)} ${output.itemCount === 1 ? "move" : "moves"} planned, ${String(output.excludedCount)} excluded.`,
    `Based on a repository scan taken at ${output.scannedAt}.`,
  ];
  for (const item of output.items) lines.push(`  ${item.path} -> ${item.targetPath}`);
  if (output.itemsOmitted > 0) lines.push(`  ...and ${String(output.itemsOmitted)} more, all of them in the stored plan.`);
  for (const item of output.excluded) {
    lines.push(`  excluded: ${item.path} (${item.reason}${item.library === undefined ? "" : `, found in library "${item.library}"`})`);
  }
  if (output.excludedOmitted > 0) {
    lines.push(`  ...and ${String(output.excludedOmitted)} more exclusions, all of them in the stored plan.`);
  }
  lines.push(
    `Graph requests: ${String(output.workbookReadGraphRequestsByThisCall)} for the workbook, ` +
      `${String(output.scanGraphRequestsByThisCall)} for the scan. ` +
      `${String(output.etagLookupsIssued)} etag lookups issued, not counted as Graph requests since a retried ` +
      "lookup can spend more than one.",
  );
  lines.push("Review this plan, then apply it with execute_move_plan. It runs as a dry run unless confirm is true.");
  return lines;
}
```

- [ ] **Step 6: Write `src/tools/move/generate.ts`**

Structure it exactly as `src/tools/rename/generate.ts` after Task 4, with these differences:

```ts
export const GENERATE_MOVE_PLAN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Configured profile to plan against, for example \"example\"."),
  clients: z
    .array(z.string().min(1))
    .optional()
    .describe("Limit the plan to these clients, for example [\"CLIENTA\"]. Omit to cover every client in the workbook."),
} satisfies z.ZodRawShape;
```

- `subject.tool` is `"generate_move_plan"`; the default `makePlanId` is `() => newPlanId("mov", context.now())`.
- Pairing: `const pairing = pairMisplacedArtifacts(report, scan.result.snapshot.folderPaths);` then narrow `pairing.candidates` and `pairing.exclusions` by `scope` exactly as the rename generator does, with the same comment on why narrowing comes after pairing.
- The oversize refusal says "moves" instead of "renames".
- `const excluded: ExcludedPlanItem[] = exclusions.map((e) => ({ path: e.path, currentName: e.currentName, targetName: e.targetName, client: e.client, reason: e.reason, ...(e.library === undefined ? {} : { library: e.library }) }));`
- `const fetched = await fetchPlanEtags(context.graph, scan.result.driveId, candidates); excluded.push(...fetched.excluded);`
- `kind: "move"` on the stored plan; `generateMovePlanText` for the text; the log line says `generate_move_plan`.
- Doc comment: "Generates a reviewable move plan and persists it. It runs the reconciliation engine itself for the reason generate_rename_plan does: reconcile is the single public entry for a compliance verdict, and two tools deciding independently what misplaced means is what that rule prevents."

- [ ] **Step 7: Wire the definition**

Replace `src/tools/definitions/generate-move-plan.ts`:

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { GENERATE_MOVE_PLAN_INPUT_SCHEMA, runGenerateMovePlan } from "../move/generate.js";
import { GENERATE_MOVE_PLAN_OUTPUT_SCHEMA } from "../move/output.js";

export const generateMovePlan: ToolDefinition = {
  name: "generate_move_plan",
  kind: "plan",
  title: "Generate a move plan",
  description: [
    "Produce a reviewable plan that moves files filed in the wrong folder of the profile's own library into the folder the taxonomy requires, one entry per file, each recording the current path, the target path, and the file's ETag fetched at plan time. A file that is also misnamed is renamed by the same write.",
    "A file this server cannot move safely is recorded as excluded, with the reason, rather than attempted: it was found in a different document library, its target folder does not exist, its canonical path is already spoken for, or it had no usable ETag precondition when the plan was generated.",
    "Returns a plan id that execute_move_plan consumes. Review the plan before executing it.",
    SAFETY_SENTENCES.plan,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(GENERATE_MOVE_PLAN_INPUT_SCHEMA),
  outputSchema: GENERATE_MOVE_PLAN_OUTPUT_SCHEMA,
  handler: runGenerateMovePlan,
};
```

- [ ] **Step 8: Run the whole suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS, including `tests/tools/contract.test.ts` over the wired tool.

- [ ] **Step 9: Commit**

```bash
git add src/tools/move src/tools/definitions/generate-move-plan.ts tests/tools/move
git commit -m "feat(tools): wire generate_move_plan"
```

---

## Task 7: Wire `execute_move_plan`

**Files:**
- Create: `src/tools/move/execute.ts`
- Modify: `src/tools/move/output.ts`, `src/tools/move/text.ts`, `src/tools/definitions/execute-move-plan.ts`, `tests/tools/move/fixtures.ts`, `tests/tools/contract.test.ts` (one comment)
- Test: `tests/tools/move/execute.test.ts`, `tests/tools/move/execute.errors.test.ts`, `tests/tools/move/execute.wire.test.ts`

**Interfaces:**
- Consumes: `applyPlan`, `noPlanStored`, `wrongPlanKind`, `comparePaths` (Task 4); `MOVE_EXCLUDED_ITEM_SCHEMA`, `MoveExcludedItem` (Task 6).
- Produces: `EXECUTE_MOVE_PLAN_INPUT_SCHEMA`, `EXECUTE_MOVE_PLAN_OUTPUT_SCHEMA`, `MOVE_ITEM_OUTCOMES = ["moved", "would_move", "precondition_refused", "not_found", "failed"]`, `type ExecuteMovePlanOutput`, `runExecuteMovePlan(input, context, makeReversalPlanId?)`, `executeMovePlanText(output)`.

- [ ] **Step 1: Add a fake library that honors moves**

Add these imports to the top of `tests/tools/move/fixtures.ts`:

```ts
import { GraphRequestError } from "../../../src/graph/errors.js";
import type { GraphClient } from "../../../src/graph/client.js";
import type { StoredPlan } from "../../../src/store/types.js";
```

and append:

```ts
/**
 * A library holding files and folders that applies a PATCH the way the
 * 2026-09-24 probe measured Graph applying it: 412 on a stale If-Match, 400
 * for an absent target folder, 409 nameAlreadyExists for an occupied target
 * name, and otherwise the file relocated under a fresh etag naming its new
 * path. What it cannot prove is what SharePoint holds afterward; the live
 * sitting is the only evidence of that.
 */
export function movingLibraryGraphClient(files: Record<string, string>, folders: string[]): GraphClient & {
  paths: () => string[];
} {
  const state = new Map<string, string>(Object.entries(files));
  const folderSet = new Set(folders);
  let requestCount = 0;
  let version = 0;

  const encodedOf = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  const pathIn = (url: string) => [...state.keys()].find((path) => url.includes(`root:/${encodedOf(path)}:`));
  const parentOf = (path: string) => (path.lastIndexOf("/") === -1 ? "" : path.slice(0, path.lastIndexOf("/")));
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const fail = (url: string, status: number, code: string) =>
    new GraphRequestError({ method: "PATCH", path: url, status, body: JSON.stringify({ error: { code } }) });

  return {
    paths: () => [...state.keys()].sort(),
    async get<T>(url: string): Promise<T> {
      requestCount += 1;
      const path = pathIn(url);
      if (path === undefined) throw new GraphRequestError({ method: "GET", path: url, status: 404, body: "{}" });
      return { eTag: state.get(path) } as unknown as T;
    },
    post: () => {
      requestCount += 1;
      return Promise.reject(new Error("the fake moving library does not implement post"));
    },
    async patch<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T> {
      requestCount += 1;
      const path = pathIn(url);
      if (path === undefined) throw fail(url, 404, "itemNotFound");
      if (headers?.["if-match"] !== state.get(path)) throw fail(url, 412, "resourceModified");

      const request = body as { name?: string; parentReference?: { path: string } };
      let folder = parentOf(path);
      if (request.parentReference !== undefined) {
        // Raw, as Graph requires; see parentReferencePath.
        folder = request.parentReference.path.replace(/^\/drives\/[^/]+\/root:\/?/, "");
        if (folder !== "" && !folderSet.has(folder)) throw fail(url, 400, "invalidRequest");
      }
      const target = folder === "" ? (request.name ?? nameOf(path)) : `${folder}/${request.name ?? nameOf(path)}`;
      if (target !== path && state.has(target)) throw fail(url, 409, "nameAlreadyExists");

      version += 1;
      const etag = `etag-${String(version)}-for-${target}`;
      state.delete(path);
      state.set(target, etag);
      return { eTag: etag } as unknown as T;
    },
    getBytes: () => {
      requestCount += 2;
      return Promise.reject(new Error("the fake moving library does not implement getBytes"));
    },
    requests: () => requestCount,
  };
}

export const MOVE_ITEM = {
  path: MISPLACED_PATH,
  currentName: CANONICAL_NAME,
  targetName: CANONICAL_NAME,
  targetPath: TARGET_PATH,
  etag: "etag-0",
  client: "ACME",
};

export function movePlanWith(items: StoredPlan["items"], excluded: StoredPlan["excluded"] = []): StoredPlan {
  return {
    planId: "mov-2026-09-14-a1b2c3d4",
    profileId: "example",
    kind: "move",
    driveId: "drive-1",
    createdAt: "2026-09-14T12:00:00Z",
    items,
    excluded,
  };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/tools/move/execute.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runExecuteMovePlan } from "../../../src/tools/move/execute.js";
import type { ExecuteMovePlanOutput } from "../../../src/tools/move/output.js";
import { createFakeToolContext } from "../fake-context.js";
import { AUG, MISPLACED_PATH, MOVE_ITEM, SEPT, TARGET_PATH, movePlanWith, movingLibraryGraphClient } from "./fixtures.js";

const PLAN_ID = "mov-2026-09-14-a1b2c3d4";
const outputOf = (r: Awaited<ReturnType<typeof runExecuteMovePlan>>) => r.structuredContent as unknown as ExecuteMovePlanOutput;

describe("execute_move_plan", () => {
  it("previews without contacting Graph", async () => {
    const graph = movingLibraryGraphClient({ [MISPLACED_PATH]: "etag-0" }, [AUG, SEPT]);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", movePlanWith([MOVE_ITEM]));

    const output = outputOf(await runExecuteMovePlan({ profileId: "example", planId: PLAN_ID }, context));

    expect(output.dryRun).toBe(true);
    expect(output.counts.wouldMove).toBe(1);
    expect(graph.requests()).toBe(0);
  });

  it("moves the file and rolls it back through its own reversal plan", async () => {
    const graph = movingLibraryGraphClient({ [MISPLACED_PATH]: "etag-0" }, [AUG, SEPT]);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", movePlanWith([MOVE_ITEM]));

    const forward = outputOf(
      await runExecuteMovePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => "rev-1"),
    );
    expect(forward.counts.moved).toBe(1);
    expect(graph.paths()).toEqual([TARGET_PATH]);

    const back = outputOf(
      await runExecuteMovePlan({ profileId: "example", planId: "rev-1", confirm: true }, context, () => "rev-2"),
    );
    expect(back.reverses).toBe(PLAN_ID);
    expect(back.counts.moved).toBe(1);
    expect(graph.paths()).toEqual([MISPLACED_PATH]);
  });
});
```

`tests/tools/move/execute.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runExecuteMovePlan } from "../../../src/tools/move/execute.js";
import type { ExecuteMovePlanOutput } from "../../../src/tools/move/output.js";
import { createFakeToolContext } from "../fake-context.js";
import { planWith, ITEM_A } from "../rename/fixtures.js";
import { AUG, MISPLACED_PATH, MOVE_ITEM, SEPT, movePlanWith, movingLibraryGraphClient } from "./fixtures.js";

const PLAN_ID = "mov-2026-09-14-a1b2c3d4";
const outputOf = (r: Awaited<ReturnType<typeof runExecuteMovePlan>>) => r.structuredContent as unknown as ExecuteMovePlanOutput;

describe("execute_move_plan failures", () => {
  it("refuses a rename plan rather than applying it", async () => {
    const graph = movingLibraryGraphClient({}, []);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", { ...planWith([ITEM_A]), planId: PLAN_ID });

    const result = await runExecuteMovePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context);

    expect(result.isError).toBe(true);
    expect(result.content.map((c) => ("text" in c ? c.text : "")).join("")).toContain("execute_rename_plan");
    expect(graph.requests()).toBe(0);
  });

  it("refuses only the item edited since planning and still reports the plan", async () => {
    const graph = movingLibraryGraphClient({ [MISPLACED_PATH]: "etag-edited" }, [AUG, SEPT]);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", movePlanWith([MOVE_ITEM]));

    const output = outputOf(await runExecuteMovePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context));

    expect(output.counts.preconditionRefused).toBe(1);
    expect(graph.paths()).toEqual([MISPLACED_PATH]);
  });

  it("reports a target folder that vanished after planning as failed, since Graph's 400 names no cause", async () => {
    const graph = movingLibraryGraphClient({ [MISPLACED_PATH]: "etag-0" }, [AUG]);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", movePlanWith([MOVE_ITEM]));

    const output = outputOf(await runExecuteMovePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context));

    expect(output.counts.failed).toBe(1);
  });

  it("refuses an unknown plan id without contacting Graph", async () => {
    const graph = movingLibraryGraphClient({}, []);
    const result = await runExecuteMovePlan({ profileId: "example", planId: "nope" }, createFakeToolContext({ graph }));

    expect(result.isError).toBe(true);
    expect(graph.requests()).toBe(0);
  });
});
```

`tests/tools/move/execute.wire.test.ts`: copy `tests/tools/rename/execute.wire.test.ts`, substituting the move definition, `runExecuteMovePlan`, `"execute_move_plan"`, `movePlanWith([MOVE_ITEM])`, and `movingLibraryGraphClient({ [MISPLACED_PATH]: "etag-0" }, [AUG, SEPT])`, keeping every test it has.

- [ ] **Step 3: Run them and see them fail**

Run: `npx vitest run tests/tools/move/execute`
Expected: FAIL, module `src/tools/move/execute.js` not found.

- [ ] **Step 4: Add the execute half to `src/tools/move/output.ts`**

```ts
export const MOVE_ITEM_OUTCOMES = ["moved", "would_move", "precondition_refused", "not_found", "failed"] as const;
export type MoveItemOutcome = (typeof MOVE_ITEM_OUTCOMES)[number];

export interface MoveItemResult {
  path: string;
  currentName: string;
  targetName: string;
  targetPath: string;
  client: string;
  outcome: MoveItemOutcome;
}

export interface ExecuteMovePlanOutput {
  planId: string;
  profileId: string;
  driveId: string;
  reverses?: string;
  dryRun: boolean;
  results: MoveItemResult[];
  resultCount: number;
  resultsOmitted: number;
  counts: { moved: number; wouldMove: number; preconditionRefused: number; notFound: number; failed: number };
  excluded: MoveExcludedItem[];
  excludedCount: number;
  excludedOmitted: number;
  reversalPlanId?: string;
  reversalEntriesNotRefreshed: number;
  graphOperationsIssued: number;
}
```

and `EXECUTE_MOVE_PLAN_OUTPUT_SCHEMA`, field for field as `EXECUTE_RENAME_PLAN_OUTPUT_SCHEMA` with "rename" read as "move" throughout, `z.enum(MOVE_ITEM_OUTCOMES)`, `MOVE_EXCLUDED_ITEM_SCHEMA` for `excluded`, `counts.moved` and `counts.wouldMove`, and this sentence added to the `results` description after the failed sentence: "A target folder deleted after the plan was generated is reported as failed, because Graph answers it with a generic 400 that names no cause."

- [ ] **Step 5: Add `executeMovePlanText` to `src/tools/move/text.ts`**

Mirror `executePlanText` in `src/tools/rename/text.ts` line for line with "rename(s)" read as "move(s)", `counts.moved` and `counts.wouldMove`, and each result line as `  ${result.path} -> ${result.targetPath} (${result.outcome})`.

- [ ] **Step 6: Write `src/tools/move/execute.ts`**

Structure it as `src/tools/rename/execute.ts` after Task 4, with `EXECUTE_MOVE_PLAN_INPUT_SCHEMA` identical to the rename one except the `planId` example, `"mov-2026-09-24-a1b2c3d4"`, and "Plan id returned by generate_move_plan". The kind check is `if (plan.kind !== "move") return wrongPlanKind(plan, "move");`, the refusal names `generate_move_plan`, the outcome map is `applied: "moved", would_apply: "would_move"` and the rest identical, and excluded items pass through unnarrowed, since a move plan may carry every reason.

- [ ] **Step 7: Wire the definition**

Replace `src/tools/definitions/execute-move-plan.ts`:

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { EXECUTE_MOVE_PLAN_INPUT_SCHEMA, runExecuteMovePlan } from "../move/execute.js";
import { EXECUTE_MOVE_PLAN_OUTPUT_SCHEMA } from "../move/output.js";

export const executeMovePlan: ToolDefinition = {
  name: "execute_move_plan",
  kind: "write",
  title: "Execute a move plan",
  description: [
    "Apply a previously generated move plan by its plan id, writing a reversal log before any change so the batch can be rolled back through this same tool.",
    "Each move carries the ETag recorded at plan time, so a file edited since planning is reported as skipped rather than overwritten, and every untouched file still applies. A move never replaces a file already at its target.",
    "Moves stay within the profile's own document library. Runs as a dry run unless confirm is true. A dry run contacts Graph not at all, so it cannot report which files have changed since the plan was generated.",
    SAFETY_SENTENCES.destructiveWrite,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object(EXECUTE_MOVE_PLAN_INPUT_SCHEMA),
  outputSchema: EXECUTE_MOVE_PLAN_OUTPUT_SCHEMA,
  handler: runExecuteMovePlan,
};
```

In `tests/tools/contract.test.ts`, change the comment sentence "Phase 6 is the first tool that needs one, for generate_move_plan's scopeValue." to "No tool needs one today: phase 6b-1 dropped generate_move_plan's scope and scopeValue, the pair this rule was written for." Change nothing else in that file.

- [ ] **Step 8: Run the whole suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS. Also run `grep -rn "stub-output" src/tools/definitions` and confirm only `replicate-template.ts` still imports it.

- [ ] **Step 9: Commit**

```bash
git add src/tools/move src/tools/definitions/execute-move-plan.ts tests/tools/move tests/tools/contract.test.ts
git commit -m "feat(tools): wire execute_move_plan over the shared executor"
```

---

## Task 8: Report an occupied target name as its own outcome

A deliberate behavior change for both executors. Today a 409 on a rename is reported as `failed`. The probe measured Graph answering an occupied target name with 409 `nameAlreadyExists`, which is distinguishable, so it earns `target_name_taken`. This is the only task that changes rename assertions.

**Files:**
- Modify: `src/graph/relocate.ts`, `src/graph/rename.ts`, `src/tools/plans/apply.ts`, `src/tools/rename/output.ts`, `src/tools/rename/execute.ts`, `src/tools/rename/text.ts`, `src/tools/move/output.ts`, `src/tools/move/execute.ts`, `src/tools/move/text.ts`
- Test: `tests/graph/relocate.errors.test.ts`, `tests/tools/rename/execute.errors.test.ts`, `tests/tools/rename/text.test.ts`, `tests/tools/move/execute.errors.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/graph/relocate.errors.test.ts`:

```ts
  it("maps a 409 nameAlreadyExists to a name conflict", async () => {
    await expect(
      relocateDriveItem(failingClient(409, '{"error":{"code":"nameAlreadyExists","message":"Name already exists"}}'), MOVE),
    ).resolves.toEqual({ kind: "name_conflict" });
  });

  it("rethrows a 409 carrying any other code, since only nameAlreadyExists was measured", async () => {
    await expect(relocateDriveItem(failingClient(409, '{"error":{"code":"somethingElse"}}'), MOVE)).rejects.toBeInstanceOf(
      GraphRequestError,
    );
  });
```

In `tests/tools/move/execute.errors.test.ts`:

```ts
  it("reports a file that arrived at the target after planning as target_name_taken and replaces nothing", async () => {
    const graph = movingLibraryGraphClient({ [MISPLACED_PATH]: "etag-0", [TARGET_PATH]: "occupant" }, [AUG, SEPT]);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", movePlanWith([MOVE_ITEM]));

    const output = outputOf(await runExecuteMovePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context));

    expect(output.counts.targetNameTaken).toBe(1);
    expect(graph.paths()).toEqual([MISPLACED_PATH, TARGET_PATH].sort());
  });
```

(import `TARGET_PATH` from `./fixtures.js`).

In `tests/tools/rename/execute.errors.test.ts`:

```ts
  it("reports a rename onto a name another file took after planning as target_name_taken", async () => {
    const graph = renamingGraphClient({ patchStatuses: { [ITEM_A.path]: 409 } });
    // The renaming fake answers a failing status with an empty body, which carries no
    // Graph error code; give it one so the verb can recognize nameAlreadyExists.
    const original = graph.patch.bind(graph);
    graph.patch = async <T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> => {
      try {
        return await original<T>(path, body, headers);
      } catch (error) {
        if (error instanceof GraphRequestError && error.status === 409) {
          throw new GraphRequestError({ method: "PATCH", path, status: 409, body: '{"error":{"code":"nameAlreadyExists"}}' });
        }
        throw error;
      }
    };
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: "rnm-2026-09-18-a1b2c3d4", confirm: true }, context),
    );

    expect(output.counts.targetNameTaken).toBe(1);
    expect(output.counts.renamed).toBe(1);
    expect(output.counts.failed).toBe(0);
  });
```

(import `GraphRequestError` from `../../../src/graph/errors.js` and `ITEM_B` if the file does not already).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/graph/relocate.errors.test.ts tests/tools/move/execute.errors.test.ts tests/tools/rename/execute.errors.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Map the 409 in the verb**

In `src/graph/relocate.ts`, add `| { kind: "name_conflict" }` to `RelocateOutcome`, extend its doc comment with: "An occupied target name answers 409 `nameAlreadyExists` under `conflictBehavior: fail` (measured 2026-09-24): nothing is replaced, and the incoming file stays where it was. Only that code is mapped; any other 409 is rethrown, since no other was measured.", and add before the final `throw error;`:

```ts
    if (error instanceof GraphRequestError && error.status === 409 && error.code === "nameAlreadyExists") {
      return { kind: "name_conflict" };
    }
```

In `src/graph/rename.ts`, add `| { kind: "name_conflict" }` to `RenameOutcome`; `renameDriveItem` passes it through unchanged.

- [ ] **Step 4: Carry it through the executor and both tools**

- `src/tools/plans/apply.ts`: add `"target_name_taken"` to `AppliedOutcome`, and before the `not_found` branch: `} else if (written.kind === "name_conflict") { outcome = "target_name_taken"; }` with the comment "A file arrived at the target between generating and executing. Graph refused under conflictBehavior fail, so nothing was replaced and this item is not in the reversal log's live set."
- `src/tools/rename/output.ts`: add `"target_name_taken"` to `RENAME_ITEM_OUTCOMES` after `"precondition_refused"`; add `targetNameTaken: number` to `counts` in the type and `targetNameTaken: z.number().int().describe("Items Graph refused because another file already holds the target name. Nothing was replaced.")` to the schema; add to the `results` description after the precondition sentence: "target_name_taken means another file took the target name after the plan was generated, and Graph refused rather than replace it."
- `src/tools/rename/execute.ts`: `target_name_taken: "target_name_taken"` in `RENAME_OUTCOME`, and `targetNameTaken: countOf(results, "target_name_taken")` in `counts`.
- `src/tools/rename/text.ts`: the confirmed-run second line becomes `` `${renamed} renamed, ${refused} refused because the item there is not the one the plan recorded, ${taken} refused because another file already holds the target name, ${notFound} no longer at the planned path, ${failed} failed.` `` using `String(output.counts.targetNameTaken)` for `taken`.
- The same four changes in `src/tools/move/output.ts`, `src/tools/move/execute.ts` and `src/tools/move/text.ts`.

- [ ] **Step 5: Update the rename assertions this deliberately changes**

Run: `npm run typecheck && npm test`. Expected failures, and only these: `tests/tools/rename/text.test.ts` builds `counts` objects without `targetNameTaken` and asserts the old confirmed-run sentence. Add `targetNameTaken: 0` to each `counts` literal there, and change the asserted sentence at the line reading `"3 renamed, 1 refused because ..."` to `"3 renamed, 1 refused because the item there is not the one the plan recorded, 0 refused because another file already holds the target name, 2 no longer at the planned path, 4 failed."`. If any other existing assertion fails, stop and report.

- [ ] **Step 6: Run the whole suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "feat(tools): report a target name taken after planning as its own outcome"
```

The commit body says in one line that this changes `execute_rename_plan`'s behavior for a 409, which it previously reported as failed.

---

## Task 9: The live sitting, and the documents this phase owes

**Operator prerequisite:** the grant issuer is standing. After 2026-10-01 its secret has expired, and the sitting starts with `npm run setup -- --tenant=$IW_TENANT_ID --create-bootstrap` instead.

**Files:**
- Create: `.superpowers/live-sitting/sitting-6b1.md` (not committed): the run log.
- Modify: `docs/OPEN-ITEMS.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-11-repository-reconciliation-mcp-design.md`, `docs/superpowers/specs/2026-09-22-move-write-path-design.md`

- [ ] **Step 1: Seed misplaced files**

With the grant widened (`set-site-role.ts write`), use the existing seeded sandbox library. Place, through the Graph API or the SharePoint UI:

- one deliverable under its canonical name in the previous month's folder (a `misplaced` file),
- one deliverable under the profile's vendor-token name in the previous month's folder (a `misnamed_and_misplaced` file),
- one deliverable whose correct month folder is deleted first (to produce `target_folder_absent`),
- one deliverable filed under a client folder whose name contains a space, if the seeded taxonomy has one; if not, record that the sitting did not cover a space in a target folder beyond Task 1's probe.

- [ ] **Step 2: Run the spec's eight steps through the MCP transport**

Using `.superpowers/live-sitting/call-tool.ts` against `npm run dev` (Azurite running, `IW_ALLOW_WRITES` set as for the 6a sitting):

1. `generate_move_plan`, and read the plan.
2. `execute_move_plan` dry run; confirm it names exactly the plan's files and issued zero Graph operations.
3. `execute_move_plan` with `confirm: true`; confirm with a fresh `inventory_tree` that the files moved.
4. Execute the returned reversal plan with `confirm: true`; confirm the library is back where it started.
5. Generate again, edit one planned file in SharePoint, execute: that item alone is `precondition_refused`.
6. Confirm the `misnamed_and_misplaced` file was corrected by one Graph operation and rolled back.
7. Confirm the `target_folder_absent` exclusion appeared from real data.
8. Run `generate_rename_plan` and `execute_rename_plan` end to end, confirming the shared executor did not regress the path verified on 2026-09-19.

Also place a file at a planned target between generating and executing, and confirm `target_name_taken` with the occupant untouched. Record every figure in the run log.

- [ ] **Step 3: Restore the grant and decide on the issuer**

`npx tsx .superpowers/live-sitting/set-site-role.ts read`, then confirm with `site-permissions.ts`. Ask the operator whether to keep the grant issuer standing for phase 6d's sitting or delete it with `npm run setup -- --tenant=$IW_TENANT_ID --delete-bootstrap --confirm`. Remind the operator to rotate the server application's client secret, which appeared in a session transcript on 2026-09-24.

- [ ] **Step 4: Write the records**

In one commit:

- `docs/OPEN-ITEMS.md`: a dated section "The phase 6b-1 live tenant sitting" with what ran, the figures, and a "What this sitting does not establish" list (at minimum: cross-library moves; a target folder containing `#` or `%` beyond the Task 1 probe; a real Azure Table Storage account). Close the entry "Before a write tool needs a cross-field constraint", since `scope` and `scopeValue` are gone.
- `CLAUDE.md`: in the Build Sequence, split phase 6's "6b and 6c" entry into a "6b-1: the same-library move write path. Complete and verified live on <date>." entry and a held 6b-2 and 6c entry; in the Decision Record's Graph access entry, add that a move addresses its target by `parentReference.path`, sends `conflictBehavior: fail`, and that `conflictBehavior` therefore left the deferred list with 6b-1 as its first caller; in the tool table, change `execute_move_plan`'s note to "Same-library moves; cross-library is phase 6b-2".
- `docs/superpowers/specs/2026-09-11-repository-reconciliation-mcp-design.md`: the same tool-table note.
- `docs/superpowers/specs/2026-09-22-move-write-path-design.md`: nothing unless the sitting contradicted it, in which case add a dated amendment.

- [ ] **Step 5: Run the whole suite and commit**

```bash
npm run lint && npm run typecheck && npm test
git add docs/OPEN-ITEMS.md CLAUDE.md docs/superpowers/specs
git commit -m "docs: record the phase 6b-1 live sitting and close the move write path"
```

---

## What the controller owes after the last task

A whole-branch review before merge, aimed at the joins no single task owned: that `applyPlan` sends `{ name }` alone for every rename item (Task 4) and that nothing in Task 8 reintroduced a parent reference for one; that `pairMisplacedArtifacts` and `pairMisnamedArtifacts` never both claim one file; and that every message an operator reads states only what the code observed. Then a PR, not a direct push to main, since this is the second write path and changes the first.
