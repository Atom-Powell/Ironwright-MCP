# Phase 9c: Assessment Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server hosts a third domain module, `assessment`: an assessment profile kind, the four Graph operations the 9a probe measured, and seven tools (five lifecycle, two read) that advance a governed assessment workspace one stage at a time, refuse out of order calls with live evidence, and journal every write.

**Architecture:** Pure code under `src/domain/assessment/` (templates, ID rendering, state model, precondition evaluation) is fixture tested with shapes copied from the 9a recordings. Graph gains two small files, `src/graph/items.ts` (read, create folder, create file, overwrite file) and `src/graph/lists.ts` (query, get, create, update list items), plus one new client verb, `putBytes`. Tool handlers live under `src/tools/assessment/`, one file per tool, sharing a context resolver, a state reader, a journal writer and a refusal shape. The module object under `src/modules/assessment/` registers the seven tools. The 9a evidence governs two design points the spec was amended on: an overwrite reads the item before writing because `If-Match` does not guard an absent path on PUT, and every filtered list query carries the non indexed query header.

**Tech Stack:** TypeScript, Node 22, zod, vitest, `node:crypto` for sha256, the existing `GraphClient` and `StateStore`.

## Global Constraints

From `CLAUDE.md`, the spec at `docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md` and its 2026-11-07 amendment, and the evidence at `docs/superpowers/specs/evidence/2026-11-07-assessment-probe/`:

- **No em dashes and no en dashes anywhere**, including string literals, comments, test fixtures and commit messages. `tests/source-hygiene.test.ts` enforces it over tracked files.
- **No emojis. US English.**
- **The domain layer is pure.** `src/domain/**` imports zod and its own siblings only; the eslint rule enforces it. `node:crypto` is therefore not available there, so hashing lives under `src/tools/assessment/`.
- **No customer constants in the code.** Every list name, column name, folder template, artifact name, status label and ID convention comes from the profile. The example profile uses invented names.
- **A message states only what the code observed.** A read back follows every write, and a result reports what the read back returned.
- **Every filtered list query sends `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly`** (measured 2026-11-07, L3a and L3b).
- **An overwrite reads the item first and refuses when it is absent**, then sends `If-Match` with the ETag it read (measured 2026-11-07, F3c). A 412 is matched on status, never on the error code.
- **ETags are read from the response body** (`eTag`), never from a header (measured 2026-11-07, F2a, F3a).
- **A small content PUT is capped at 4 MiB** (4194304 bytes) and refused above it before any Graph call.
- **Lifecycle tools carry `SAFETY_SENTENCES.lifecycle`** verbatim and the annotations `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true`, as the contract test already requires for the kind.
- **Existing tests pass unedited except where a task names the edit.**
- **Test file naming:** happy path in `X.test.ts`, failures in `X.errors.test.ts`. Fixtures copied from `recordings.jsonl`, not written by hand.
- **Conventional commits**, each ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `npm run lint`, `npm run typecheck` and `npm test` before every commit.

Rulings this plan makes where the spec is silent, each to be recorded in the spec's amendments by Task 8:

1. The `lifecycle` profile block is `status: { inProgress, completed, provisional }`, `dispositions: string[]` and `risks: string[]`. The assessment list's `state` column is written by the server with the last stage it completed and is reported by `get_assessment`; it is never the sole input to a precondition, which always reads the artifacts and items directly.
2. `save_assessment_artifact` refuses the `publication` kind. The publication is written by the consumer's own publisher and only verified here.
3. The journal's `versionId` stays unset in this phase: reading a SharePoint version id needs a `/versions` call this project has never made, and the assumption gate forbids planning against it. `priorContentHash` is added instead, from a download of the prior bytes through the content path verified live since phase 2b-2.
4. Tools that accept a library profile (`inventory_tree`, `query_repository`, `generate_custom_plan`, `execute_custom_plan`) also accept an assessment profile, since both carry a site and a library and nothing else those tools read. Tools that need a compliance profile refuse an assessment profile through `profiles.get`, the same gate that refuses a library profile.
5. The vendor folder name is computed by the server from the vendor name by removing the characters SharePoint forbids in a name (`" * : < > ? / \ |`), collapsing whitespace and trimming. Once a vendor item exists, its stored folder name wins over recomputation.
6. The journal stage for a save is the artifact kind upper cased (`dossier` to `DOSSIER`, `executive_summary` to `EXECUTIVE_SUMMARY`), except that an overwrite of the dossier is `CORRECTION`.
7. The OData filter is built as `fields/{column} eq '{value}'` with single quotes doubled inside the value and the whole expression passed through `encodeURIComponent`. The probe sent the expression raw; the encoded form is the HTTP layer's representation of the same query and the first live call of the sitting checks it.

---

## File Structure

**Created:**
- `src/graph/items.ts`: `readDriveItem`, `createFolder`, `createFile`, `overwriteFile`, `UploadTooLargeError`, `MAX_SMALL_UPLOAD_BYTES`.
- `src/graph/lists.ts`: `queryListItems`, `getListItem`, `createListItem`, `updateListItemFields`, `listItemsPath`, `odataString`, `NON_INDEXED_QUERY_HEADER`.
- `src/domain/assessment/templates.ts`: placeholder sets, `renderWorkspaceTemplate`, `renderAssessmentId`, `sanitizeFolderName`, `joinWorkspacePath`.
- `src/domain/assessment/state.ts`: `AssessmentRecord`, `AssessmentState`, `recordFromFields`, `fieldsFor`, preconditions.
- `src/domain/profile/assessment.ts`: `AssessmentProfileSchema`, `AssessmentProfile`.
- `src/modules/assessment/index.ts`.
- `src/tools/assessment/context.ts`, `read-state.ts`, `hash.ts`, `journal.ts`, `refusal.ts`, `open.ts`, `get.ts`, `save-artifact.ts`, `read-artifact.ts`, `verify-publication.ts`, `record-findings.ts`, `transition.ts`, `output.ts`.
- `src/tools/definitions/open-assessment.ts`, `get-assessment.ts`, `save-assessment-artifact.ts`, `read-assessment-artifact.ts`, `verify-publication.ts`, `record-findings.ts`, `transition-assessment.ts`.
- `examples/profiles/assessment-example.json`.
- `tests/graph/fixtures/assessment-probe.ts`, `tests/graph/items.test.ts`, `items.errors.test.ts`, `lists.test.ts`, `lists.errors.test.ts`.
- `tests/domain/assessment/templates.test.ts`, `templates.errors.test.ts`, `state.test.ts`, `state.errors.test.ts`.
- `tests/domain/profile/assessment.test.ts`, `assessment.errors.test.ts`.
- `tests/tools/assessment/fake-graph.ts`, `open.test.ts`, `open.errors.test.ts`, `get.test.ts`, `save-artifact.test.ts`, `save-artifact.errors.test.ts`, `read-artifact.test.ts`, `verify-publication.test.ts`, `record-findings.test.ts`, `record-findings.errors.test.ts`, `transition.test.ts`, `transition.errors.test.ts`.

**Modified:**
- `src/graph/client.ts`: `putBytes` on the interface and the implementation; `RequestOptions` gains `PUT`, `rawBody`, `contentType`.
- `src/domain/profile/base.ts`: `PROFILE_KINDS` gains `"assessment"`.
- `src/domain/profile/library.ts`: `AnyProfile` gains `AssessmentProfile`; `isAssessmentProfile`; `loadAnyProfile` gains the branch.
- `src/profiles/registry.ts`: `get` refuses an assessment profile with `AssessmentProfileError`.
- `src/tools/errors.ts`: `describeToolFailure` names an `AssessmentProfileError` the way it names a `LibraryProfileError`.
- `src/store/types.ts`: `JournalEntry` and `JournalEntrySchema` gain optional `priorContentHash`.
- `src/modules/index.ts`: `ALL_MODULES` gains the assessment module.
- `tests/tools/fake-context.ts`: every `GraphClient` fake gains `putBytes`.
- `tests/tools/contract.test.ts`: `EXPECTED_TOOL_NAMES` gains the seven names.
- `tests/tools/profile-kinds.test.ts`: the classification gains the assessment sets.
- `tests/tools/modules.test.ts`: the kinds list and the tool list.
- `CLAUDE.md`, `docs/SETUP.md`, `docs/OPEN-ITEMS.md`, `README.md`, the spec's amendments.

---
## Task 1: The `putBytes` verb and the drive item operations

**Files:**
- Modify: `src/graph/client.ts`
- Create: `src/graph/items.ts`
- Create: `tests/graph/fixtures/assessment-probe.ts`
- Create: `tests/graph/items.test.ts`, `tests/graph/items.errors.test.ts`
- Modify: `tests/tools/fake-context.ts` (and any other object typed `GraphClient` that `npm run typecheck` names)

**Interfaces:**
- Produces: `GraphClient.putBytes<T>(pathOrUrl: string, body: Uint8Array, contentType: string, headers?: Record<string, string>): Promise<T>`.
- Produces: everything `src/graph/items.ts` exports below. Tasks 5 to 7 call them.

- [ ] **Step 1: Copy the fixtures from the recordings**

Read `docs/superpowers/specs/evidence/2026-11-07-assessment-probe/recordings.jsonl`. For each of F0, F1a, F1b, F2a, F2b, F3a, F3b and F3c, copy the `response.body` string, JSON parse it, and export it as a constant in `tests/graph/fixtures/assessment-probe.ts`. The redaction placeholders (`<drive-id>`, `<etag-1>`, `<guid>`, `<host>`, `<download-url>`) stay as they are; they are the shapes, and a test asserts on shape and on the fields the code reads. Also export the L1, L2a, L2b, L1b and L3b bodies for Task 2 and Task 4. The file begins with a comment naming the run id `20261107T203924Z` and the recording path, so a reader can trace every fixture to the request that produced it.

```ts
// tests/graph/fixtures/assessment-probe.ts
// Response bodies copied verbatim from the 2026-11-07 probe run 20261107T203924Z,
// docs/superpowers/specs/evidence/2026-11-07-assessment-probe/recordings.jsonl.
// Redaction placeholders are kept: the shape is the fixture, not the values.
export const F0_FOLDER_CREATED = { /* parsed body of F0 */ } as const;
export const F1A_SUBFOLDER_CREATED = { /* F1a */ } as const;
export const F1B_FOLDER_CONFLICT = { error: { code: "nameAlreadyExists", message: "Name already exists", innerError: { date: "2026-11-07T20:39:32", "request-id": "<guid>", "client-request-id": "<guid>" } } } as const;
export const F2A_FILE_CREATED = { /* F2a */ } as const;
export const F2B_FILE_CONFLICT = { error: { code: "nameAlreadyExists", message: "The specified item name already exists.", innerError: { date: "2026-11-07T20:39:33", "request-id": "<guid>", "client-request-id": "<guid>" } } } as const;
export const F3A_FILE_OVERWRITTEN = { /* F3a */ } as const;
export const F3B_STALE_ETAG = { error: { code: "notAllowed", message: "ETag does not match current item's value", innerError: { date: "2026-11-07T20:39:33", "request-id": "<guid>", "client-request-id": "<guid>" } } } as const;
export const F3C_ABSENT_PATH_CREATED = { /* F3c: a 201 body, the finding this plan designs around */ } as const;
export const L1_ITEMS_PAGE = { /* L1 */ } as const;
export const L2A_ITEM_CREATED = { /* L2a */ } as const;
export const L2B_FIELDS_UPDATED = { /* L2b */ } as const;
export const L1B_ITEM_READ = { /* L1b */ } as const;
export const L3B_FILTERED_PAGE = { /* L3b */ } as const;
```

- [ ] **Step 2: Write the failing tests for `putBytes`**

Append to `tests/graph/client.test.ts` a describe block that builds a client with a recording `fetchImpl` and asserts: method `PUT`; the body passed to fetch is the same `Uint8Array`; `content-type` is the caller's value; `accept` is `application/json`; `authorization` is present; a caller header `if-match` survives; the JSON body is parsed and returned. Append to `tests/graph/client.errors.test.ts`: a 412 answer throws `GraphRequestError` with `status` 412 and `code` `"notAllowed"` when the body is `F3B_STALE_ETAG`; a transport rejection is not retried (the fetch stub counts one call).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/graph/client.test.ts tests/graph/client.errors.test.ts`
Expected: FAIL, `putBytes is not a function`.

- [ ] **Step 4: Implement `putBytes`**

In `src/graph/client.ts`:

```ts
export interface GraphClient {
  // ...existing members unchanged...
  /**
   * Bytes to a driveItem's content endpoint, the small upload path. Through
   * this client for the same reason getBytes is: the request counter and the
   * Retry-After policy must see it. Not retried on a transport rejection, as
   * POST and PATCH are not, because a replayed upload that already landed
   * would answer 409 under conflictBehavior fail or overwrite twice under
   * If-Match, and either is a confident wrong report of what happened.
   */
  putBytes<T>(pathOrUrl: string, body: Uint8Array, contentType: string, headers?: Record<string, string>): Promise<T>;
}

interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "PUT";
  body?: unknown;
  /** Raw bytes, sent as they are with `contentType`; never JSON encoded. Mutually exclusive with `body`. */
  rawBody?: Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
  retryTransportErrors: boolean;
}
```

In `send`, replace the body handling:

```ts
    const hasJsonBody = requestOptions.body !== undefined;
    const hasRawBody = requestOptions.rawBody !== undefined;
    const headers: Record<string, string> = {
      ...requestOptions.headers,
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(hasJsonBody ? { "content-type": "application/json" } : {}),
      ...(hasRawBody ? { "content-type": requestOptions.contentType ?? "application/octet-stream" } : {}),
    };
    const response = await fetchImpl(url, {
      method: requestOptions.method,
      headers,
      ...(hasJsonBody ? { body: JSON.stringify(requestOptions.body) } : {}),
      ...(hasRawBody ? { body: requestOptions.rawBody } : {}),
    });
```

And the verb:

```ts
    async putBytes<T>(pathOrUrl: string, body: Uint8Array, contentType: string, headers?: Record<string, string>): Promise<T> {
      return request<T>(pathOrUrl, {
        method: "PUT",
        retryTransportErrors: false,
        rawBody: body,
        contentType,
        ...(headers === undefined ? {} : { headers }),
      });
    },
```

Add `putBytes` to every `GraphClient` fake in `tests/tools/fake-context.ts` as a rejecting stub that increments the counter, matching the existing `patch` stubs, and to any other fake `npm run typecheck` names.

- [ ] **Step 5: Run the client tests and typecheck**

Run: `npx vitest run tests/graph && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Write the failing tests for the item operations**

`tests/graph/items.test.ts`, with a recording client (the pattern of `recordingClient` in `tests/graph/relocate.test.ts`, extended with `get`, `post` and `putBytes`):

- `readDriveItem` sends `GET /drives/d1/root:/IW-Probe/probe%2020261107T203924Z/dossier.md:?$select=id,name,eTag,size,lastModifiedDateTime,webUrl,folder,file` and returns `{ kind: "found", item: { id, name: "dossier.md", eTag: "<etag-5>", isFolder: false, ... } }` from `F2A_FILE_CREATED` (adjust the expected values to what the fixture carries).
- `readDriveItem` on a folder fixture (`F0_FOLDER_CREATED`) returns `isFolder: true`.
- `createFolder` at the library root sends `POST /drives/d1/root/children` with body `{ name: "IW-Probe", folder: {}, "@microsoft.graph.conflictBehavior": "fail" }` and returns `{ kind: "created", item }` with the eTag from the body.
- `createFolder` under a path sends `POST /drives/d1/root:/IW-Probe:/children`.
- `createFile` sends `putBytes` to `/drives/d1/root:/IW-Probe/probe%2020261107T203924Z/dossier.md:/content?@microsoft.graph.conflictBehavior=fail` with the bytes and `text/markdown`, and returns `{ kind: "created", item }`.
- `overwriteFile` sends `putBytes` to `/drives/d1/root:/.../dossier.md:/content` with header `if-match` equal to the given etag and no conflictBehavior, and returns `{ kind: "overwritten", item }` with the new eTag.

`tests/graph/items.errors.test.ts`:

- `readDriveItem` maps a thrown `GraphRequestError` with status 404 to `{ kind: "not_found" }` and rethrows any other status.
- `createFolder` maps 409 with code `nameAlreadyExists` (body `F1B_FOLDER_CONFLICT`) to `{ kind: "already_exists" }` and rethrows a 409 with another code.
- `createFile` maps 409 `nameAlreadyExists` (body `F2B_FILE_CONFLICT`) to `{ kind: "name_conflict" }`.
- `overwriteFile` maps 412 to `{ kind: "precondition_failed" }` regardless of the code, using `F3B_STALE_ETAG` whose code is `notAllowed`.
- `createFile` and `overwriteFile` throw `UploadTooLargeError` for 4194305 bytes before calling the client (the recording client's call list stays empty).
- The `UploadTooLargeError` message names the byte count received and the cap, and nothing else.

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx vitest run tests/graph/items.test.ts tests/graph/items.errors.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 8: Implement `src/graph/items.ts`**

```ts
import type { GraphClient } from "./client.js";
import { GraphRequestError } from "./errors.js";
import { driveItemPath } from "./paths.js";
import { etagOf } from "./relocate.js";

/** The small upload path's ceiling. Above it Graph wants an upload session, which has no caller yet. */
export const MAX_SMALL_UPLOAD_BYTES = 4 * 1024 * 1024;

export interface DriveItemFacts {
  id: string;
  name: string;
  eTag: string | undefined;
  size: number | undefined;
  lastModifiedDateTime: string | undefined;
  webUrl: string | undefined;
  isFolder: boolean;
}

export type DriveItemLookup = { kind: "found"; item: DriveItemFacts } | { kind: "not_found" };
export type CreateFolderOutcome = { kind: "created"; item: DriveItemFacts } | { kind: "already_exists" };
export type CreateFileOutcome = { kind: "created"; item: DriveItemFacts } | { kind: "name_conflict" };
export type OverwriteFileOutcome = { kind: "overwritten"; item: DriveItemFacts } | { kind: "precondition_failed" };

export class UploadTooLargeError extends Error {
  constructor(received: number) {
    super(
      `The content is ${received} bytes, and the small upload path this server uses is capped at ${MAX_SMALL_UPLOAD_BYTES} bytes. ` +
        "Nothing was sent. Larger content needs the upload session API, which this server does not implement.",
    );
    this.name = "UploadTooLargeError";
  }
}

/**
 * Reads the facts the module needs from the item Graph returns. Every field
 * other than id and name is optional because Graph's projection is what it is
 * and a missing eTag is reported as undefined rather than invented; the
 * reasoning is in rename.ts beside readDriveItemEtag.
 */
export function driveItemFacts(item: unknown): DriveItemFacts {
  const record = (item ?? {}) as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof record[key] === "string" ? (record[key] as string) : undefined);
  const id = str("id");
  const name = str("name");
  if (id === undefined || name === undefined) {
    throw new Error("Graph returned a driveItem without an id or a name, which this server cannot act on.");
  }
  return {
    id,
    name,
    eTag: etagOf(item),
    size: typeof record.size === "number" ? record.size : undefined,
    lastModifiedDateTime: str("lastModifiedDateTime"),
    webUrl: str("webUrl"),
    isFolder: typeof record.folder === "object" && record.folder !== null,
  };
}

const ITEM_SELECT = "$select=id,name,eTag,size,lastModifiedDateTime,webUrl,folder,file";

export async function readDriveItem(client: Pick<GraphClient, "get">, args: { driveId: string; path: string }): Promise<DriveItemLookup> {
  try {
    const item = await client.get<unknown>(`${driveItemPath(args.driveId, args.path)}?${ITEM_SELECT}`);
    return { kind: "found", item: driveItemFacts(item) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 404) return { kind: "not_found" };
    throw error;
  }
}

/**
 * conflictBehavior fail, measured 2026-11-07 (F0, F1a, F1b): a present folder
 * answers 409 nameAlreadyExists, which the caller treats as satisfied because
 * the workspace tree is additive and a retry must not fail on its own earlier
 * success. Only that code is mapped; any other 409 is rethrown.
 */
export async function createFolder(
  client: Pick<GraphClient, "post">,
  args: { driveId: string; parentPath: string; name: string },
): Promise<CreateFolderOutcome> {
  try {
    const item = await client.post<unknown>(`${driveItemPath(args.driveId, args.parentPath)}/children`, {
      name: args.name,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
    return { kind: "created", item: driveItemFacts(item) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 409 && error.code === "nameAlreadyExists") return { kind: "already_exists" };
    throw error;
  }
}

function checkSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_SMALL_UPLOAD_BYTES) throw new UploadTooLargeError(bytes.byteLength);
}

/**
 * Create only: an occupied name answers 409 nameAlreadyExists and nothing is
 * replaced (F2a, F2b). The ETag comes back in the body; the content PUT
 * carries no ETag header (F2a).
 */
export async function createFile(
  client: Pick<GraphClient, "putBytes">,
  args: { driveId: string; path: string; bytes: Uint8Array; contentType: string },
): Promise<CreateFileOutcome> {
  checkSize(args.bytes);
  try {
    const item = await client.putBytes<unknown>(
      `${driveItemPath(args.driveId, args.path)}/content?@microsoft.graph.conflictBehavior=fail`,
      args.bytes,
      args.contentType,
    );
    return { kind: "created", item: driveItemFacts(item) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 409 && error.code === "nameAlreadyExists") return { kind: "name_conflict" };
    throw error;
  }
}

/**
 * Update only in intent, but not in Graph's eyes: measured 2026-11-07 (F3c), a
 * PUT under If-Match against a path holding nothing CREATES the file and
 * answers 201. The precondition proves only that an existing file is
 * unchanged. The caller therefore reads the item first and never reaches this
 * function for an absent path; this function does not re-check, because a
 * second read here would reintroduce the race the single read avoids. A
 * stale ETag answers 412 with code notAllowed (F3b), so the match is on status.
 */
export async function overwriteFile(
  client: Pick<GraphClient, "putBytes">,
  args: { driveId: string; path: string; bytes: Uint8Array; contentType: string; etag: string },
): Promise<OverwriteFileOutcome> {
  checkSize(args.bytes);
  try {
    const item = await client.putBytes<unknown>(`${driveItemPath(args.driveId, args.path)}/content`, args.bytes, args.contentType, {
      "if-match": args.etag,
    });
    return { kind: "overwritten", item: driveItemFacts(item) };
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 412) return { kind: "precondition_failed" };
    throw error;
  }
}
```

- [ ] **Step 9: Run the tests, lint and typecheck**

Run: `npx vitest run tests/graph && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/graph/client.ts src/graph/items.ts tests/graph tests/tools/fake-context.ts
git commit -m "feat(graph): putBytes and the four drive item operations the assessment module needs"
```

---

## Task 2: The list item operations

**Files:**
- Create: `src/graph/lists.ts`
- Create: `tests/graph/lists.test.ts`, `tests/graph/lists.errors.test.ts`

**Interfaces:**
- Consumes: fixtures `L1_ITEMS_PAGE`, `L2A_ITEM_CREATED`, `L2B_FIELDS_UPDATED`, `L1B_ITEM_READ`, `L3B_FILTERED_PAGE` from Task 1.
- Produces: everything below. Task 5 to 7 call them.

- [ ] **Step 1: Write the failing tests**

`tests/graph/lists.test.ts`:

- `listItemsPath("site-1", "IW Probe Assessments")` is `/sites/site-1/lists/IW%20Probe%20Assessments/items`.
- `odataString("O'Neil")` is `'O''Neil'`.
- `queryListItems` with filter `fields/AssessmentId eq 'PRB-1'` sends `GET` to `${path}?$expand=fields&$top=50&$filter=${encodeURIComponent("fields/AssessmentId eq 'PRB-1'")}` with header `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly`, and returns one `ListItemRecord` from `L3B_FILTERED_PAGE` with `id: "2"`, `eTag` from `@odata.etag`... use the body's `eTag`, and `fields.AssessmentId === "PRB-20261107T203924Z-00002"`.
- `getListItem` sends `GET ${path}/2?$expand=fields` and returns the record from `L1B_ITEM_READ`.
- `createListItem` sends `POST ${path}` with body `{ fields }` and returns `id: "2"` from `L2A_ITEM_CREATED`.
- `updateListItemFields` sends `PATCH ${path}/2/fields` with the fields object and returns the fields record from `L2B_FIELDS_UPDATED`, with `AssessmentId` present.
- `queryListItems` follows `@odata.nextLink` once when present and stops at a page without one (two fixtures, the second being `L3B_FILTERED_PAGE`).

`tests/graph/lists.errors.test.ts`:

- `queryListItems` rethrows a 400 `GraphRequestError` unchanged (the L3a body) so the caller's message can carry Graph's own advice.
- `getListItem` maps 404 to `undefined` and rethrows other statuses.
- A page whose `value` is not an array throws an error naming the list.
- `queryListItems` stops after 20 pages and throws naming the count, so a nextLink loop cannot run forever.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/graph/lists.test.ts tests/graph/lists.errors.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/graph/lists.ts`**

```ts
import type { GraphClient } from "./client.js";
import { GraphRequestError } from "./errors.js";

/**
 * Measured 2026-11-07 (L3a, L3b): a $filter on a non indexed column answers
 * 400 invalidRequest without this header and 200 with it. Sent on every
 * filtered query. The header's own name is the caveat, and docs/SETUP.md tells
 * the operator to index the columns the module filters on.
 */
export const NON_INDEXED_QUERY_HEADER: Record<string, string> = { Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly" };

const MAX_PAGES = 20;

export interface ListItemRecord {
  id: string;
  eTag: string | undefined;
  fields: Record<string, unknown>;
  webUrl: string | undefined;
}

export function listItemsPath(siteId: string, listName: string): string {
  return `/sites/${siteId}/lists/${encodeURIComponent(listName)}/items`;
}

/** An OData string literal: single quotes doubled, the whole thing quoted. */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function recordOf(item: unknown, listName: string): ListItemRecord {
  const record = (item ?? {}) as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) throw new Error(`Graph returned an item of list "${listName}" without an id.`);
  const fields = typeof record.fields === "object" && record.fields !== null ? (record.fields as Record<string, unknown>) : {};
  return {
    id,
    eTag: typeof record.eTag === "string" ? record.eTag : undefined,
    fields,
    webUrl: typeof record.webUrl === "string" ? record.webUrl : undefined,
  };
}

export async function queryListItems(
  client: Pick<GraphClient, "get">,
  args: { siteId: string; listName: string; filter: string; top?: number },
): Promise<ListItemRecord[]> {
  const top = args.top ?? 50;
  let url: string | undefined = `${listItemsPath(args.siteId, args.listName)}?$expand=fields&$top=${top}&$filter=${encodeURIComponent(args.filter)}`;
  const records: ListItemRecord[] = [];
  let pages = 0;
  while (url !== undefined) {
    pages += 1;
    if (pages > MAX_PAGES) throw new Error(`The query on list "${args.listName}" ran past ${MAX_PAGES} pages, which no assessment query should; stopped rather than looping.`);
    const page = await client.get<{ value?: unknown; "@odata.nextLink"?: unknown }>(url, NON_INDEXED_QUERY_HEADER);
    if (!Array.isArray(page.value)) throw new Error(`Graph returned a page of list "${args.listName}" without a value array.`);
    for (const item of page.value) records.push(recordOf(item, args.listName));
    url = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
  }
  return records;
}

export async function getListItem(
  client: Pick<GraphClient, "get">,
  args: { siteId: string; listName: string; itemId: string },
): Promise<ListItemRecord | undefined> {
  try {
    const item = await client.get<unknown>(`${listItemsPath(args.siteId, args.listName)}/${encodeURIComponent(args.itemId)}?$expand=fields`);
    return recordOf(item, args.listName);
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 404) return undefined;
    throw error;
  }
}

/** Measured 2026-11-07 (L2a): the response is the item with its integer id rendered as a string. */
export async function createListItem(
  client: Pick<GraphClient, "post">,
  args: { siteId: string; listName: string; fields: Record<string, unknown> },
): Promise<ListItemRecord> {
  const item = await client.post<unknown>(listItemsPath(args.siteId, args.listName), { fields: args.fields });
  return recordOf(item, args.listName);
}

/** Measured 2026-11-07 (L2b): the response is the whole fields object after the update. */
export async function updateListItemFields(
  client: Pick<GraphClient, "patch">,
  args: { siteId: string; listName: string; itemId: string; fields: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const fields = await client.patch<unknown>(`${listItemsPath(args.siteId, args.listName)}/${encodeURIComponent(args.itemId)}/fields`, args.fields);
  if (typeof fields !== "object" || fields === null) throw new Error(`Graph answered the fields update on list "${args.listName}" item ${args.itemId} without a fields object.`);
  return fields as Record<string, unknown>;
}
```

- [ ] **Step 4: Run the tests, lint and typecheck**

Run: `npx vitest run tests/graph && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph/lists.ts tests/graph/lists.test.ts tests/graph/lists.errors.test.ts
git commit -m "feat(graph): list item query, read, create and update with the non-indexed query header"
```

---
## Task 3: Templates and the assessment profile kind

**Files:**
- Create: `src/domain/assessment/templates.ts`
- Create: `src/domain/profile/assessment.ts`
- Modify: `src/domain/profile/base.ts` (`PROFILE_KINDS`)
- Modify: `src/domain/profile/library.ts` (`AnyProfile`, `isAssessmentProfile`, `loadAnyProfile`)
- Modify: `src/profiles/registry.ts` (`AssessmentProfileError`, `get`)
- Modify: `src/tools/errors.ts` (`describeToolFailure` branch)
- Create: `src/modules/assessment/index.ts` (tools empty until Task 5)
- Modify: `src/modules/index.ts`
- Create: `examples/profiles/assessment-example.json`
- Create: `tests/domain/assessment/templates.test.ts`, `templates.errors.test.ts`, `tests/domain/profile/assessment.test.ts`, `assessment.errors.test.ts`
- Modify: `tests/tools/modules.test.ts`, `tests/tools/profile-kinds.test.ts`

**Interfaces:**
- Produces: `AssessmentProfile` (zod inferred), `AssessmentProfileSchema`, `isAssessmentProfile(profile: AnyProfile): profile is AssessmentProfile`, `AssessmentProfileError`.
- Produces: `renderWorkspaceTemplate(template, values)`, `renderAssessmentId(template, values)`, `sanitizeFolderName(name)`, `joinWorkspacePath(...segments)`, `unknownWorkspacePlaceholders(template)`, `unknownIdPlaceholders(template)`.

- [ ] **Step 1: Write the failing template tests**

`tests/domain/assessment/templates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  joinWorkspacePath, renderAssessmentId, renderWorkspaceTemplate, sanitizeFolderName,
  unknownIdPlaceholders, unknownWorkspacePlaceholders,
} from "../../../src/domain/assessment/templates.js";

const NOW = new Date("2026-11-07T20:39:24Z");

describe("renderWorkspaceTemplate", () => {
  it("fills vendor, vendorFolder, assessmentId, yyyy and mm", () => {
    expect(
      renderWorkspaceTemplate("Assessments/{yyyy}/{mm}/{vendorFolder}/{assessmentId}/{vendor}", {
        vendor: "Acme Corp", vendorFolder: "Acme Corp", assessmentId: "ASM-2026-00002", now: NOW,
      }),
    ).toBe("Assessments/2026/11/Acme Corp/ASM-2026-00002/Acme Corp");
  });
});

describe("renderAssessmentId", () => {
  it("pads the item id to the requested width", () => {
    expect(renderAssessmentId("{prefix}-{yyyy}-{item:5}", { prefix: "ASM", itemId: 2, now: NOW })).toBe("ASM-2026-00002");
  });
  it("renders the bare item id unpadded", () => {
    expect(renderAssessmentId("{prefix}{item}", { prefix: "V", itemId: 42, now: NOW })).toBe("V42");
  });
  it("does not truncate an id wider than the padding", () => {
    expect(renderAssessmentId("{item:2}", { prefix: "x", itemId: 12345, now: NOW })).toBe("12345");
  });
});

describe("sanitizeFolderName", () => {
  it("removes the characters SharePoint forbids and collapses whitespace", () => {
    expect(sanitizeFolderName('  Acme: "Global" <Ltd>  / Inc  ')).toBe("Acme Global Ltd Inc");
  });
  it("strips trailing dots, which SharePoint refuses on a folder", () => {
    expect(sanitizeFolderName("Acme Inc.")).toBe("Acme Inc");
  });
  it("returns an empty string when nothing survives", () => {
    expect(sanitizeFolderName('"*:<>?/\\|')).toBe("");
  });
});

describe("placeholder validation", () => {
  it("accepts every workspace placeholder and names an unknown one", () => {
    expect(unknownWorkspacePlaceholders("{vendor}/{vendorFolder}/{assessmentId}/{yyyy}/{mm}")).toEqual([]);
    expect(unknownWorkspacePlaceholders("{client}/{assessmentId}")).toEqual(["client"]);
  });
  it("accepts item with and without a width and names anything else", () => {
    expect(unknownIdPlaceholders("{prefix}-{yyyy}{mm}-{item:4}-{item}")).toEqual([]);
    expect(unknownIdPlaceholders("{prefix}-{vendor}-{item:x}")).toEqual(["vendor", "item:x"]);
  });
});

describe("joinWorkspacePath", () => {
  it("joins segments with single slashes and no leading or trailing slash", () => {
    expect(joinWorkspacePath("/Assessments/", "Acme/", "/ASM-1", "Research/dossier.md")).toBe("Assessments/Acme/ASM-1/Research/dossier.md");
  });
});
```

`tests/domain/assessment/templates.errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderAssessmentId, renderWorkspaceTemplate } from "../../../src/domain/assessment/templates.js";

const NOW = new Date("2026-11-07T20:39:24Z");
const VALUES = { vendor: "A", vendorFolder: "A", assessmentId: "X", now: NOW };

describe("rendering refuses what validation would have refused", () => {
  it("throws on an unknown workspace placeholder, naming it", () => {
    expect(() => renderWorkspaceTemplate("{client}/x", VALUES)).toThrow(/client/);
  });
  it("throws on an unknown id placeholder, naming it", () => {
    expect(() => renderAssessmentId("{vendor}-{item}", { prefix: "P", itemId: 1, now: NOW })).toThrow(/vendor/);
  });
  it("throws when a rendered segment is empty, so a path never gains a double slash", () => {
    expect(() => renderWorkspaceTemplate("Assessments/{vendorFolder}/{assessmentId}", { ...VALUES, vendorFolder: "" })).toThrow(/vendorFolder/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/domain/assessment`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/domain/assessment/templates.ts`**

```ts
import { extractPlaceholders } from "../profile/placeholders.js";

/**
 * Two closed placeholder sets, closed for the reason the taxonomy's set is:
 * a typo in a profile is a validation error at load time rather than a path
 * that renders with a literal brace and is created on the customer's site.
 */
export const WORKSPACE_PLACEHOLDERS = ["vendor", "vendorFolder", "assessmentId", "yyyy", "mm"] as const;
export const ID_PLACEHOLDERS = ["prefix", "yyyy", "mm", "item"] as const;

const ITEM_WIDTH = /^item:([1-9]\d?)$/;

export function unknownWorkspacePlaceholders(template: string): string[] {
  const supported = new Set<string>(WORKSPACE_PLACEHOLDERS);
  return extractPlaceholders(template).filter((token) => !supported.has(token));
}

export function unknownIdPlaceholders(template: string): string[] {
  const supported = new Set<string>(ID_PLACEHOLDERS);
  return extractPlaceholders(template).filter((token) => !supported.has(token) && !ITEM_WIDTH.test(token));
}

export interface WorkspaceValues {
  vendor: string;
  vendorFolder: string;
  assessmentId: string;
  now: Date;
}

export interface IdValues {
  prefix: string;
  itemId: number;
  now: Date;
}

function yyyy(now: Date): string {
  return String(now.getUTCFullYear());
}

function mm(now: Date): string {
  return String(now.getUTCMonth() + 1).padStart(2, "0");
}

function fill(template: string, lookup: (token: string) => string | undefined, kind: string): string {
  return template.replace(/\{([^}]*)\}/g, (_match, token: string) => {
    const value = lookup(token);
    if (value === undefined) throw new Error(`"{${token}}" is not a ${kind} placeholder.`);
    if (value.length === 0) throw new Error(`"{${token}}" rendered empty, which would leave a path segment blank.`);
    return value;
  });
}

export function renderWorkspaceTemplate(template: string, values: WorkspaceValues): string {
  return fill(
    template,
    (token) => {
      switch (token) {
        case "vendor": return values.vendor;
        case "vendorFolder": return values.vendorFolder;
        case "assessmentId": return values.assessmentId;
        case "yyyy": return yyyy(values.now);
        case "mm": return mm(values.now);
        default: return undefined;
      }
    },
    "workspace",
  );
}

/**
 * The item id is SharePoint's integer list item id, unique for the life of
 * the list and never reused, which is what makes the rendered ID unique
 * without a server held counter. `{item:N}` pads to N digits and never
 * truncates: an id wider than the padding is rendered whole, because a
 * truncated id is a collision.
 */
export function renderAssessmentId(template: string, values: IdValues): string {
  return fill(
    template,
    (token) => {
      if (token === "prefix") return values.prefix;
      if (token === "yyyy") return yyyy(values.now);
      if (token === "mm") return mm(values.now);
      if (token === "item") return String(values.itemId);
      const width = ITEM_WIDTH.exec(token);
      if (width !== null) return String(values.itemId).padStart(Number(width[1]), "0");
      return undefined;
    },
    "assessment id",
  );
}

/**
 * The characters SharePoint refuses in a file or folder name, removed rather
 * than replaced so two vendors differing only in punctuation still differ in
 * their folder names less often than they would collapse onto one. Trailing
 * dots are stripped because SharePoint refuses them on a folder. The empty
 * string is a possible result and the caller refuses it with a message.
 */
export function sanitizeFolderName(name: string): string {
  return name
    .replace(/["*:<>?/\\|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .trim();
}

export function joinWorkspacePath(...segments: string[]): string {
  return segments
    .flatMap((segment) => segment.split("/"))
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("/");
}
```

- [ ] **Step 4: Run the template tests**

Run: `npx vitest run tests/domain/assessment`
Expected: PASS.

- [ ] **Step 5: Write the failing profile tests**

`tests/domain/profile/assessment.test.ts` loads `examples/profiles/assessment-example.json` through `loadAnyProfile` and asserts `kind === "assessment"`, `workspace.artifacts.dossier` and `workspace.artifacts.publication` are present, `lists.assessments.columns.assessmentId === "AssessmentId"`, `lifecycle.status.inProgress === "In Progress"`, and `identity` equals `sites[0]`. It also asserts the schema accepts a profile written with `sites` only and no `identity`.

`tests/domain/profile/assessment.errors.test.ts`, each case starting from the example and breaking one thing, asserting the issue path and a fragment of the message:

- `workspace.root` with `{client}`: path `workspace.root`, message names `client`.
- `assessmentId.template` with `{vendor}`: path `assessmentId.template`.
- `workspace.artifacts` missing `dossier`: path `workspace.artifacts.dossier`, message says the module needs it.
- `workspace.artifacts` missing `publication`: path `workspace.artifacts.publication`.
- a subfolder template starting with `/`: path `workspace.subfolders.0`.
- an artifact template containing `..`: path `workspace.artifacts.dossier`.
- two equal status labels: path `lifecycle.status`.
- `lifecycle.dispositions` empty: zod's own min message at `lifecycle.dispositions`.
- two sites: path `sites`, message says one site in this phase.
- a `workbookPath` on the site: refused (strict).
- an unknown top level key: refused (strict).
- `kind: "assessment"` through `createProfileRegistry` with a bad template reports the issue prefixed by the source name, like the other kinds.

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run tests/domain/profile/assessment.test.ts tests/domain/profile/assessment.errors.test.ts`
Expected: FAIL.

- [ ] **Step 7: Write the example profile**

`examples/profiles/assessment-example.json`, invented names only:

```json
{
  "kind": "assessment",
  "profileId": "vendor-assessments",
  "sites": [
    {
      "siteUrl": "https://contoso.sharepoint.com/sites/Example",
      "library": "Documents"
    }
  ],
  "workspace": {
    "root": "Assessments/{vendorFolder}/{assessmentId}",
    "subfolders": ["Research", "Evidence", "Published"],
    "artifacts": {
      "dossier": "Research/{vendor}_Research_Dossier.md",
      "executive_summary": "Published/{assessmentId}_Executive_Summary.md",
      "publication": "Published/{vendorFolder}_{assessmentId}_Risk_Assessment.docx"
    }
  },
  "assessmentId": {
    "prefix": "ASM",
    "template": "{prefix}-{yyyy}-{item:5}"
  },
  "lists": {
    "vendors": { "name": "Vendors", "columns": { "folderName": "FolderName" } },
    "assessments": {
      "name": "Assessments",
      "columns": {
        "assessmentId": "AssessmentId", "vendorFolder": "VendorFolder", "scope": "Scope", "status": "Status",
        "state": "State", "disposition": "Disposition", "risk": "Risk", "summary": "Summary"
      }
    },
    "findings": {
      "name": "Findings",
      "columns": { "assessmentId": "AssessmentId", "findingKey": "FindingKey", "observation": "Observation", "risk": "Risk", "recommendation": "Recommendation" }
    }
  },
  "lifecycle": {
    "status": { "inProgress": "In Progress", "completed": "Completed", "provisional": "Provisional" },
    "dispositions": ["Approved", "Approved with conditions", "Rejected"],
    "risks": ["Low", "Medium", "High"]
  }
}
```

- [ ] **Step 8: Implement the schema and the kind**

`src/domain/profile/base.ts`: `export const PROFILE_KINDS = ["compliance", "library", "assessment"] as const;`

`src/domain/profile/assessment.ts`:

```ts
import { z } from "zod";
import { ProfileIdSchema, SiteEntrySchema, refineIdentityAgreesWithSites } from "./base.js";
import { unknownIdPlaceholders, unknownWorkspacePlaceholders } from "../assessment/templates.js";

const AssessmentSiteEntrySchema = SiteEntrySchema.omit({ workbookPath: true }).strict();
const ColumnName = z.string().min(1).regex(/^[A-Za-z0-9_]+$/, "an internal column name: letters, digits and underscores");
const Template = z.string().min(1);
const Label = z.string().min(1);

/** Artifact kinds the module itself refers to; a profile may add more. */
export const REQUIRED_ARTIFACT_KINDS = ["dossier", "publication"] as const;

export const AssessmentProfileSchema = z
  .object({
    kind: z.literal("assessment"),
    profileId: ProfileIdSchema,
    identity: AssessmentSiteEntrySchema,
    sites: z.array(AssessmentSiteEntrySchema).length(1, "an assessment profile addresses exactly one site in this phase"),
    workspace: z
      .object({
        root: Template.describe('Library-relative folder template of one assessment, for example "Assessments/{vendorFolder}/{assessmentId}".'),
        subfolders: z.array(Template).default([]).describe('Folders created under the root at open, for example ["Research", "Evidence"].'),
        artifacts: z
          .record(z.string().regex(/^[a-z][a-z0-9_]*$/, "an artifact kind: lowercase letters, digits and underscores"), Template)
          .describe('Named artifact kinds to path templates under the root, for example {"dossier": "Research/{vendor}_Research_Dossier.md"}. "dossier" and "publication" are required.'),
      })
      .strict(),
    assessmentId: z
      .object({
        prefix: z.string().min(1),
        template: Template.describe(
          'Rendered from the list item id, for example "{prefix}-{yyyy}-{item:5}" giving "ASM-2026-00042". A template without {item} is not unique by construction; the list item id is what makes two assessments differ.',
        ),
      })
      .strict(),
    lists: z
      .object({
        vendors: z.object({ name: z.string().min(1), columns: z.object({ folderName: ColumnName }).strict() }).strict(),
        assessments: z
          .object({
            name: z.string().min(1),
            columns: z
              .object({
                assessmentId: ColumnName, vendorFolder: ColumnName, scope: ColumnName, status: ColumnName,
                state: ColumnName, disposition: ColumnName, risk: ColumnName, summary: ColumnName,
              })
              .strict(),
          })
          .strict(),
        findings: z
          .object({
            name: z.string().min(1),
            columns: z.object({ assessmentId: ColumnName, findingKey: ColumnName, observation: ColumnName, risk: ColumnName, recommendation: ColumnName }).strict(),
          })
          .strict(),
      })
      .strict(),
    lifecycle: z
      .object({
        status: z.object({ inProgress: Label, completed: Label, provisional: Label }).strict(),
        dispositions: z.array(Label).min(1),
        risks: z.array(Label).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    refineIdentityAgreesWithSites(profile, ctx);

    const checkPath = (template: string, path: (string | number)[]): void => {
      for (const token of unknownWorkspacePlaceholders(template)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `"{${token}}" is not a workspace placeholder; the placeholders are {vendor}, {vendorFolder}, {assessmentId}, {yyyy} and {mm}` });
      }
      if (template.startsWith("/")) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "a workspace template is library-relative and does not start with /" });
      if (template.split("/").some((segment) => segment === "..")) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "a workspace template cannot contain a .. segment" });
    };

    checkPath(profile.workspace.root, ["workspace", "root"]);
    profile.workspace.subfolders.forEach((template, index) => checkPath(template, ["workspace", "subfolders", index]));
    for (const [kind, template] of Object.entries(profile.workspace.artifacts)) checkPath(template, ["workspace", "artifacts", kind]);
    for (const kind of REQUIRED_ARTIFACT_KINDS) {
      if (!(kind in profile.workspace.artifacts)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspace", "artifacts", kind], message: `the module needs an artifact kind "${kind}"` });
      }
    }

    for (const token of unknownIdPlaceholders(profile.assessmentId.template)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assessmentId", "template"], message: `"{${token}}" is not an assessment id placeholder; the placeholders are {prefix}, {yyyy}, {mm}, {item} and {item:N}` });
    }

    const labels = Object.values(profile.lifecycle.status);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lifecycle", "status"], message: "the three status labels must differ, or a transition could not be told from the state it leaves" });
    }
  });

export type AssessmentProfile = z.infer<typeof AssessmentProfileSchema>;
```

`src/domain/profile/library.ts`: import `AssessmentProfile`, `AssessmentProfileSchema`; `export type AnyProfile = (Profile & { kind?: "compliance" }) | LibraryProfile | AssessmentProfile;`; add `export function isAssessmentProfile(profile: AnyProfile): profile is AssessmentProfile { return profile.kind === "assessment"; }`; in `loadAnyProfile` add the branch before the `kind !== "library"` refusal, and change that refusal's message to name the three kinds.

`src/profiles/registry.ts`: add

```ts
export class AssessmentProfileError extends Error {
  constructor(profileId: string) {
    super(
      `Profile "${profileId}" is an assessment profile: it carries a workspace and lists, not a workbook, taxonomy or deliverables, ` +
        "so this tool cannot use it. The assessment tools can; the compliance tools need a compliance profile.",
    );
    this.name = "AssessmentProfileError";
  }
}
```

and in `get`, after the library check: `if (isAssessmentProfile(held.profile)) throw new AssessmentProfileError(profileId);`. In `src/tools/errors.ts`, wherever `LibraryProfileError` is matched, match `AssessmentProfileError` the same way and return its message.

`src/modules/assessment/index.ts`:

```ts
import { AssessmentProfileSchema } from "../../domain/profile/assessment.js";
import type { DomainModule } from "../types.js";

/** The governed assessment workspace. Tools join in Tasks 5 to 7 of the 9c plan. */
export const assessmentModule: DomainModule = {
  kind: "assessment",
  profileSchema: AssessmentProfileSchema,
  tools: [],
};
```

`src/modules/index.ts`: `ALL_MODULES = [complianceModule, libraryModule, assessmentModule]`.

- [ ] **Step 9: Update the two registry tests**

`tests/tools/modules.test.ts`: the kinds assertion becomes `["compliance", "library", "assessment"]`; the twelve-tools test keeps its list (the module is still empty). `tests/tools/profile-kinds.test.ts`: add `ACCEPTS_ASSESSMENT = new Set<string>()` (filled in Task 5), add the assessment example to the registry the second test builds, and add a third test: every tool in `REQUIRES_COMPLIANCE` refuses profile `vendor-assessments` before any Graph request with text containing `assessment profile`. Rename `ACCEPTS_LIBRARY` to `ACCEPTS_SITE_PROFILES` with a comment carrying ruling 4.

- [ ] **Step 10: Run everything**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/domain/assessment/templates.ts src/domain/profile examples/profiles/assessment-example.json src/profiles/registry.ts src/tools/errors.ts src/modules tests/domain tests/tools/modules.test.ts tests/tools/profile-kinds.test.ts
git commit -m "feat(profile): the assessment profile kind, its templates, and an empty assessment module"
```

---

## Task 4: The state model and the preconditions

**Files:**
- Create: `src/domain/assessment/state.ts`
- Modify: `src/store/types.ts` (`priorContentHash`)
- Create: `tests/domain/assessment/state.test.ts`, `state.errors.test.ts`

**Interfaces:**
- Consumes: `AssessmentProfile["lists"]["assessments"]["columns"]` from Task 3, the `L2B_FIELDS_UPDATED` and `L1B_ITEM_READ` fixtures from Task 1.
- Produces: the types and functions below; Tasks 5 to 7 build every refusal from them.

- [ ] **Step 1: Write the failing tests**

`tests/domain/assessment/state.test.ts`:

- `recordFromFields(L1B_ITEM_READ.fields, "2", L1B_ITEM_READ.eTag, columns)` with the probe's identity columns (`assessmentId: "AssessmentId"`, `vendorFolder: "VendorFolder"`, `scope: "Scope"`, `status: "Status"`, `state: "State"`, `disposition: "Disposition"`, `risk: "Risk"`, `summary: "Summary"`) returns `{ itemId: "2", etag: ..., assessmentId: "PRB-20261107T203924Z-00002", vendorTitle: "probe 20261107T203924Z", vendorFolder: "ProbeVendor", scope: undefined, status: "In Progress", state: undefined, ... }`. The fixture has no Scope value, which is the point: an absent column reads as undefined, never as an empty string.
- `fieldsFor(columns, { status: "Completed", disposition: "Approved" })` returns `{ Status: "Completed", Disposition: "Approved" }` and nothing else.
- `requireInProgress(state, labels)` is `{ ok: true }` when `record.status === labels.inProgress`.
- `requireRoot(state)` is ok when `rootPresent`.
- `requireArtifact(state, "dossier")` is ok when that artifact is present.
- `allOf(a, b, c)` returns the first failure and `{ ok: true }` when all pass.

`tests/domain/assessment/state.errors.test.ts`, each asserting `ok: false`, `expected`, `observed` and at least one `evidence` entry with `source` and `target`:

- no record: `expected` names an assessment item, `observed` says none was found, evidence source `list`.
- status `Completed` when in progress required: observed names the label read.
- root absent: source `drive`, target is the root path.
- artifact absent: source `drive`, target is the artifact path, observed says not present.
- `requireArtifact` for a kind the state does not know throws, naming the kind.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/domain/assessment/state.test.ts tests/domain/assessment/state.errors.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/domain/assessment/state.ts`**

```ts
/**
 * What a lifecycle tool knows about one assessment after reading the lists
 * and the drive, and the preconditions it evaluates over that. Pure: the
 * reading is in src/tools/assessment/read-state.ts, the deciding is here, so
 * every refusal message can be tested against a state object with no tenant.
 *
 * A precondition failure carries evidence: what was read, from where, and
 * what it said. The agent and the operator see the same facts, which is what
 * the spec asks of a refusal.
 */
export interface AssessmentColumns {
  assessmentId: string; vendorFolder: string; scope: string; status: string;
  state: string; disposition: string; risk: string; summary: string;
}

export interface AssessmentRecord {
  itemId: string;
  etag: string | undefined;
  assessmentId: string | undefined;
  /** The list item's Title, which the module writes as the vendor's display name. */
  vendorTitle: string | undefined;
  vendorFolder: string | undefined;
  scope: string | undefined;
  status: string | undefined;
  state: string | undefined;
  disposition: string | undefined;
  risk: string | undefined;
  summary: string | undefined;
}

export interface ArtifactPresence {
  kind: string;
  path: string;
  present: boolean;
  eTag: string | undefined;
  size: number | undefined;
}

export interface AssessmentState {
  record: AssessmentRecord | undefined;
  rootPath: string | undefined;
  rootPresent: boolean;
  artifacts: ArtifactPresence[];
}

export interface Evidence {
  source: "list" | "drive";
  target: string;
  found: string;
}

export type Precondition = { ok: true } | { ok: false; expected: string; observed: string; evidence: Evidence[] };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function recordFromFields(fields: Record<string, unknown>, itemId: string, etag: string | undefined, columns: AssessmentColumns): AssessmentRecord {
  return {
    itemId,
    etag,
    assessmentId: text(fields[columns.assessmentId]),
    vendorTitle: text(fields.Title),
    vendorFolder: text(fields[columns.vendorFolder]),
    scope: text(fields[columns.scope]),
    status: text(fields[columns.status]),
    state: text(fields[columns.state]),
    disposition: text(fields[columns.disposition]),
    risk: text(fields[columns.risk]),
    summary: text(fields[columns.summary]),
  };
}

/** Logical field values to the list's internal column names; only the keys given are written. */
export function fieldsFor(columns: AssessmentColumns, values: Partial<Record<keyof AssessmentColumns, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[columns[key as keyof AssessmentColumns]] = value;
  }
  return out;
}

export function requireRecord(state: AssessmentState, lookedUp: string): Precondition {
  if (state.record !== undefined) return { ok: true };
  return {
    ok: false,
    expected: "an assessment item matching the id given",
    observed: "no item matched",
    evidence: [{ source: "list", target: lookedUp, found: "no item" }],
  };
}

export function requireInProgress(state: AssessmentState, labels: { inProgress: string }): Precondition {
  const record = state.record;
  if (record === undefined) return requireRecord(state, "the assessments list");
  if (record.status === labels.inProgress) return { ok: true };
  return {
    ok: false,
    expected: `status "${labels.inProgress}"`,
    observed: record.status === undefined ? "no status value" : `status "${record.status}"`,
    evidence: [{ source: "list", target: `assessments item ${record.itemId}`, found: record.status ?? "(empty)" }],
  };
}

export function requireRoot(state: AssessmentState): Precondition {
  if (state.rootPresent) return { ok: true };
  return {
    ok: false,
    expected: "the workspace root folder present",
    observed: "the folder was not found",
    evidence: [{ source: "drive", target: state.rootPath ?? "(root path not computed)", found: "not found" }],
  };
}

export function requireArtifact(state: AssessmentState, kind: string): Precondition {
  const artifact = state.artifacts.find((entry) => entry.kind === kind);
  if (artifact === undefined) throw new Error(`The state carries no artifact kind "${kind}"; the profile's artifacts decide which kinds exist.`);
  if (artifact.present) return { ok: true };
  return {
    ok: false,
    expected: `the ${kind} present at its canonical path`,
    observed: "not present",
    evidence: [{ source: "drive", target: artifact.path, found: "not found" }],
  };
}

export function allOf(...checks: Precondition[]): Precondition {
  return checks.find((check) => !check.ok) ?? { ok: true };
}
```

`src/store/types.ts`: add `/** sha256 hex of the bytes an overwrite replaced. */ priorContentHash?: string;` to `JournalEntry` and `priorContentHash: z.string().optional()` to `JournalEntrySchema`. Add one case to the existing journal store tests (both implementations) that an entry carrying `priorContentHash` reads back with it.

- [ ] **Step 4: Run the tests, lint and typecheck**

Run: `npx vitest run tests/domain tests/store && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/assessment/state.ts src/store/types.ts tests/domain/assessment tests/store
git commit -m "feat(assessment): the state model, precondition evaluation, and the journal's prior content hash"
```

---
## Task 5: Tool infrastructure, `open_assessment` and `get_assessment`

**Files:**
- Create: `src/tools/assessment/context.ts`, `read-state.ts`, `hash.ts`, `journal.ts`, `refusal.ts`, `output.ts`, `open.ts`, `get.ts`
- Create: `src/tools/definitions/open-assessment.ts`, `src/tools/definitions/get-assessment.ts`
- Modify: `src/modules/assessment/index.ts` (register the two)
- Create: `tests/tools/assessment/fake-graph.ts`, `open.test.ts`, `open.errors.test.ts`, `get.test.ts`
- Modify: `tests/tools/contract.test.ts` (`EXPECTED_TOOL_NAMES`), `tests/tools/modules.test.ts`, `tests/tools/profile-kinds.test.ts` (`ACCEPTS_ASSESSMENT`)

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces: `resolveAssessmentContext`, `readAssessmentState`, `findAssessmentById`, `findInProgressAssessment`, `workspacePaths`, `sha256Hex`, `appendJournal`, `refusalResult`, `ASSESSMENT_SUMMARY_SHAPE`. Tasks 6 and 7 reuse all of them and copy the handler shape of `open.ts`.

- [ ] **Step 1: Write the scripted fake Graph client**

`tests/tools/assessment/fake-graph.ts`: a `GraphClient` whose `get`, `post`, `patch` and `putBytes` consult an ordered script of `{ method, pathIncludes, headersInclude?, response | throws }` entries, record every call (method, path, body, headers), increment the request counter per call, and throw a descriptive error when a call has no scripted answer. Responses for list items and drive items are built from the Task 1 fixtures with helper functions `listItem(id, fields)`, `page(items)`, `folderItem(name, etag)`, `fileItem(name, etag, size)` so a test states intent rather than JSON. A `getBytes` entry returns bytes. Export `createScriptedGraph(script)` returning `{ graph, calls }`.

- [ ] **Step 2: Write the failing tests for `open_assessment`**

`tests/tools/assessment/open.test.ts`, each test building a `createFakeToolContext` whose `profiles` registry holds `examples/profiles/assessment-example.json` with `grantedSiteUrl` `https://contoso.sharepoint.com/sites/Example`, and whose `graph` is a scripted fake:

- **Creates everything on first open.** Script, in order: site lookup `{ id: "site-1" }`; drives page `[{ id: "drive-1", name: "Documents" }]`; vendors query (`pathIncludes: "/lists/Vendors/items"`, filter contains `Title eq 'Acme Corp'`) empty page; vendors create returns item `7` with `FolderName: "Acme Corp"`; assessments query (filter contains `VendorFolder eq 'Acme Corp'`, `Scope eq 'Security'`, `Status eq 'In Progress'`) empty page; assessments create returns item `2` whose fields echo the body; fields patch returns fields with `AssessmentId: "ASM-2026-00002"`; item read returns the same; folder creates for `Assessments`, `Acme Corp`, `ASM-2026-00002`, then `Research`, `Evidence`, `Published` each answering created; root read returns a folder item. Assert: `result.isError` undefined; `structuredContent.assessmentId === "ASM-2026-00002"`; `workspaceRoot === "Assessments/Acme Corp/ASM-2026-00002"`; `created === true`; the assessments create body has `Title: "Acme Corp"`, `Status: "In Progress"`, `State: "ID"` and no `AssessmentId`; the patch body is `{ AssessmentId: "ASM-2026-00002" }`; the journal (read through `context.store.listJournal("vendor-assessments", "ASM-2026-00002")`) has entries with operations `list_item_created` (vendor and assessment), `list_item_updated`, and six `folder_created`, all sharing one `correlationId` equal to `structuredContent.correlationId`; `graphRequests` equals `graph.requests()`.
- **Returns the open assessment on a second call.** Script: site, drives, vendors query returns item `7`, assessments query returns item `2` with `AssessmentId: "ASM-2026-00002"`, root read found, artifact reads not found (404 throws). Assert `created === false`, `assessmentId` as before, no `post` or `patch` call recorded, journal unchanged (empty, since this store is fresh), text contains "already open".
- **Resumes an open that died before the id was written.** Assessments query returns item `3` with no `AssessmentId`; assert the patch happens and folders are created.
- **A folder that already exists is reported satisfied.** The `Assessments` create throws a 409 `nameAlreadyExists`; assert no `folder_created` journal entry for it and the rest proceeds.
- **The stored vendor folder name wins.** Vendors query returns item with `FolderName: "ACME"`; assert the assessment is created with `VendorFolder: "ACME"` and the root path uses `ACME`.

`tests/tools/assessment/open.errors.test.ts`:

- a `vendor` of `'"*:<>?/\\|'` returns `isError` with text naming the vendor name, and `graph.requests()` is 0.
- a library profile id returns `isError` with text containing `assessment profile`, and `graph.requests()` is 0.
- a `profileId` the registry does not know returns `isError` through `describeToolFailure`.
- the read back after the id patch returns a different `AssessmentId`: `isError`, text says the write back did not read back, and the journal holds the create and the update (what did happen) and no folder entries.
- the root read back after the creates answers 404: `isError`, text names the root path.
- a 403 from the first list query: `isError`, the text is `describeToolFailure`'s and does not guess a cause.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/tools/assessment`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement the shared infrastructure**

`src/tools/assessment/hash.ts`:

```ts
import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
```

`src/tools/assessment/context.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { AssessmentProfile } from "../../domain/profile/assessment.js";
import { isAssessmentProfile } from "../../domain/profile/library.js";
import { resolveDrive } from "../../graph/drive.js";
import type { ToolContext } from "../context.js";

export interface AssessmentContext {
  profile: AssessmentProfile;
  siteId: string;
  driveId: string;
  /** One per tool call, carried on every journal entry it writes and returned to the caller. */
  correlationId: string;
  now: Date;
}

export class NotAnAssessmentProfileError extends Error {
  constructor(profileId: string, kind: string) {
    super(`Profile "${profileId}" is a ${kind} profile; this tool needs an assessment profile, which carries the workspace and the lists.`);
    this.name = "NotAnAssessmentProfileError";
  }
}

/**
 * Two Graph reads per call, the site and its drives, paid by every tool so a
 * profile's library is resolved by name as Graph lists it (measured
 * 2026-11-07: the default library is "Documents", not its URL segment).
 */
export async function resolveAssessmentContext(context: ToolContext, profileId: string): Promise<AssessmentContext> {
  const profile = context.profiles.getAny(profileId);
  if (!isAssessmentProfile(profile)) throw new NotAnAssessmentProfileError(profileId, profile.kind ?? "compliance");
  const location = await resolveDrive(context.graph, profile.identity.siteUrl, profile.identity.library);
  return { profile, siteId: location.siteId, driveId: location.driveId, correlationId: randomUUID(), now: context.now() };
}
```

`src/tools/assessment/read-state.ts`:

```ts
import type { GraphClient } from "../../graph/client.js";
import { readDriveItem } from "../../graph/items.js";
import { odataString, queryListItems } from "../../graph/lists.js";
import { joinWorkspacePath, renderWorkspaceTemplate } from "../../domain/assessment/templates.js";
import { recordFromFields, type AssessmentRecord, type AssessmentState } from "../../domain/assessment/state.js";
import type { AssessmentContext } from "./context.js";

export interface WorkspacePaths {
  root: string;
  subfolders: string[];
  artifacts: Record<string, string>;
}

export function workspacePaths(ac: AssessmentContext, record: { vendorTitle: string; vendorFolder: string; assessmentId: string }): WorkspacePaths {
  const values = { vendor: record.vendorTitle, vendorFolder: record.vendorFolder, assessmentId: record.assessmentId, now: ac.now };
  const root = joinWorkspacePath(renderWorkspaceTemplate(ac.profile.workspace.root, values));
  const subfolders = ac.profile.workspace.subfolders.map((template) => joinWorkspacePath(root, renderWorkspaceTemplate(template, values)));
  const artifacts: Record<string, string> = {};
  for (const [kind, template] of Object.entries(ac.profile.workspace.artifacts)) {
    artifacts[kind] = joinWorkspacePath(root, renderWorkspaceTemplate(template, values));
  }
  return { root, subfolders, artifacts };
}

function assessmentsList(ac: AssessmentContext): { siteId: string; listName: string } {
  return { siteId: ac.siteId, listName: ac.profile.lists.assessments.name };
}

export async function findAssessmentById(graph: Pick<GraphClient, "get">, ac: AssessmentContext, assessmentId: string): Promise<AssessmentRecord | undefined> {
  const columns = ac.profile.lists.assessments.columns;
  const items = await queryListItems(graph, { ...assessmentsList(ac), filter: `fields/${columns.assessmentId} eq ${odataString(assessmentId)}` });
  if (items.length > 1) {
    throw new Error(`${items.length} items in list "${ac.profile.lists.assessments.name}" carry the assessment id "${assessmentId}"; the server will not choose between them.`);
  }
  const item = items[0];
  return item === undefined ? undefined : recordFromFields(item.fields, item.id, item.eTag, columns);
}

export async function findInProgressAssessment(
  graph: Pick<GraphClient, "get">,
  ac: AssessmentContext,
  vendorFolder: string,
  scope: string,
): Promise<AssessmentRecord | undefined> {
  const columns = ac.profile.lists.assessments.columns;
  const filter =
    `fields/${columns.vendorFolder} eq ${odataString(vendorFolder)} and ` +
    `fields/${columns.scope} eq ${odataString(scope)} and ` +
    `fields/${columns.status} eq ${odataString(ac.profile.lifecycle.status.inProgress)}`;
  const items = await queryListItems(graph, { ...assessmentsList(ac), filter });
  // The oldest open one is the one a retry meant; a newer duplicate is a defect to report, not to pick.
  const sorted = [...items].sort((a, b) => Number(a.id) - Number(b.id));
  const item = sorted[0];
  return item === undefined ? undefined : recordFromFields(item.fields, item.id, item.eTag, columns);
}

/** Reads the drive side of the state for a record whose id and folder are known. */
export async function readAssessmentState(graph: Pick<GraphClient, "get">, ac: AssessmentContext, record: AssessmentRecord | undefined): Promise<AssessmentState> {
  if (record === undefined || record.assessmentId === undefined || record.vendorFolder === undefined || record.vendorTitle === undefined) {
    return { record, rootPath: undefined, rootPresent: false, artifacts: [] };
  }
  const paths = workspacePaths(ac, { vendorTitle: record.vendorTitle, vendorFolder: record.vendorFolder, assessmentId: record.assessmentId });
  const root = await readDriveItem(graph, { driveId: ac.driveId, path: paths.root });
  const artifacts = [];
  for (const [kind, path] of Object.entries(paths.artifacts)) {
    const lookup = await readDriveItem(graph, { driveId: ac.driveId, path });
    artifacts.push({
      kind,
      path,
      present: lookup.kind === "found" && !lookup.item.isFolder,
      eTag: lookup.kind === "found" ? lookup.item.eTag : undefined,
      size: lookup.kind === "found" ? lookup.item.size : undefined,
    });
  }
  return { record, rootPath: paths.root, rootPresent: root.kind === "found" && root.item.isFolder, artifacts };
}
```

`src/tools/assessment/journal.ts`:

```ts
import type { JournalEntry } from "../../store/types.js";
import type { ToolContext } from "../context.js";
import type { AssessmentContext } from "./context.js";

/**
 * Appended after the write it records has been confirmed, never before: the
 * store keeps duplicate rows (9b amendment), so journaling an intent that then
 * failed would leave a row describing a write that never happened.
 */
export async function appendJournal(
  context: ToolContext,
  ac: AssessmentContext,
  assessmentId: string,
  entry: Omit<JournalEntry, "at" | "correlationId">,
): Promise<void> {
  await context.store.appendJournalEntry(ac.profile.profileId, assessmentId, {
    at: context.now().toISOString(),
    correlationId: ac.correlationId,
    ...entry,
  });
}
```

`src/tools/assessment/refusal.ts`:

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Precondition } from "../../domain/assessment/state.js";

/**
 * A structured refusal, isError with the evidence as prose and as structured
 * content. The SDK skips output validation on an error result (pinned by
 * tests/mcp/build-server.errors.test.ts), so the refusal shape rides along
 * without widening every tool's output schema.
 */
export function refusalResult(tool: string, stage: string, assessmentId: string, check: Precondition & { ok: false }): CallToolResult {
  const evidence = check.evidence.map((item) => `${item.source} ${item.target}: ${item.found}`).join("; ");
  return {
    isError: true,
    structuredContent: { refused: true, tool, stage, assessmentId, expected: check.expected, observed: check.observed, evidence: check.evidence },
    content: [
      {
        type: "text" as const,
        text: `${tool} refused the ${stage} stage for ${assessmentId}: expected ${check.expected}, observed ${check.observed}. Read to decide: ${evidence}. Nothing was written.`,
      },
    ],
  };
}
```

`src/tools/assessment/output.ts` holds the zod raw shapes every assessment tool returns: `ASSESSMENT_SUMMARY_SHAPE` (`assessmentId`, `itemId`, `vendor`, `vendorFolder`, `scope`, `status`, `state`, `disposition`, `risk`, each with a `describe` carrying "for example"), `ARTIFACT_PRESENCE_SHAPE`, `JOURNAL_SUMMARY_SHAPE` (`entries: number`, `lastAt: string optional`, `byOperation: record of number`), and `REFUSAL_SHAPE` (optional, documented as present only on `isError`).

- [ ] **Step 5: Implement `open_assessment`**

`src/tools/assessment/open.ts`:

```ts
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { createFolder, readDriveItem } from "../../graph/items.js";
import { createListItem, getListItem, odataString, queryListItems, updateListItemFields } from "../../graph/lists.js";
import { renderAssessmentId, sanitizeFolderName } from "../../domain/assessment/templates.js";
import { fieldsFor, recordFromFields } from "../../domain/assessment/state.js";
import { resolveAssessmentContext, type AssessmentContext } from "./context.js";
import { findInProgressAssessment, readAssessmentState, workspacePaths } from "./read-state.js";
import { appendJournal } from "./journal.js";
import { ASSESSMENT_SUMMARY_SHAPE } from "./output.js";

export const OPEN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('The assessment profile to open under, for example "vendor-assessments".'),
  vendor: z.string().min(1).max(200).describe('The vendor\'s display name, for example "Acme Corp". The server derives the folder name from it.'),
  scope: z.string().min(1).max(200).describe('What this assessment covers, for example "Security" or "Data processing agreement 2026".'),
} satisfies z.ZodRawShape;

export const OPEN_OUTPUT_SCHEMA = {
  ...ASSESSMENT_SUMMARY_SHAPE,
  workspaceRoot: z.string().describe('Library-relative root folder, for example "Assessments/Acme Corp/ASM-2026-00002".'),
  subfolders: z.array(z.string()).describe('Library-relative folders under the root, for example ["Assessments/Acme Corp/ASM-2026-00002/Research"].'),
  created: z.boolean().describe("True when this call created the assessment, false when it returned one already in progress, for example false on a retry."),
  correlationId: z.string().describe('Shared by every journal entry this call wrote, for example "6f1c...".'),
  graphRequests: z.number().int().describe("Graph requests this call issued, for example 14."),
} satisfies z.ZodRawShape;

const InputObject = z.object(OPEN_INPUT_SCHEMA);
const STAGE = "ID";

export async function runOpenAssessment(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "open_assessment", profileId: args.profileId };
  const before = context.graph.requests();

  const vendorFolder = sanitizeFolderName(args.vendor);
  if (vendorFolder.length === 0) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `The vendor name "${args.vendor}" has no characters SharePoint allows in a folder name, so no folder could be named for it. Nothing was written.` }],
    };
  }

  try {
    const ac = await resolveAssessmentContext(context, args.profileId);
    subject.siteUrl = ac.profile.identity.siteUrl;
    subject.library = ac.profile.identity.library;
    const lists = ac.profile.lists;
    const columns = lists.assessments.columns;
    const labels = ac.profile.lifecycle.status;

    // The vendor record. Its stored folder name wins over recomputation, so a convention set once sticks.
    const vendors = await queryListItems(context.graph, { siteId: ac.siteId, listName: lists.vendors.name, filter: `fields/Title eq ${odataString(args.vendor)}` });
    let folder = vendorFolder;
    if (vendors.length === 0) {
      const created = await createListItem(context.graph, { siteId: ac.siteId, listName: lists.vendors.name, fields: { Title: args.vendor, [lists.vendors.columns.folderName]: vendorFolder } });
      await appendJournal(context, ac, "(vendor)", { stage: STAGE, operation: "list_item_created", target: `${lists.vendors.name}/${created.id}`, etagAfter: created.eTag });
    } else {
      const stored = vendors[0]!.fields[lists.vendors.columns.folderName];
      if (typeof stored === "string" && stored.length > 0) folder = stored;
    }

    // Retry rule: an assessment already in progress for this vendor and scope is returned, not duplicated.
    let record = await findInProgressAssessment(context.graph, ac, folder, args.scope);
    let created = false;
    if (record === undefined) {
      const item = await createListItem(context.graph, {
        siteId: ac.siteId,
        listName: lists.assessments.name,
        fields: { Title: args.vendor, ...fieldsFor(columns, { vendorFolder: folder, scope: args.scope, status: labels.inProgress, state: STAGE }) },
      });
      await appendJournal(context, ac, "(unassigned)", { stage: STAGE, operation: "list_item_created", target: `${lists.assessments.name}/${item.id}`, etagAfter: item.eTag });
      record = recordFromFields(item.fields, item.id, item.eTag, columns);
      created = true;
    }

    // The id is rendered from the item id and written back before any folder exists.
    if (record.assessmentId === undefined) {
      const rendered = renderAssessmentId(ac.profile.assessmentId.template, { prefix: ac.profile.assessmentId.prefix, itemId: Number(record.itemId), now: ac.now });
      await updateListItemFields(context.graph, { siteId: ac.siteId, listName: lists.assessments.name, itemId: record.itemId, fields: fieldsFor(columns, { assessmentId: rendered }) });
      await appendJournal(context, ac, rendered, { stage: STAGE, operation: "list_item_updated", target: `${lists.assessments.name}/${record.itemId}`, etagBefore: record.etag });
      const back = await getListItem(context.graph, { siteId: ac.siteId, listName: lists.assessments.name, itemId: record.itemId });
      const readBack = back === undefined ? undefined : recordFromFields(back.fields, back.id, back.eTag, columns);
      if (readBack?.assessmentId !== rendered) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `The assessment id "${rendered}" was written to ${lists.assessments.name} item ${record.itemId} but read back as ${JSON.stringify(readBack?.assessmentId)}. No folder was created. The item and the journal record what did happen.` }],
        };
      }
      record = readBack;
    }

    const paths = workspacePaths(ac, { vendorTitle: record.vendorTitle ?? args.vendor, vendorFolder: record.vendorFolder ?? folder, assessmentId: record.assessmentId! });
    const toCreate = [paths.root, ...paths.subfolders];
    const ensured = new Set<string>();
    for (const target of toCreate) {
      const segments = target.split("/");
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const path = segments.slice(0, depth).join("/");
        if (ensured.has(path)) continue;
        const outcome = await createFolder(context.graph, { driveId: ac.driveId, parentPath: segments.slice(0, depth - 1).join("/"), name: segments[depth - 1]! });
        if (outcome.kind === "created") {
          await appendJournal(context, ac, record.assessmentId!, { stage: STAGE, operation: "folder_created", target: path, etagAfter: outcome.item.eTag });
        }
        ensured.add(path);
      }
    }

    const root = await readDriveItem(context.graph, { driveId: ac.driveId, path: paths.root });
    if (root.kind !== "found" || !root.item.isFolder) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `The workspace root "${paths.root}" was created or found present, but reading it back ${root.kind === "found" ? "returned a file, not a folder" : "answered 404"}. The journal records what was created.` }],
      };
    }

    if (!created) await readAssessmentState(context.graph, ac, record);

    const output = {
      assessmentId: record.assessmentId!,
      itemId: record.itemId,
      vendor: record.vendorTitle ?? args.vendor,
      vendorFolder: record.vendorFolder ?? folder,
      scope: record.scope ?? args.scope,
      status: record.status ?? labels.inProgress,
      state: record.state,
      disposition: record.disposition,
      risk: record.risk,
      workspaceRoot: paths.root,
      subfolders: paths.subfolders,
      created,
      correlationId: ac.correlationId,
      graphRequests: context.graph.requests() - before,
    };
    const text = created
      ? `Opened ${output.assessmentId} for ${output.vendor} (${output.scope}): item ${output.itemId} in ${lists.assessments.name}, workspace ${paths.root} with ${paths.subfolders.length} subfolders, all read back.`
      : `${output.assessmentId} for ${output.vendor} (${output.scope}) is already open; returned, not repeated. Workspace ${paths.root} is present.`;
    return { structuredContent: output, content: [{ type: "text" as const, text }] };
  } catch (error) {
    console.error(`open_assessment failed for profile "${args.profileId}"`, error);
    return { isError: true, content: [{ type: "text" as const, text: describeToolFailure(error, subject) }] };
  }
}
```

The `readAssessmentState` call on the retry path exists so the retry proves the drive side is still there; drop the result but keep the read, and if the root is absent the earlier read back has already refused. Journal targets for the vendor item and the pre-id assessment item use the placeholders `(vendor)` and `(unassigned)` as the journal's assessment key, because no id exists yet; `get_assessment` reads only the keyed journal, and Task 8 records this in the spec amendments.

`src/tools/definitions/open-assessment.ts`:

```ts
import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { OPEN_INPUT_SCHEMA, OPEN_OUTPUT_SCHEMA, runOpenAssessment } from "../assessment/open.js";

export const openAssessment: ToolDefinition = {
  name: "open_assessment",
  kind: "lifecycle",
  title: "Open an assessment",
  description: [
    "Start an assessment for a vendor and scope, or return the one already in progress for that pair. Creates the vendor record if absent, creates the assessment item, renders the assessment id from the item id and writes it back, then creates the workspace root and its subfolders at the paths the profile computes, reading everything back.",
    "Call this once at the ID stage. Calling it again for the same vendor and scope returns the open assessment and creates nothing.",
    SAFETY_SENTENCES.lifecycle,
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(OPEN_INPUT_SCHEMA),
  outputSchema: OPEN_OUTPUT_SCHEMA,
  handler: runOpenAssessment,
};
```

- [ ] **Step 6: Write the failing tests for `get_assessment`, then implement it**

`tests/tools/assessment/get.test.ts`:

- by id: script site, drives, assessments query returning item `2` with the probe's fields plus `Status: "In Progress"`, root read found, dossier read found as a file of size 16, executive_summary and publication reads 404; the store pre-seeded with two journal entries for `vendor-assessments` / `ASM-2026-00002`. Assert `found === true`, `assessment.status`, `artifacts` has three entries with `present` true, false, false, `journal.entries === 2`, `journal.byOperation.folder_created === 1` (per the seeded entries), and `graph.requests()` equals `graphRequests`.
- by vendor: assessments query filtered on `VendorFolder eq 'Acme Corp'` returning two items; assert `found === true`, `assessments.length === 2`, no drive reads happened.
- by id, unknown: empty page; assert `found === false` and `isError` undefined, text says no assessment carries that id.
- neither or both of `assessmentId` and `vendor`: `isError` before any Graph request, text equal to the tool's `inputConstraints`.

`src/tools/assessment/get.ts`: input `{ profileId, assessmentId?: string, vendor?: string }` with `inputConstraints = "Exactly one of assessmentId or vendor is given."`; by id uses `findAssessmentById` then `readAssessmentState` then `store.listJournal`; by vendor queries `fields/{vendorFolder} eq odataString(sanitizeFolderName(vendor))` and returns summaries. Output shape: `found: boolean`, `assessment: object(ASSESSMENT_SUMMARY_SHAPE).optional()`, `artifacts: array(ARTIFACT_PRESENCE_SHAPE).optional()`, `journal: object(JOURNAL_SUMMARY_SHAPE).optional()`, `assessments: array(object(ASSESSMENT_SUMMARY_SHAPE)).optional()`, `graphRequests`. Kind `read`, annotations read only, idempotent, open world, `SAFETY_SENTENCES.read`, description includes the constraint sentence verbatim.

- [ ] **Step 7: Register and update the registry tests**

`src/modules/assessment/index.ts`: `tools: [openAssessment, getAssessment]`. `tests/tools/contract.test.ts`: add `"open_assessment"` and `"get_assessment"` to `EXPECTED_TOOL_NAMES`. `tests/tools/modules.test.ts`: the twelve-tools test is renamed to say the pre-module tools are still present and asserts with `toEqual(expect.arrayContaining([...]))` over the twelve, plus a new assertion that the assessment module's tool names equal `["open_assessment", "get_assessment"]` for now. `tests/tools/profile-kinds.test.ts`: `ACCEPTS_ASSESSMENT` gains both names, and a test proves each refuses a compliance profile and a library profile before any Graph request with text containing `assessment profile`.

- [ ] **Step 8: Run everything**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS. The contract test's "for example" rule applies to every output field, so check each `describe`.

- [ ] **Step 9: Commit**

```bash
git add src/tools/assessment src/tools/definitions/open-assessment.ts src/tools/definitions/get-assessment.ts src/modules/assessment/index.ts tests/tools
git commit -m "feat(assessment): open_assessment and get_assessment on the shared assessment tool infrastructure"
```

---
## Task 6: `save_assessment_artifact`, `read_assessment_artifact` and `verify_publication`

**Files:**
- Create: `src/tools/assessment/save-artifact.ts`, `read-artifact.ts`, `verify-publication.ts`
- Create: `src/tools/definitions/save-assessment-artifact.ts`, `read-assessment-artifact.ts`, `verify-publication.ts`
- Modify: `src/modules/assessment/index.ts`, `tests/tools/contract.test.ts`, `tests/tools/modules.test.ts`, `tests/tools/profile-kinds.test.ts`
- Create: `tests/tools/assessment/save-artifact.test.ts`, `save-artifact.errors.test.ts`, `read-artifact.test.ts`, `verify-publication.test.ts`

**Interfaces:**
- Consumes: everything Task 5 produced; `createFile`, `overwriteFile`, `readDriveItem` from Task 1; `downloadDriveItem` from `src/graph/content.ts` (signature `(client, { driveId, workbookPath })`, the name is historical and the function downloads any item); `MAX_SMALL_UPLOAD_BYTES`.
- Produces: the three tools.

- [ ] **Step 1: Write the failing tests for `save_assessment_artifact`**

Common script prefix for a found, in progress assessment: site, drives, assessments query returning item `2` (`AssessmentId: "ASM-2026-00002"`, `VendorFolder: "Acme Corp"`, `Title: "Acme Corp"`, `Status: "In Progress"`), root read found, dossier read as scripted per case, executive_summary read 404, publication read 404.

`save-artifact.test.ts`:

- **Creates the dossier.** Dossier read 404; `putBytes` to `.../Research/Acme%20Corp_Research_Dossier.md:/content?@microsoft.graph.conflictBehavior=fail` answers `F2A_FILE_CREATED` shaped item with eTag `"e1"`; read back item found with size equal to the content's byte length and eTag `"e1"`; `getBytes` returns the same bytes; `patch` on the assessments item fields `{ State: "DOSSIER" }`. Assert `operation === "created"`, `sha256` equals `sha256Hex` of the content, `bytes` equals the length, the journal has `file_created` with `contentHash` and `etagAfter: "e1"` and `list_item_updated`, stage `DOSSIER`.
- **Overwrites the dossier under its ETag.** Dossier read found with eTag `"e1"`; `getBytes` first returns the prior bytes; `putBytes` with header `if-match: "e1"` and no conflictBehavior answers an item with eTag `"e2"`; read back found eTag `"e2"`; `getBytes` returns the new bytes; patch `State: "CORRECTION"`. Assert `operation === "overwritten"`, journal `file_overwritten` with `etagBefore: "e1"`, `etagAfter: "e2"`, `contentHash` of the new bytes and `priorContentHash` of the prior bytes.
- **Another kind uses its own stage.** Kind `executive_summary`, read 404, create; assert stage `EXECUTIVE_SUMMARY` and the path `.../Published/ASM-2026-00002_Executive_Summary.md`.
- **Content type.** A `.md` path is sent as `text/markdown`, anything else as `text/plain`.

`save-artifact.errors.test.ts`:

- content whose UTF-8 encoding is 4194305 bytes: `isError`, text names the cap, `graph.requests()` is 0.
- kind `publication`: `isError` before any Graph request, text says the publication is written by the publisher and only verified here.
- kind not in the profile: `isError` before any Graph request, text lists the profile's kinds.
- assessment not found: refusal with `structuredContent.refused === true`, stage `DOSSIER`, `expected` names an assessment item.
- status `Completed`: refusal, `observed` contains `Completed`.
- root absent: refusal with drive evidence naming the root path.
- create answers 409: `isError`, text says the file appeared between the read and the write and to call again; no journal entry.
- overwrite answers 412: `isError`, text says the file changed between the read and the write; no journal entry.
- read back hash differs from what was sent: `isError`, text says the read back did not match, and the journal still records the write (it happened) with the hash of what was sent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools/assessment/save-artifact.test.ts tests/tools/assessment/save-artifact.errors.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `save_assessment_artifact`**

`src/tools/assessment/save-artifact.ts`, following `open.ts`'s shape (parse, subject, resolve, try, describeToolFailure):

```ts
export const SAVE_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('The assessment profile, for example "vendor-assessments".'),
  assessmentId: z.string().min(1).describe('The id open_assessment returned, for example "ASM-2026-00002".'),
  kind: z.string().min(1).describe('An artifact kind the profile names, for example "dossier" or "executive_summary". "publication" is refused: the publisher writes it and verify_publication checks it.'),
  content: z.string().min(1).describe('The full text to persist, UTF-8, for example "# Acme Corp research dossier ...". Up to 4 MiB encoded.'),
} satisfies z.ZodRawShape;

export const SAVE_OUTPUT_SCHEMA = {
  assessmentId: z.string().describe('For example "ASM-2026-00002".'),
  kind: z.string().describe('For example "dossier".'),
  path: z.string().describe('Library-relative path written, for example "Assessments/Acme Corp/ASM-2026-00002/Research/Acme Corp_Research_Dossier.md".'),
  operation: z.enum(["created", "overwritten"]).describe('Which write happened, for example "created" on the first save.'),
  stage: z.string().describe('Journal stage recorded, for example "DOSSIER", or "CORRECTION" when the dossier was overwritten.'),
  bytes: z.number().int().describe("Bytes read back, for example 2048."),
  sha256: z.string().describe('sha256 of the bytes read back, for example "9f86d0...".'),
  eTag: z.string().optional().describe('The item\'s ETag after the write, for example "\\"{...},2\\"".'),
  correlationId: z.string().describe('For example "6f1c...".'),
  graphRequests: z.number().int().describe("For example 9."),
} satisfies z.ZodRawShape;
```

Handler order, each step a few lines:

1. Encode `content` with `TextEncoder`; if `byteLength > MAX_SMALL_UPLOAD_BYTES` return `isError` with `new UploadTooLargeError(byteLength).message` and no Graph call.
2. Resolve the context. If `kind === "publication"` return `isError` ("The publication is written by the consumer's publisher at its canonical path; verify_publication checks it. Nothing was written."). If `kind` is not a key of `profile.workspace.artifacts` return `isError` listing the keys.
3. `record = await findAssessmentById(...)`; `state = await readAssessmentState(...)`; `check = allOf(requireRecord(state, filter), requireInProgress(state, labels), requireRoot(state))`; on failure return `refusalResult("save_assessment_artifact", stageFor(kind, false), args.assessmentId, check)`.
4. `path = state.artifacts.find(a => a.kind === kind)!.path`; `lookup = state.artifacts` entry; `contentType = path.endsWith(".md") ? "text/markdown" : "text/plain"`.
5. If not present: `outcome = await createFile(...)`; `name_conflict` returns `isError` ("...appeared between the read and the write; call again and the server will overwrite it under its ETag."). If present: `prior = await downloadDriveItem(graph, { driveId, workbookPath: path })` (through `getBytes`, capped by that function's own limit), `priorHash = sha256Hex(prior)`; `outcome = await overwriteFile({ ..., etag: lookup.eTag! })`; if `lookup.eTag` is undefined return `isError` saying the item carried no ETag so no precondition could be sent; `precondition_failed` returns `isError` ("...changed between the read and the write; nothing was replaced; call again.").
6. Read back: `after = await readDriveItem(...)`; `bytesBack = await downloadDriveItem(...)`; `hashBack = sha256Hex(bytesBack)`; `sent = sha256Hex(bytes)`.
7. Journal, after the write confirmed: operation `file_created` or `file_overwritten`, stage `stageFor(kind, overwritten)`, target `path`, `etagBefore` (overwrite only), `etagAfter: outcome.item.eTag`, `contentHash: sent`, `priorContentHash` (overwrite only).
8. If `hashBack !== sent`: return `isError` ("...was written but read back with a different hash... the journal records the write with the hash of what was sent.").
9. `updateListItemFields` on the assessments item with `fieldsFor(columns, { state: stage })`; journal `list_item_updated` with `etagBefore: record.etag`.
10. Return the output and a text line naming path, operation, bytes and hash prefix.

`stageFor(kind, overwritten)`: `kind === "dossier" && overwritten ? "CORRECTION" : kind.toUpperCase()`.

Definition: kind `lifecycle`, title "Save an assessment artifact", description states it creates at the profile's path or overwrites under the ETag it just read, reads back, and that `publication` is refused; includes `SAFETY_SENTENCES.lifecycle`.

- [ ] **Step 4: Write the failing tests for the two read tools, then implement them**

`read-artifact.test.ts`: script site, drives, assessments query item `2`, dossier read found eTag `"e1"` size 16, `getBytes` returns the UTF-8 bytes of `"# probe v2\n"`. Assert `content === "# probe v2\n"`, `sha256`, `bytes === 11`, `eTag === "e1"`, `path`. Errors in the same file under a second describe: unknown assessment is `isError` with text saying no assessment carries the id (a read tool reports, it does not refuse); artifact absent is `isError` naming the path; bytes that are not valid UTF-8 (`new Uint8Array([0xff, 0xfe, 0x00])`) is `isError` saying the content is not text and giving the byte count and hash so the caller still learns what is there; kind `publication` is allowed here (the read returns bytes as text only if they decode, so a `.docx` answers the not-text error with its size and hash).

`src/tools/assessment/read-artifact.ts`: input `{ profileId, assessmentId, kind }`; resolves, finds the record (not found: `isError`), computes `workspacePaths`, `readDriveItem` (not found: `isError`), `downloadDriveItem`, `new TextDecoder("utf-8", { fatal: true }).decode(bytes)` in a try (failure: `isError` with size and hash). Output: `assessmentId`, `kind`, `path`, `content`, `bytes`, `sha256`, `eTag` optional, `graphRequests`. Kind `read`.

`verify-publication.test.ts`: present case asserts `present === true`, `expectedName === "Acme Corp_ASM-2026-00002_Risk_Assessment.docx"`, `name`, `size`, `eTag`, `lastModifiedDateTime`, `webUrl` copied from the item; absent case asserts `present === false`, `isError` undefined, and the text says the publication is not at the path; a folder at the path asserts `present === false` and the text says a folder, not a file, is there.

`src/tools/assessment/verify-publication.ts`: input `{ profileId, assessmentId }`; output `present: boolean`, `path`, `expectedName`, `name`, `size`, `eTag`, `lastModifiedDateTime`, `webUrl` (all but the first three optional), `graphRequests`. Kind `read`, description says it reads the canonical path the profile's `publication` template renders and reports what is there.

- [ ] **Step 5: Register and update the registry tests**

Register the three in `src/modules/assessment/index.ts`; add the three names to `EXPECTED_TOOL_NAMES`, to the assessment module assertion in `modules.test.ts`, and to `ACCEPTS_ASSESSMENT` in `profile-kinds.test.ts`.

- [ ] **Step 6: Run everything**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/assessment src/tools/definitions src/modules/assessment/index.ts tests/tools
git commit -m "feat(assessment): save, read and verify artifacts with read-before-overwrite and read-back"
```

---

## Task 7: `record_findings` and `transition_assessment`

**Files:**
- Create: `src/tools/assessment/record-findings.ts`, `transition.ts`
- Create: `src/tools/definitions/record-findings.ts`, `transition-assessment.ts`
- Modify: `src/modules/assessment/index.ts`, `tests/tools/contract.test.ts`, `tests/tools/modules.test.ts`, `tests/tools/profile-kinds.test.ts`
- Create: `tests/tools/assessment/record-findings.test.ts`, `record-findings.errors.test.ts`, `transition.test.ts`, `transition.errors.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 6.
- Produces: the last two tools; the module is complete.

- [ ] **Step 1: Write the failing tests for `record_findings`**

`record-findings.test.ts`, prefix as in Task 6 with the dossier present:

- **Creates findings and the summary.** Findings query (`pathIncludes: "/lists/Findings/items"`, filter contains `AssessmentId eq 'ASM-2026-00002'`) empty; two `post` calls answer items `11` and `12`; a `patch` on assessments item `2` with `{ Summary: "...", State: "FINDINGS" }` answers fields. Assert `created === 2`, `updated === 0`, `unchanged === 0`, each finding's `itemId`, the post bodies carry `Title: key`, `AssessmentId`, `FindingKey`, `Observation`, `Risk`, `Recommendation` under the profile's column names, the journal has two `list_item_created` and one `list_item_updated`, stage `FINDINGS`.
- **A retry updates and leaves unchanged.** Findings query returns item `11` for key `F-1` with identical values and item `12` for key `F-2` with an older observation; assert `unchanged === 1`, `updated === 1`, one `patch` to `/items/12/fields`, no `post`, journal has one `list_item_updated` for the finding and one for the summary.

`record-findings.errors.test.ts`:

- a `risk` not in `lifecycle.risks`: `isError` before any Graph request, text lists the labels and equals the tool's `inputConstraints` wording.
- duplicate keys in the input: `isError` before any Graph request.
- assessment `Completed`: refusal, stage `FINDINGS`.
- dossier absent: refusal with drive evidence naming the dossier path.
- two existing findings share a key: `isError` naming the key and the count; nothing written.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools/assessment/record-findings.test.ts tests/tools/assessment/record-findings.errors.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `record_findings`**

Input:

```ts
export const FINDING_SCHEMA = z.object({
  key: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).describe('Stable key within the assessment, for example "F-1" or "access-control". A retry with the same key updates rather than duplicates.'),
  observation: z.string().min(1).max(20000).describe('What was found, for example "SOC 2 Type II report dated 2025-03 covers only the hosting subsidiary."'),
  risk: z.string().min(1).describe('One of the profile\'s risk labels, for example "High".'),
  recommendation: z.string().min(1).max(20000).describe('What to do, for example "Request the parent company report before contract signature."'),
});
export const RECORD_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('For example "vendor-assessments".'),
  assessmentId: z.string().min(1).describe('For example "ASM-2026-00002".'),
  findings: z.array(FINDING_SCHEMA).min(1).max(100).describe("One entry per finding, for example a list of three."),
  summary: z.string().min(1).max(20000).describe('The assessment summary written to the assessment item, for example "Three findings, one high."'),
} satisfies z.ZodRawShape;
```

`inputConstraints = "Every finding's risk is one of the profile's risk labels, and no two findings share a key."` Handler: validate both before resolving (list the labels in the message); resolve; record, state, `allOf(requireRecord, requireInProgress, requireArtifact(state, "dossier"))`, refusal stage `FINDINGS`; query existing findings by assessment id; group by the `findingKey` column, refusing with `isError` on a duplicate; for each input finding, compare the four values with the existing fields and either skip (unchanged), `updateListItemFields` then journal `list_item_updated` target `${findings.name}/${id}`, or `createListItem` with `Title: key` and the five columns then journal `list_item_created`; finally update the assessment's `summary` and `state: "FINDINGS"` and journal it. Output: `assessmentId`, `created`, `updated`, `unchanged` (ints), `findings: array({ key, itemId, outcome: enum created|updated|unchanged })`, `correlationId`, `graphRequests`.

Definition kind `lifecycle`, description carries the constraint sentence verbatim and the retry behavior.

- [ ] **Step 4: Write the failing tests for `transition_assessment`**

`transition.test.ts`:

- **Completes with dossier and publication present.** State reads: dossier found, publication found as a file. `patch` on item `2` with `{ Status: "Completed", Disposition: "Approved", Risk: "Low", State: "LIFECYCLE" }` answers fields echoing them; `getListItem` read back returns them. Assert `transitioned === true`, `previousStatus === "In Progress"`, `status === "Completed"`, journal `list_item_updated` with stage `LIFECYCLE`, `etagBefore` the item's etag.
- **Provisional needs only the dossier.** Publication 404; target `provisional`; assert `transitioned === true`.
- **A repeat is reported, not repeated.** Item already `Status: "Completed"`, `Disposition: "Approved"`, `Risk: "Low"`; same target and labels; assert `transitioned === false`, no `patch`, text contains "already".

`transition.errors.test.ts`:

- disposition not in `lifecycle.dispositions`: `isError` before Graph, text lists them.
- risk not in `lifecycle.risks`: same.
- target `completed` with publication absent: refusal stage `LIFECYCLE`, evidence names the publication path.
- target `provisional` with dossier absent: refusal naming the dossier path.
- item `Completed` and target `provisional`: refusal, `expected` names in progress, `observed` names `Completed`.
- read back after the patch shows a different status: `isError`, journal still records the update.

- [ ] **Step 5: Implement `transition_assessment`**

Input `{ profileId, assessmentId, target: z.enum(["completed", "provisional"]), disposition: string, risk: string }` with `inputConstraints = "disposition is one of the profile's disposition labels and risk is one of its risk labels."`. Handler: validate labels; resolve; record and state; if `record.status` equals the target's label and `disposition` and `risk` equal: return `transitioned: false`; else `allOf(requireRecord, requireInProgress, requireArtifact(state, "dossier"), ...(target === "completed" ? [requireArtifact(state, "publication")] : []))`, refusal stage `LIFECYCLE`; `updateListItemFields` with `fieldsFor(columns, { status: label, disposition, risk, state: "LIFECYCLE" })`; `getListItem` read back and compare status, disposition and risk; journal `list_item_updated` with `etagBefore: record.etag`, `etagAfter: back.eTag`; mismatch after journaling returns `isError`. Output: `assessmentId`, `previousStatus` optional, `status`, `disposition`, `risk`, `transitioned`, `correlationId`, `graphRequests`.

- [ ] **Step 6: Register, update the registry tests, run everything**

Register both; `EXPECTED_TOOL_NAMES` now holds nineteen names; the module assertion lists all seven in module order `open_assessment, save_assessment_artifact, read_assessment_artifact, record_findings, transition_assessment, verify_publication, get_assessment`; `ACCEPTS_ASSESSMENT` holds the seven; the ceiling test (25) still passes at nineteen.

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/assessment src/tools/definitions src/modules/assessment/index.ts tests/tools
git commit -m "feat(assessment): record_findings and transition_assessment complete the seven tools"
```

---
## Task 8: Documentation, status and the spec's amendments

**Files:**
- Modify: `CLAUDE.md`, `docs/SETUP.md`, `docs/OPEN-ITEMS.md`, `README.md`, `docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md`

- [ ] **Step 1: `CLAUDE.md`**

In the Tool Set table add seven rows after `execute_custom_plan`:

```
| `open_assessment` | lifecycle | Finds or creates the vendor, creates the assessment item, renders the id from the item id, creates the workspace; returns an open one instead of a second |
| `save_assessment_artifact` | lifecycle | Creates at the profile's path or overwrites under the ETag it just read; reads back; `publication` refused |
| `read_assessment_artifact` | read | The persisted text and its hash, for the auditor |
| `record_findings` | lifecycle | One item per finding, keyed so a retry updates; writes the summary |
| `transition_assessment` | lifecycle | Completed needs dossier and publication present; provisional needs the dossier |
| `verify_publication` | read | What is at the publication's canonical path |
| `get_assessment` | read | Status, artifact presence and the journal summary, by id or by vendor |
```

Change "A profile is `compliance` (the default...) or `library` (site and library only)" to name the third kind, `assessment` (a site, a library, a workspace, three lists and the lifecycle labels), and add that the four tools which accept a library profile accept an assessment profile too. Change the paragraph "There are three kinds, not two" so its last sentence reads that the fourth kind, `lifecycle`, shipped with the assessment module on the date of this task's commit and its seven tools are in the table above. Nothing else in `CLAUDE.md` changes; status stays out of it.

- [ ] **Step 2: `docs/SETUP.md`**

Add a section "Assessment profiles and their lists" after "Running the normal setup" covering: the three lists the module expects (vendors, assessments, findings) and the logical fields each column map names, with the note that `Title` on each list is fixed by SharePoint and the module writes the vendor's display name there on vendors and assessments and the finding key on findings; that the module filters on the assessment id, vendor folder, scope and status columns of the assessments list, the assessment id column of the findings list and `Title` of the vendors list, and that each of those should be indexed in the list settings because the module sends `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly` and SharePoint may refuse such a query once the list passes its view threshold (measured 2026-11-07); that lifecycle tools are absent from the registry unless `IW_ALLOW_WRITES=true`, and that the grant must hold `write` for them, widened with `npm run probe:assessment:grant -- --roles=write`; the 4 MiB cap on saved content; and that provisioning the lists from the profile is not built, so an operator creates them by hand or with the probe seed as a pattern.

- [ ] **Step 3: `docs/OPEN-ITEMS.md`**

- The 9c row becomes: `Built against fakes and the 9a recordings, merged <date>; live sitting pending (Task 9 of the 9c plan)` with the PR number once known.
- Under "Carried into later phases" add three items with dates: the journal's `versionId` waits on a `/versions` probe; list provisioning from the profile; the OData filter encoding ruling (7) and that the first live filtered query of the sitting is its check.

- [ ] **Step 4: `README.md`**

Run `grep -n "twelve\|12 tools\|three kinds\|two kinds" README.md` and update any count or kind list the grep finds. If it finds nothing, the README needs no change and this step records that.

- [ ] **Step 5: The spec's amendments**

Append "## Amendments, <date>, during plan 9c" to the spec recording rulings 1 to 7 from this plan's Global Constraints in prose, plus: journal entries written before an assessment id exists are keyed `(vendor)` and `(unassigned)`; `putBytes` is the client's second mutating verb beside `patch` and the third that can change the tenant beside `post`; the module resolves the site and drive on every call, two reads, rather than caching, because nothing in the server caches a drive id across calls today and a stale one would be the ID navigation failure the project exists to avoid.

- [ ] **Step 6: Hygiene and commit**

Run: `npm test -- tests/source-hygiene.test.ts tests/build` then `npm test`.
Expected: PASS.

```bash
git add CLAUDE.md docs/SETUP.md docs/OPEN-ITEMS.md README.md docs/superpowers/specs/2026-11-06-domain-platform-and-assessment-domain-design.md
git commit -m "docs(9c): the seven assessment tools, the lists an operator prepares, and the plan's rulings"
```

---

## Task 9: The live sitting (operator, not for a subagent)

This task runs in the operator's own window on the Ironwright developer tenant with credentials that never enter a session. A subagent dispatched from the plan skips it and reports it as owed. It flips the 9c status row and is the only thing that does.

- [ ] **Step 1: Profile.** Write `profiles/assessment-sitting.json` (the `profiles/` directory is git-ignored; confirm with `git check-ignore profiles/assessment-sitting.json`) from the example with: site `https://helloironwright.sharepoint.com/sites/IronwrightTest`, library `Documents`, list names `IW Probe Vendors`, `IW Probe Assessments`, `IW Probe Findings` (the 9a seed's columns match the example's column names, and the seed's vendors list has `FolderName`), root `IW-Assessments/{vendorFolder}/{assessmentId}`, the example's subfolders, artifacts and lifecycle labels.
- [ ] **Step 2: Grant and environment.** `npm run probe:assessment:grant -- --roles=write` with the `IW_BOOTSTRAP_*` and `IW_*` variables of the 9a sitting. Then in the same window `$env:IW_ALLOW_WRITES = "true"`, `$env:IW_INBOUND_AUTH = "none"`, `$env:IW_ALLOW_ANONYMOUS = "1"`, `$env:IW_PROFILE_DIR = "profiles"`, and `npm run dev`. The listening line must say writes enabled, one profile, inbound auth none on `127.0.0.1`.
- [ ] **Step 3: Calls.** In a second window, through the MCP Inspector CLI against `http://127.0.0.1:3000/mcp` with `--transport http`, in this order, each lifecycle call made twice and the second expected to report rather than repeat: `tools/list` (nineteen tools); `open_assessment` for vendor `Sitting Vendor`, scope `Security`; `save_assessment_artifact` kind `dossier` with a few lines of text; `read_assessment_artifact` kind `dossier`; `save_assessment_artifact` kind `dossier` again with changed text (expect `overwritten`, stage `CORRECTION`); `record_findings` with two findings, one observation and the summary each spanning several lines with a blank line inside; `verify_publication` (expect `present: false`); `transition_assessment` to `completed` (expect a refusal naming the publication path); upload any `.docx` by hand at the path `verify_publication` reported, with the exact expected name; `verify_publication` (expect `present: true`); `transition_assessment` to `completed`, disposition `Approved`, risk `Low` (expect `transitioned: true`), then again (expect `transitioned: false`); `get_assessment` by id (artifacts and the journal summary) and by vendor.
- [ ] **Step 4: Evidence.** Save the Inspector output of every call to `.superpowers/live-sitting/2026-11-xx-assessment/` (git-ignored). Note the Graph request count each call reported. Note whether the first filtered query answered 200 (ruling 7's check). Note whether the multi-line observation and summary read back equal to what was sent (the multi-line check). Two further checks. The case check, made in Step 3 just before the publication is uploaded with its exact expected name: upload the `.docx` first under that name with its case changed, call `verify_publication` and `get_assessment` by id, note whether the path lookup answered the file and what each tool reported for the publication, then delete that file by hand and continue. The implicit parent check, made in Step 3 right after the second dossier save, while the assessment is still in progress and `Published` is still empty: delete the `Published` subfolder by hand, call `save_assessment_artifact` kind `executive_summary`, and note whether the save answered success and whether `Published` exists again; a save checks only the root, so a folder the PUT created implicitly would have no journal entry. Recreate `Published` by hand if it is still absent before continuing.
- [ ] **Step 5: Restore and record.** `npm run probe:assessment:grant -- --roles=read`. Stop the server with Ctrl+C in its own window. Write the sitting into `docs/OPEN-ITEMS.md` in the style of the 9a sitting, flip the 9c row to `Complete, verified live <date>`, note the residue left in the tenant, and commit with the status change in the same commit.

---

## Self-review against the spec

**Spec coverage.** Profile (one site, workspace, artifacts, assessmentId, lists with column maps, lifecycle labels): Task 3. Seven tools with their stages: Tasks 5 to 7. Lifecycle preconditions read live from lists and drive, structured refusals with evidence: Task 4 and `refusal.ts`. Retry rule, including open returning the in progress assessment and a findings retry updating: Tasks 5 and 7. ID rendered from the item id and written back before any folder exists: Task 5. Four Graph operations with the 9a amendments (read before overwrite, body ETags, 412 on status, the non indexed header): Tasks 1 and 2. Journal appended after each write, with prior ETag and hash on overwrite; `versionId` held under ruling 3: Tasks 4 to 7. Read back after every write: Tasks 5 to 7. Contract test gains the seven names; profile kinds test gains the kind; registry test proves the union: Tasks 3, 5, 6, 7. Live sitting: Task 9. Out of scope items stay out: no delete, no upload session, no rollback, no list provisioning, no multi site.

**Placeholder scan.** Every code step carries its code or names the exact function, path, body and expected values. Task 8 Step 4 is conditional by design and says so.

**Type consistency.** `AssessmentContext` (profile, siteId, driveId, correlationId, now) is used identically in Tasks 5 to 7. `AssessmentRecord` fields are the same in Task 4 and the handlers. `Precondition` is the union Task 4 defines and `refusalResult` consumes. `putBytes(pathOrUrl, body, contentType, headers?)` is the one signature in Tasks 1, 5 and 6. `fieldsFor(columns, values)` is used with the same key names throughout. `workspacePaths(ac, { vendorTitle, vendorFolder, assessmentId })` in Task 5 is what `readAssessmentState` and the Task 6 handlers call.
