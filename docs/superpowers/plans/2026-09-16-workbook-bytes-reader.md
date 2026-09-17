# Workbook Bytes Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unreachable Graph Excel API with a reader that downloads the `.xlsx` through `/content` and parses the bytes in process, so the reconciliation engine gets its second input back.

**Architecture:** `src/scan/workbook.ts` composes four steps: resolve the drive, download the bytes, parse them to a grid, run the existing pure `readWorkbookGrid`. The download lives in `src/graph/content.ts` and goes through `GraphClient` so retry and request counting still apply. The parser lives in `src/workbook/xlsx.ts`, is pure, and is covered by the existing lint purity fence over `src/workbook/`.

**Tech Stack:** TypeScript, Node, vitest, `fflate` for the zip. No XML parser dependency.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-16-workbook-bytes-reader-design.md`. It is binding.
- No emojis or icons anywhere, including logs, comments and docs. US English throughout.
- No dash characters in tracked prose. A repo test enforces this over `.ts`, `.js`, `.json`, `.md` and `.yml`. Use commas or restructure the sentence.
- Comments explain why, not what.
- A function that cannot observe an outcome must not assert it. No message may name a cause the code did not positively establish.
- `src/domain/` and `src/workbook/` are pure. No I/O, enforced by lint.
- Every new module gets both a `.test.ts` and an `.errors.test.ts`, matching the existing convention in `tests/graph/` and `tests/workbook/`.
- Conventional commits. Commit at the end of every task.
- Run `npm run lint && npm run typecheck && npm test` before every commit.
- `fflate` is the only dependency this plan adds. Do not add any other.

---

### Task 1: `getBytes` on the Graph client and `downloadDriveItem`

**Files:**
- Modify: `src/graph/client.ts` (the `GraphClient` interface and `createGraphClient`)
- Create: `src/graph/content.ts`
- Test: `tests/graph/content.test.ts`, `tests/graph/content.errors.test.ts`, and add cases to `tests/graph/client.test.ts`

**Interfaces:**
- Consumes: `createGraphClient`, `GraphRequestError`, `driveItemPath` from `src/graph/paths.js`.
- Produces: `GraphClient.getBytes(pathOrUrl: string): Promise<Uint8Array>` and `downloadDriveItem(client: GraphClient, args: { driveId: string; workbookPath: string }): Promise<Uint8Array>`.

`getBytes` must count its requests through the same counter `get` and `post` use, and must apply the same `Retry-After` policy, because the scan reports that count and phase 2a's verified claim rests on it.

`GET .../content` answers 302 to a pre-authenticated storage URL. Follow it with `redirect: "manual"` and re-issue without the `Authorization` header. Node strips it on a cross-origin redirect anyway; doing it deliberately is the point, because the cost of being wrong is a bearer token delivered to a storage host.

Cap: `MAX_WORKBOOK_DOWNLOAD_BYTES = 50 * 1024 * 1024`. Check `Content-Length` before reading the body, and check the received length again after, because a missing or untruthful header must not be the only guard.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/graph/content.test.ts
import { describe, expect, it } from "vitest";
import { createGraphClient } from "../../src/graph/client.js";
import { downloadDriveItem } from "../../src/graph/content.js";

const tokenProvider = { getToken: async (): Promise<string> => "test-token" };

describe("downloadDriveItem", () => {
  it("follows the content redirect and drops the bearer token on the second request", async () => {
    const seen: Array<{ url: string; authorization: string | undefined }> = [];
    const client = createGraphClient({
      tokenProvider,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        seen.push({ url, authorization: headers.get("authorization") ?? undefined });
        if (url.includes("graph.microsoft.com")) {
          return new Response(null, { status: 302, headers: { location: "https://storage.example/blob" } });
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }) as typeof fetch,
    });

    const bytes = await downloadDriveItem(client, { driveId: "d1", workbookPath: "/Trackers/Book.xlsx" });

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.authorization).toBe("Bearer test-token");
    // The whole reason this function follows the redirect itself.
    expect(seen[1]?.authorization).toBeUndefined();
    expect(client.requests()).toBe(2);
  });
});
```

```typescript
// tests/graph/content.errors.test.ts
import { describe, expect, it } from "vitest";
import { createGraphClient } from "../../src/graph/client.js";
import { downloadDriveItem, MAX_WORKBOOK_DOWNLOAD_BYTES } from "../../src/graph/content.js";

const tokenProvider = { getToken: async (): Promise<string> => "test-token" };

function clientReturning(response: () => Response): ReturnType<typeof createGraphClient> {
  return createGraphClient({ tokenProvider, fetchImpl: (async () => response()) as typeof fetch });
}

describe("downloadDriveItem failures", () => {
  it("refuses a body whose Content-Length exceeds the cap, before reading it", async () => {
    const client = clientReturning(
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-length": String(MAX_WORKBOOK_DOWNLOAD_BYTES + 1) },
        }),
    );

    await expect(downloadDriveItem(client, { driveId: "d1", workbookPath: "/Book.xlsx" })).rejects.toThrow(
      /larger than the 50 MB this server will download/,
    );
  });

  it("refuses a body that exceeds the cap despite an absent Content-Length", async () => {
    const client = clientReturning(
      () => new Response(new Uint8Array(MAX_WORKBOOK_DOWNLOAD_BYTES + 1), { status: 200 }),
    );

    await expect(downloadDriveItem(client, { driveId: "d1", workbookPath: "/Book.xlsx" })).rejects.toThrow(
      /larger than the 50 MB this server will download/,
    );
  });

  it("refuses a redirect that names no location", async () => {
    const client = clientReturning(() => new Response(null, { status: 302 }));

    await expect(downloadDriveItem(client, { driveId: "d1", workbookPath: "/Book.xlsx" })).rejects.toThrow(
      /answered 302 with no location header/,
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/graph/content.test.ts tests/graph/content.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/graph/content.js`.

- [ ] **Step 3: Add `getBytes` to the client**

In `src/graph/client.ts`, add to the `GraphClient` interface, next to `get` and `post`:

```typescript
  /**
   * Bytes rather than JSON, for driveItem content. It goes through this client
   * rather than a bare fetch so the request counter and the Retry-After policy
   * still apply: the scan reports that count, and a download that bypassed it
   * would make the reported number wrong.
   */
  getBytes(pathOrUrl: string): Promise<Uint8Array>;
```

Add a sibling of `send` that returns bytes rather than text, and a `getBytes` implementation on the returned object. Do not reuse `request`, which parses JSON.

```typescript
  async function sendForBytes(url: string, withAuth: boolean): Promise<Response> {
    requests += 1;
    // accept is not set to application/json here: this request wants the file.
    const headers: Record<string, string> = withAuth
      ? { authorization: `Bearer ${await options.tokenProvider.getToken()}` }
      : {};
    return fetchImpl(url, { method: "GET", headers, redirect: "manual" });
  }
```

and on the returned object:

```typescript
    async getBytes(pathOrUrl: string): Promise<Uint8Array> {
      const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
      const label = url.startsWith(GRAPH_BASE) ? url.slice(GRAPH_BASE.length) : url;

      const first = await withRetry(
        retry,
        () => sendForBytes(url, true),
        (value) => ({ retriable: isRetriableStatus(value.status), retryAfter: value.headers.get("retry-after") }),
        isRetriableTransportError,
      );

      let response = first;
      if (first.status >= 300 && first.status < 400) {
        const location = first.headers.get("location");
        if (location === null || location.length === 0) {
          throw new Error(
            `Graph GET ${label} answered ${String(first.status)} with no location header, so there is nowhere to ` +
              "follow. A redirect without a target is a malformed response rather than a missing file.",
          );
        }
        // Deliberately without the bearer token. The redirect target is a
        // pre-authenticated storage URL that needs no credential, and sending
        // one would deliver a Graph bearer token to a host that is not Graph.
        response = await withRetry(
          retry,
          () => sendForBytes(location, false),
          (value) => ({ retriable: isRetriableStatus(value.status), retryAfter: value.headers.get("retry-after") }),
          isRetriableTransportError,
        );
      }

      if (response.status < 200 || response.status >= 300) {
        throw new GraphRequestError({
          method: "GET",
          path: label,
          status: response.status,
          body: await response.text(),
        });
      }

      return new Uint8Array(await response.arrayBuffer());
    },
```

- [ ] **Step 4: Write `src/graph/content.ts`**

```typescript
import type { GraphClient } from "./client.js";
import { driveItemPath } from "./paths.js";

/**
 * A workbook larger than this is refused rather than downloaded. The number is
 * a constant rather than profile configuration because no real customer
 * workbook has ever been seen by this project, so a knob would be a guess at a
 * shape nobody has observed. A tracking workbook that genuinely exceeds this is
 * a reason to revisit the design, not to raise a limit quietly.
 */
export const MAX_WORKBOOK_DOWNLOAD_BYTES = 50 * 1024 * 1024;

function tooLarge(workbookPath: string, bytes: number): Error {
  return new Error(
    `${workbookPath} is ${String(bytes)} bytes, which is larger than the 50 MB this server will download. ` +
      "The workbook is read in full because the Graph Excel API cannot be reached by an app-only token, so " +
      "there is no way to read one range of a file this size.",
  );
}

/**
 * Downloads a driveItem's content. This exists because the Graph Excel API
 * refuses app-only tokens, so the workbook is read as a file rather than as a
 * workbook. See the 2026-09-16 spec.
 */
export async function downloadDriveItem(
  client: GraphClient,
  args: { driveId: string; workbookPath: string },
): Promise<Uint8Array> {
  const bytes = await client.getBytes(`${driveItemPath(args.driveId, args.workbookPath)}/content`);
  if (bytes.length > MAX_WORKBOOK_DOWNLOAD_BYTES) throw tooLarge(args.workbookPath, bytes.length);
  return bytes;
}
```

The `Content-Length` check belongs in `getBytes`, before `arrayBuffer()` is read. Add it there:

```typescript
      const declared = response.headers.get("content-length");
      if (declared !== null && Number(declared) > MAX_WORKBOOK_DOWNLOAD_BYTES) {
        throw tooLargeForLabel(label, Number(declared));
      }
```

Export a shared message builder so both checks produce the same sentence. The post-read check in `downloadDriveItem` is not redundant: a response with no `Content-Length`, or a lying one, reaches it.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/graph/content.test.ts tests/graph/content.errors.test.ts tests/graph/client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/graph/client.ts src/graph/content.ts tests/graph/content.test.ts tests/graph/content.errors.test.ts tests/graph/client.test.ts
git commit -m "feat(graph): download driveItem content as bytes through the client"
```

---

### Task 2: The zip layer

**Files:**
- Create: `src/workbook/zip.ts`
- Test: `tests/workbook/zip.test.ts`, `tests/workbook/zip.errors.test.ts`

**Interfaces:**
- Consumes: `fflate`.
- Produces: `readZipParts(bytes: Uint8Array, wanted: (name: string) => boolean): Map<string, string>`, returning part name to UTF-8 text, and `MAX_INFLATED_BYTES`.

Refuse by inspection, not by running out of memory. `fflate`'s `unzip` inflates everything, so use `unzipSync` with a filter, and check the declared uncompressed sizes first via `fflate.unzipSync`'s filter callback, which receives each file's `originalSize` before inflation.

- [ ] **Step 1: Install fflate**

```bash
npm install fflate@^0.8.2
```

- [ ] **Step 2: Write the failing tests**

```typescript
// tests/workbook/zip.test.ts
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { readZipParts } from "../../src/workbook/zip.js";

describe("readZipParts", () => {
  it("returns only the parts the filter wants, as text", () => {
    const bytes = zipSync({
      "xl/workbook.xml": strToU8("<workbook/>"),
      "xl/sharedStrings.xml": strToU8("<sst/>"),
      "docProps/app.xml": strToU8("<Properties/>"),
    });

    const parts = readZipParts(bytes, (name) => name.startsWith("xl/"));

    expect([...parts.keys()].sort()).toEqual(["xl/sharedStrings.xml", "xl/workbook.xml"]);
    expect(parts.get("xl/workbook.xml")).toBe("<workbook/>");
  });
});
```

```typescript
// tests/workbook/zip.errors.test.ts
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { readZipParts, MAX_INFLATED_BYTES } from "../../src/workbook/zip.js";

describe("readZipParts failures", () => {
  it("refuses bytes that are not a zip", () => {
    expect(() => readZipParts(new Uint8Array([1, 2, 3, 4]), () => true)).toThrow(
      /is not a zip archive, so it is not an xlsx workbook/,
    );
  });

  it("refuses an archive whose declared inflated size exceeds the cap", () => {
    // A real zip bomb is not needed and would be slow. The cap is enforced
    // against the declared size, so a stub that declares too much is the
    // honest test of the guard that actually runs.
    const bytes = zipSync({ "xl/workbook.xml": strToU8("<workbook/>") });
    expect(() => readZipParts(bytes, () => true, { maxInflatedBytes: 4 })).toThrow(
      /declares .* bytes of uncompressed content/,
    );
    expect(MAX_INFLATED_BYTES).toBe(200 * 1024 * 1024);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/workbook/zip.test.ts tests/workbook/zip.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/workbook/zip.js`.

- [ ] **Step 4: Implement `src/workbook/zip.ts`**

```typescript
import { unzipSync, strFromU8 } from "fflate";

/**
 * Refused by inspection rather than discovered by exhausting memory. A zip
 * states each entry's uncompressed size in its own directory, so a hostile
 * archive can be turned away before a single byte is inflated. This is the
 * difference between a rejection and an out-of-memory kill of the server.
 */
export const MAX_INFLATED_BYTES = 200 * 1024 * 1024;

export function readZipParts(
  bytes: Uint8Array,
  wanted: (name: string) => boolean,
  options?: { maxInflatedBytes?: number },
): Map<string, string> {
  const cap = options?.maxInflatedBytes ?? MAX_INFLATED_BYTES;
  let declared = 0;

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        declared += file.originalSize ?? 0;
        if (declared > cap) {
          throw new Error(
            `The workbook declares ${String(declared)} bytes of uncompressed content, past the ` +
              `${String(cap)} byte limit this server will inflate.`,
          );
        }
        return wanted(file.name);
      },
    });
  } catch (error) {
    // fflate throws its own error for malformed input. The filter's own throw
    // is re-raised unchanged, because it already says what an operator needs
    // and rewording it here would replace a true statement with a guess about
    // which of the two causes applied.
    if (error instanceof Error && error.message.includes("uncompressed content")) throw error;
    throw new Error(
      "The downloaded file is not a zip archive, so it is not an xlsx workbook. The profile's workbookPath " +
        "may name a file that is not a workbook, or the download was truncated.",
      { cause: error },
    );
  }

  const parts = new Map<string, string>();
  for (const [name, content] of Object.entries(files)) parts.set(name, strFromU8(content));
  return parts;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/workbook/zip.test.ts tests/workbook/zip.errors.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/workbook/zip.ts tests/workbook/zip.test.ts tests/workbook/zip.errors.test.ts
git commit -m "feat(workbook): read xlsx zip parts with a declared-size cap"
```

---

### Task 3: Cell decoding and the rejection signals

**Files:**
- Create: `src/workbook/cells.ts`
- Test: `tests/workbook/cells.test.ts`, `tests/workbook/cells.errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `UNEVALUABLE`, a unique symbol, and `decodeCell(cellXml: string, sharedStrings: string[]): string | number | boolean | null | typeof UNEVALUABLE`, plus `parseSharedStrings(xml: string): string[]`.

This is the heart of the phase. `UNEVALUABLE` is a symbol rather than `null` or `undefined` so that a caller cannot mistake it for an empty cell, which is exactly the substitution the spec forbids.

The rules, from the spec:
- `<c><f>...</f></c>` with no `<v>`: `UNEVALUABLE`.
- `t="e"`: `UNEVALUABLE`.
- `t="s"`: shared string by index.
- `t="inlineStr"`: the `<is><t>` text.
- `t="b"`: `"1"` is `true`, `"0"` is `false`.
- `t="str"` or absent: text or number as written.
- No `<v>` and no `<f>`: `null`, an ordinary empty cell.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/workbook/cells.test.ts
import { describe, expect, it } from "vitest";
import { decodeCell, parseSharedStrings, UNEVALUABLE } from "../../src/workbook/cells.js";

const shared = ["Client", "CLIENTA"];

describe("decodeCell", () => {
  it("reads a shared string by index", () => {
    expect(decodeCell('<c r="A1" t="s"><v>1</v></c>', shared)).toBe("CLIENTA");
  });

  it("reads an inline string", () => {
    expect(decodeCell('<c r="A1" t="inlineStr"><is><t>CLIENTB</t></is></c>', shared)).toBe("CLIENTB");
  });

  it("reads a boolean", () => {
    expect(decodeCell('<c r="A1" t="b"><v>1</v></c>', shared)).toBe(true);
    expect(decodeCell('<c r="A1" t="b"><v>0</v></c>', shared)).toBe(false);
  });

  it("reads a number, including a date serial, without interpreting it", () => {
    // The reader decides dates by column role, so this layer must not guess.
    expect(decodeCell('<c r="A1"><v>45292</v></c>', shared)).toBe(45292);
  });

  it("trusts a formula that carries a cached value", () => {
    expect(decodeCell('<c r="A1"><f>SUM(B1:B2)</f><v>7</v></c>', shared)).toBe(7);
  });

  it("reads an empty cell as null", () => {
    expect(decodeCell('<c r="A1"/>', shared)).toBeNull();
  });
});

describe("parseSharedStrings", () => {
  it("reads each si in order, joining rich text runs", () => {
    const xml = "<sst><si><t>One</t></si><si><r><t>Two</t></r><r><t>Part</t></r></si></sst>";
    expect(parseSharedStrings(xml)).toEqual(["One", "TwoPart"]);
  });
});
```

```typescript
// tests/workbook/cells.errors.test.ts
import { describe, expect, it } from "vitest";
import { decodeCell, UNEVALUABLE } from "../../src/workbook/cells.js";

describe("cells that cannot be read", () => {
  it("refuses a formula with no cached value", () => {
    // Excel never wrote a result, so there is nothing to read. Returning an
    // empty string here is the silent wrong answer the whole phase exists to
    // prevent.
    expect(decodeCell('<c r="A1"><f>VLOOKUP(A2,Z:Z,1,0)</f></c>', [])).toBe(UNEVALUABLE);
  });

  it("refuses an error cell", () => {
    expect(decodeCell('<c r="A1" t="e"><v>#N/A</v></c>', [])).toBe(UNEVALUABLE);
    expect(decodeCell('<c r="A1" t="e"><v>#REF!</v></c>', [])).toBe(UNEVALUABLE);
  });

  it("refuses a shared string index that names no entry", () => {
    expect(decodeCell('<c r="A1" t="s"><v>9</v></c>', ["only"])).toBe(UNEVALUABLE);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/workbook/cells.test.ts tests/workbook/cells.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/workbook/cells.js`.

- [ ] **Step 3: Implement `src/workbook/cells.ts`**

XML is read for a small fixed set of elements with regular expressions rather than a parser dependency. Unescape only the five predefined entities and numeric character references. Any other entity reference is refused, because resolving a declared entity is how an OOXML parser becomes an XXE vector, and this server holds SharePoint credentials.

```typescript
/**
 * A cell whose value cannot be read with confidence. A symbol rather than null
 * or undefined so a caller cannot mistake it for an empty cell: substituting a
 * value for an unevaluable one produces a wrong compliance finding and raises
 * nothing, which this project holds to be its most expensive failure.
 */
export const UNEVALUABLE = Symbol("unevaluable");

export type CellValue = string | number | boolean | null | typeof UNEVALUABLE;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * The five predefined entities and numeric references, and nothing else. A
 * general parser resolves whatever entity a document declares, which is how
 * reading OOXML becomes an XXE vector; this server holds SharePoint
 * credentials, so an unknown entity is refused rather than resolved.
 */
export function unescapeXmlText(text: string): string {
  return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    const named = NAMED_ENTITIES[body];
    if (named !== undefined) return named;
    throw new Error(
      `The workbook XML references the entity "${match}", which is not one of the five XML predefines. ` +
        "Entities are not resolved here, so a document that declares its own is refused rather than expanded.",
    );
  });
}

/** Every <t> inside one <si>, concatenated, which is how a rich text run reads as one string. */
export function parseSharedStrings(xml: string): string[] {
  const items: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = "";
    for (const t of (si[1] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXmlText(t[1] ?? "");
    items.push(text);
  }
  return items;
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

export function decodeCell(cellXml: string, sharedStrings: string[]): CellValue {
  const openTag = /^<c[^>]*>/.exec(cellXml)?.[0] ?? cellXml;
  const type = attribute(openTag, "t");
  const hasFormula = /<f[\s>/]/.test(cellXml);
  const rawValue = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1];

  // An error cell holds a cached value that is not a value. #N/A in a lookup
  // column is ordinary, and substituting an empty string there would report a
  // client as owing nothing, which reads as compliance.
  if (type === "e") return UNEVALUABLE;

  if (type === "inlineStr") {
    const inline = /<is>([\s\S]*?)<\/is>/.exec(cellXml)?.[1];
    if (inline === undefined) return UNEVALUABLE;
    let text = "";
    for (const t of inline.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXmlText(t[1] ?? "");
    return text;
  }

  if (rawValue === undefined) {
    // A formula with no cached value means Excel never wrote a result, so
    // there is nothing to read. An empty cell with no formula is just empty.
    return hasFormula ? UNEVALUABLE : null;
  }

  if (type === "s") {
    const text = sharedStrings[Number(rawValue)];
    // An index naming no entry is a malformed file rather than an empty cell,
    // and guessing at empty would put a blank client name into the report.
    return text ?? UNEVALUABLE;
  }

  if (type === "b") return rawValue === "1";
  if (type === "str") return unescapeXmlText(rawValue);

  const numeric = Number(rawValue);
  return Number.isNaN(numeric) ? unescapeXmlText(rawValue) : numeric;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/workbook/cells.test.ts tests/workbook/cells.errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workbook/cells.ts tests/workbook/cells.test.ts tests/workbook/cells.errors.test.ts
git commit -m "feat(workbook): decode xlsx cells and refuse the ones that cannot be read"
```

---

### Task 4: Worksheet to grid

**Files:**
- Create: `src/workbook/sheet.ts`
- Test: `tests/workbook/sheet.test.ts`, `tests/workbook/sheet.errors.test.ts`

**Interfaces:**
- Consumes: `decodeCell`, `UNEVALUABLE`, `CellValue` from `src/workbook/cells.js`.
- Produces: `sheetToGrid(sheetXml: string, sharedStrings: string[], bounds?: SheetBounds): { grid: CellValue[][]; firstRow: number; hadFormula: boolean }`, `columnLabelToIndex(label: string): number`, and `interface SheetBounds { firstRow: number; lastRow: number; firstColumn: number; lastColumn: number }`.

`hadFormula` reports whether any cell inside the returned range carried an `<f>` element. Task 5 needs it to decide the `fullCalcOnLoad` case, and computing it here avoids walking the XML a second time. `firstRow` is the sheet row of the grid's first row, which becomes Task 5's `rowOffset`.

Grid shape is driven by the cells the part actually contains, not by the declared `<dimension>`. Absent cells are `null`. When `bounds` is given, only cells inside it are kept and the grid is offset to the bounds origin, which is how a table's own range is extracted.

Caps: `MAX_GRID_ROWS = 1_048_576` and `MAX_GRID_COLUMNS = 16_384`, Excel's own sheet maximum. A cell reference past either is malformed rather than large, and is refused.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/workbook/sheet.test.ts
import { describe, expect, it } from "vitest";
import { columnLabelToIndex, sheetToGrid } from "../../src/workbook/sheet.js";

const SHEET = `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>CLIENTA</t></is></c><c r="B2"><v>1</v></c></row>
</sheetData></worksheet>`;

describe("sheetToGrid", () => {
  it("builds a grid from the cells present, filling gaps with null", () => {
    const result = sheetToGrid(SHEET, ["Client", "Monthly"]);
    expect(result.grid).toEqual([
      ["Client", "Monthly"],
      ["CLIENTA", 1],
    ]);
    expect(result.firstRow).toBe(1);
    expect(result.hadFormula).toBe(false);
  });

  it("extracts a bounded range and offsets it to the bounds origin", () => {
    const sheet = `<worksheet><sheetData>
<row r="11"><c r="A11" t="inlineStr"><is><t>ignored</t></is></c></row>
<row r="12"><c r="B12" t="inlineStr"><is><t>Client</t></is></c></row>
<row r="13"><c r="B13" t="inlineStr"><is><t>CLIENTA</t></is></c></row>
</sheetData></worksheet>`;

    const result = sheetToGrid(sheet, [], { firstRow: 12, lastRow: 13, firstColumn: 2, lastColumn: 2 });

    expect(result.grid).toEqual([["Client"], ["CLIENTA"]]);
    expect(result.firstRow).toBe(12);
  });

  it("reports a formula inside the range, and ignores one outside it", () => {
    const sheet = `<worksheet><sheetData>
<row r="1"><c r="A1"><f>NOW()</f><v>1</v></c></row>
<row r="2"><c r="B2" t="inlineStr"><is><t>Client</t></is></c></row>
</sheetData></worksheet>`;

    expect(sheetToGrid(sheet, []).hadFormula).toBe(true);
    expect(sheetToGrid(sheet, [], { firstRow: 2, lastRow: 2, firstColumn: 2, lastColumn: 2 }).hadFormula).toBe(false);
  });
});

describe("columnLabelToIndex", () => {
  it("reads single and multi letter labels", () => {
    expect(columnLabelToIndex("A")).toBe(1);
    expect(columnLabelToIndex("Z")).toBe(26);
    expect(columnLabelToIndex("AA")).toBe(27);
  });
});
```

```typescript
// tests/workbook/sheet.errors.test.ts
import { describe, expect, it } from "vitest";
import { sheetToGrid } from "../../src/workbook/sheet.js";

describe("sheet bounds", () => {
  it("refuses a cell reference past Excel's own sheet maximum", () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="XFE1"><v>1</v></c></row></sheetData></worksheet>';
    expect(() => sheetToGrid(sheet, [])).toThrow(/past the 16384 columns a worksheet can have/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/workbook/sheet.test.ts tests/workbook/sheet.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/workbook/sheet.js`.

- [ ] **Step 3: Implement `src/workbook/sheet.ts`**

Match `<row ...>...</row>` and within each row match `<c ...>...</c>` or the self-closing `<c .../>`. Read each cell's `r` attribute for its column label and row number rather than trusting position, because a sparse row omits its empty cells entirely.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/workbook/sheet.test.ts tests/workbook/sheet.errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workbook/sheet.ts tests/workbook/sheet.test.ts tests/workbook/sheet.errors.test.ts
git commit -m "feat(workbook): build a grid from worksheet cells"
```

---

### Task 5: `parseWorkbookGrid`, range resolution and `fullCalcOnLoad`

**Files:**
- Create: `src/workbook/xlsx.ts`
- Test: `tests/workbook/xlsx.test.ts`, `tests/workbook/xlsx.errors.test.ts`

**Interfaces:**
- Consumes: `readZipParts` from `src/workbook/zip.js`, `parseSharedStrings` and `UNEVALUABLE` from `src/workbook/cells.js`, `sheetToGrid` from `src/workbook/sheet.js`, `WorkbookSource` (move this type here from `src/graph/excel.ts` before deleting that file in Task 7).
- Produces: `parseWorkbookGrid(bytes: Uint8Array, source: WorkbookSource): { grid: CellValue[][]; rowOffset: number }` and `WorkbookSource`.

`rowOffset` is the sheet row of the grid's first row, which Task 6 uses to make rejections absolute. For a worksheet read it is the first row that carries a cell; for a table it is the table range's first row.

`fullCalcOnLoad`: if `xl/workbook.xml` carries `<calcPr ... fullCalcOnLoad="1"...>` and any cell inside the resolved range is a formula, throw `WorkbookMappingError` naming the cause. If no cell in range is a formula, ignore the flag. This needs `sheetToGrid` to report whether the range contained a formula, so extend its return with a `hadFormula` flag rather than inspecting the XML twice.

- [ ] **Step 1: Write the failing tests**

Cover: a table resolved by name at a sheet offset, a worksheet resolved by name, `fullCalcOnLoad` set with a formula in range (throws), `fullCalcOnLoad` set with no formula in range (succeeds), a table name that does not exist, a worksheet name that does not exist, and an `UNEVALUABLE` cell surviving into the grid.

```typescript
// tests/workbook/xlsx.errors.test.ts, the case that carries the decision
it("fails the whole read when fullCalcOnLoad is set and the range holds a formula", () => {
  const bytes = buildWorkbook({
    fullCalcOnLoad: true,
    sheet: '<row r="1"><c r="A1"><f>NOW()</f><v>1</v></c></row>',
  });

  expect(() => parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" })).toThrow(
    /instructs Excel to recalculate every formula when it opens/,
  );
});

it("ignores fullCalcOnLoad when no cell in the range is a formula", () => {
  const bytes = buildWorkbook({
    fullCalcOnLoad: true,
    sheet: '<row r="1"><c r="A1" t="inlineStr"><is><t>Client</t></is></c></row>',
  });

  expect(parseWorkbookGrid(bytes, { kind: "worksheet", name: "Sheet1" }).grid).toEqual([["Client"]]);
});
```

`buildWorkbook` is a local test helper in the test file that assembles the four parts with `zipSync`. It is hand-written XML, not `scripts/seed/blank-workbook.ts`, per the spec: our own writer and our own reader agreeing proves nothing about Excel.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/workbook/xlsx.test.ts tests/workbook/xlsx.errors.test.ts`
Expected: FAIL, cannot resolve `../../src/workbook/xlsx.js`.

- [ ] **Step 3: Implement `src/workbook/xlsx.ts`**

Resolve in this order: read `xl/workbook.xml` for `<sheet name= r:id= sheetId=>` entries and the `calcPr` flag; read `xl/_rels/workbook.xml.rels` to map `r:id` to a part path; for `kind: "table"` read every `xl/tables/*.xml` for `<table name= ref=>` and find the named one, then find which worksheet owns it through that sheet's rels.

The `fullCalcOnLoad` message must name what an operator can act on:

```typescript
throw new WorkbookMappingError(
  `${describeSource(source)} contains at least one formula, and the workbook is marked fullCalcOnLoad, which ` +
    "instructs Excel to recalculate every formula when it opens. The values saved in the file are therefore not " +
    "authoritative, and reading them would report compliance from numbers the workbook itself does not stand " +
    "behind. Open the workbook in Excel and save it, which writes current values, or point the mapping at a " +
    "range with no formulas.",
);
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/workbook/xlsx.test.ts tests/workbook/xlsx.errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workbook/xlsx.ts tests/workbook/xlsx.test.ts tests/workbook/xlsx.errors.test.ts
git commit -m "feat(workbook): resolve a table or worksheet range from xlsx bytes"
```

---

### Task 6: Absolute row numbers in rejections

**Files:**
- Modify: `src/workbook/read.ts` (`readWorkbookGrid` signature and the `rangeRow` computation at line 178)
- Modify: `src/domain/reconcile/types.ts:24-40` (the `RejectedWorkbookRow.row` doc comment)
- Test: `tests/workbook/read.test.ts`, `tests/workbook/read.errors.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `readWorkbookGrid(grid: unknown[][], profile: Profile, rowOffset?: number): ReadResult`. `rowOffset` defaults to 1, which reproduces today's behavior exactly, so every existing test stays valid.

An `UNEVALUABLE` cell reaching this function is rejected with its own wording. Add that case here rather than in the parser, because this is the layer that knows which columns the mapping reads: an unevaluable cell in an unmapped column is not a problem.

- [ ] **Step 1: Write the failing tests**

```typescript
it("numbers a rejected row by its sheet row when a row offset is given", () => {
  // A table starting at sheet row 12: header on 12, first data row on 13.
  const grid = [["Client"], [42]];
  const result = readWorkbookGrid(grid, profile, 12);
  expect(result.rejectedRows[0]?.row).toBe(13);
});

it("rejects a row whose mapped cell could not be read", () => {
  const grid = [["Client", "Monthly Training"], ["CLIENTA", UNEVALUABLE]];
  const result = readWorkbookGrid(grid, profile);
  expect(result.rejectedRows[0]?.reason).toMatch(/could not be read from the workbook/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/workbook/read.test.ts tests/workbook/read.errors.test.ts`
Expected: FAIL on both new cases; the existing cases still pass.

- [ ] **Step 3: Implement**

Replace `const rangeRow = index + 1;` with `const sheetRow = index + rowOffset;` and use it in every rejection. Rewrite the `RejectedWorkbookRow.row` comment: it no longer carries the caveat about needing the offset from Graph, because the offset is now known. Say what it is instead.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. If an existing test breaks, the default of 1 was not applied correctly.

- [ ] **Step 5: Commit**

```bash
git add src/workbook/read.ts src/domain/reconcile/types.ts tests/workbook/read.test.ts tests/workbook/read.errors.test.ts
git commit -m "feat(workbook): number rejected rows by their sheet row"
```

---

### Task 7: Recompose the snapshot and delete the Excel session layer

**Files:**
- Modify: `src/scan/workbook.ts`
- Delete: `src/graph/excel.ts`, `tests/graph/excel.test.ts`, `tests/graph/excel.errors.test.ts`
- Test: `tests/scan/workbook.test.ts`, `tests/scan/workbook.errors.test.ts`

**Interfaces:**
- Consumes: `downloadDriveItem`, `parseWorkbookGrid`, `readWorkbookGrid`, `resolveDrive`.
- Produces: `readWorkbookSnapshot(client, profile): Promise<WorkbookSnapshot>`, unchanged in signature and return shape.

Move `WorkbookSource` into `src/workbook/xlsx.ts` before deleting `src/graph/excel.ts`, and update the import in `src/domain/profile/schema.ts` if it references it.

The `source` string on the snapshot keeps its shape, `path#name in library`, because the engine's golden fixture uses that convention.

- [ ] **Step 1: Update the existing snapshot tests to the new composition**

The existing tests fake `readWorkbookRange`. Change them to fake `downloadDriveItem` by injecting bytes, following the injection pattern `runReconcile` already uses for `readWorkbook`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/scan/workbook.test.ts tests/scan/workbook.errors.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `readWorkbookSnapshot`**

```typescript
export async function readWorkbookSnapshot(client: GraphClient, profile: Profile): Promise<WorkbookSnapshot> {
  const { driveId } = await resolveDrive(client, profile.identity.siteUrl, profile.identity.library);

  const bytes = await downloadDriveItem(client, { driveId, workbookPath: profile.identity.workbookPath });
  const { grid, rowOffset } = parseWorkbookGrid(bytes, profile.workbookMapping.source);
  const result = readWorkbookGrid(grid, profile, rowOffset);

  return {
    rows: result.rows,
    rejectedRows: result.rejectedRows,
    source: `${profile.identity.workbookPath}#${profile.workbookMapping.source.name} in ${profile.identity.library}`,
  };
}
```

- [ ] **Step 4: Delete the Excel session layer**

```bash
git rm src/graph/excel.ts tests/graph/excel.test.ts tests/graph/excel.errors.test.ts
```

Search for stragglers: `grep -rn "graph/excel" src tests scripts`. Expect none.

- [ ] **Step 5: Run everything**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(workbook): read the snapshot from downloaded bytes and drop the Excel session layer"
```

---

### Task 8: The real Excel fixture

**Files:**
- Create: `tests/workbook/fixtures/real-excel.xlsx` (binary, produced by Excel, not by this repo)
- Test: `tests/workbook/xlsx.real.test.ts`

**Interfaces:**
- Consumes: `parseWorkbookGrid`.
- Produces: nothing.

**This task needs a human.** The fixture cannot be generated by an agent, and generating it with `scripts/seed/blank-workbook.ts` would defeat its entire purpose. It is the only artifact in the suite that can catch a wrong assumption about what Excel actually emits, which is the exact failure that made this phase necessary.

The operator creates a workbook in Excel, or Excel for the web, containing: a table named `ClientRoster` that does not start at cell A1, a text column, a date column, a formula column whose cached value is present, and one cell holding `#N/A`. Then saves it and checks it in.

- [ ] **Step 1: Obtain the fixture**

Ask the operator for the file if it is not already at `tests/workbook/fixtures/real-excel.xlsx`. Do not proceed without it and do not synthesize a substitute.

- [ ] **Step 2: Write the test**

```typescript
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseWorkbookGrid } from "../../src/workbook/xlsx.js";
import { UNEVALUABLE } from "../../src/workbook/cells.js";

// The only test in this suite whose input Excel produced. Every other fixture
// states what this repository believes Excel emits; this one is evidence.
describe("a workbook Excel actually wrote", () => {
  const bytes = new Uint8Array(readFileSync(new URL("./fixtures/real-excel.xlsx", import.meta.url)));

  it("resolves the named table to its own range, offset from A1", () => {
    const { grid, rowOffset } = parseWorkbookGrid(bytes, { kind: "table", name: "ClientRoster" });
    expect(rowOffset).toBeGreaterThan(1);
    expect(grid[0]).toContain("Client");
  });

  it("refuses the cell Excel stored as an error", () => {
    const { grid } = parseWorkbookGrid(bytes, { kind: "table", name: "ClientRoster" });
    expect(grid.flat()).toContain(UNEVALUABLE);
  });
});
```

- [ ] **Step 3: Run it**

Run: `npx vitest run tests/workbook/xlsx.real.test.ts`
Expected: PASS. A failure here is a real finding about Excel's output, not a test to adjust until it agrees.

- [ ] **Step 4: Commit**

```bash
git add tests/workbook/fixtures/real-excel.xlsx tests/workbook/xlsx.real.test.ts
git commit -m "test(workbook): pin the parser against a workbook Excel produced"
```

---

### Task 9: Make the seeder write its workbook without the Excel API

**Files:**
- Modify: `scripts/seed/blank-workbook.ts` (write a populated workbook, not a blank one)
- Modify: `scripts/seed/workbook.ts` (one upload, no `/workbook/` calls)
- Modify: `scripts/seed-library.ts` (the execution report, see Step 4)
- Test: `tests/scripts/seed/workbook.test.ts` and its `.errors.test.ts` sibling

**Interfaces:**
- Consumes: `buildSeedPlan`'s plan, `workbookGrid` and `onboardedColumnAddress` from `scripts/seed/rows.js`.
- Produces: `createSeedWorkbook(client, driveId, workbookPath, plan): Promise<{ requests: number }>`, unchanged in signature.

**Why this is in this plan rather than after it.** `scripts/seed/workbook.ts` populates the tracking workbook through `PATCH .../workbook/worksheets(...)/range(...)` and `POST .../workbook/tables/add`. Those are the calls the 2026-09-16 sitting proved unreachable, which is how this whole phase started. Until they are gone the seeder cannot create a workbook at all, so nothing built in Tasks 1 through 8 can be exercised against a tenant and step 7 of the runbook in `docs/OPEN-ITEMS.md` stays blocked. The phase would ship unverifiable.

The replacement writes the whole populated workbook in memory, table definition included, and uploads it with one `PUT .../content`. That is five Graph calls replaced by one, and it removes the seeder's dependency on an API this project has established it cannot use.

- [ ] **Step 1: Write the failing test**

```typescript
it("creates the workbook with a single content upload and no workbook API call", async () => {
  const calls: string[] = [];
  const client = fakeClientRecording(calls);

  await createSeedWorkbook(client, "d1", "/Trackers/Book.xlsx", plan);

  expect(calls.filter((call) => call.includes("/workbook/"))).toEqual([]);
  expect(calls.filter((call) => call.endsWith("/content"))).toHaveLength(1);
});

it("writes a table the parser can resolve by name", async () => {
  // The seeder and the reader meeting on real bytes. This is not
  // agree-by-construction: the reader is the production parser, and what it
  // proves is that the seeded file is one the server can actually read.
  const uploaded = await captureUploadedBytes(plan);
  const { grid } = parseWorkbookGrid(uploaded, { kind: "table", name: "ClientRoster" });
  expect(grid[0]).toContain("Client");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/scripts/seed/workbook.test.ts`
Expected: FAIL, the current implementation issues `/workbook/` calls.

- [ ] **Step 3: Extend the workbook writer and collapse the upload**

`scripts/seed/blank-workbook.ts` already assembles an xlsx from scratch. Extend it to take the grid and emit `xl/worksheets/sheet1.xml` with those rows, an `xl/tables/table1.xml` defining `ClientRoster` over the used range, and the worksheet rels entry pointing at it. Then `createSeedWorkbook` becomes: build bytes, `PUT` them once, return `{ requests: 1 }`.

Delete the range-write and table-add code paths along with their error messages. One of those messages is the defect recorded in `docs/OPEN-ITEMS.md` that attributed a failure to the uploaded bytes; deleting the call deletes the wrong claim, which is the correct fix rather than rewording it.

- [ ] **Step 4: Fix the discarded execution report**

`runSeed` in `scripts/seed-library.ts` calls `executeSeed`, then `createSeedWorkbook`, and only then prints `formatExecutionReport`. On 2026-09-16 the workbook step failed and the operator was told nothing about the 121 folders and 143 files that had just been written. Print the execution report before the workbook step, so work that happened is reported whether or not what follows it succeeds. This is the second seeder defect in `docs/OPEN-ITEMS.md`.

- [ ] **Step 5: Run everything**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix(seed): write the tracking workbook as bytes instead of through the Excel API"
```

---

## What this plan does not do

It does not run against a tenant. When it is finished, `reconcile_workbook_vs_repository` becomes runnable end to end for the first time, which makes step 7 of the runbook in `docs/OPEN-ITEMS.md` possible. That live comparison against the seeder's predicted report is the next piece of work after this plan, not part of it.

It does not touch phase 2c. Every report continues to carry `searchCrossCheckIncluded: false`.

Task 9 fixes both seeder defects the 2026-09-16 sitting exposed, because removing the unreachable calls deletes the message that made the false claim, and the discarded execution report is a two line change in the same file. Neither is left for later.
