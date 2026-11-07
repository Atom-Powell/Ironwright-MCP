import { readFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GraphClient } from "../../../src/graph/client.js";
import { GraphRequestError } from "../../../src/graph/errors.js";
import { createProfileRegistry } from "../../../src/profiles/registry.js";
import type { ToolContext } from "../../../src/tools/context.js";
import { createFakeToolContext } from "../fake-context.js";
import { F0_FOLDER_CREATED, F2A_FILE_CREATED, L2A_ITEM_CREATED } from "../../graph/fixtures/assessment-probe.js";

export type ScriptedMethod = "get" | "post" | "patch" | "putBytes" | "getBytes";

/**
 * One scripted answer. `pathIncludes` is matched against the request path
 * after percent-decoding, so a test names "Acme Corp" and a filter as it reads
 * rather than as Graph's URL encoding spells it; an array means every part
 * must be present. `throws` with a status builds the GraphRequestError the
 * real client would, carrying the method and path actually requested.
 */
export interface ScriptEntry {
  method: ScriptedMethod;
  pathIncludes: string | string[];
  headersInclude?: Record<string, string>;
  response?: unknown;
  throws?: { status: number; code?: string } | Error;
}

export interface RecordedCall {
  method: ScriptedMethod;
  path: string;
  body: unknown;
  headers: Record<string, string> | undefined;
}

const HTTP_METHOD: Record<ScriptedMethod, string> = { get: "GET", post: "POST", patch: "PATCH", putBytes: "PUT", getBytes: "GET" };

function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * A GraphClient answering from an ordered script: each call takes the first
 * unconsumed entry whose method, path and headers match, so two reads of one
 * path answer in the order the script lists them. A call with no scripted
 * answer throws a descriptive error rather than returning something plausible,
 * because an empty page invented by a fake reads exactly like an empty list.
 */
export function createScriptedGraph(script: readonly ScriptEntry[]): { graph: GraphClient; calls: RecordedCall[] } {
  const entries = script.map((entry) => ({ entry, used: false }));
  const calls: RecordedCall[] = [];
  let requestCount = 0;

  function answer(method: ScriptedMethod, path: string, body: unknown, headers: Record<string, string> | undefined): unknown {
    calls.push({ method, path, body, headers });
    const readable = decoded(path);
    const slot = entries.find(({ entry, used }) => {
      if (used || entry.method !== method) return false;
      const parts = Array.isArray(entry.pathIncludes) ? entry.pathIncludes : [entry.pathIncludes];
      if (!parts.every((part) => readable.includes(part))) return false;
      return Object.entries(entry.headersInclude ?? {}).every(([key, value]) => headers?.[key] === value);
    });
    if (slot === undefined) {
      throw new Error(`the scripted Graph fake has no answer for ${method} ${readable} with headers ${JSON.stringify(headers ?? {})}`);
    }
    slot.used = true;
    const thrown = slot.entry.throws;
    if (thrown instanceof Error) throw thrown;
    if (thrown !== undefined) {
      const errorBody = JSON.stringify({ error: { code: thrown.code ?? "generalException", message: "scripted failure" } });
      throw new GraphRequestError({ method: HTTP_METHOD[method], path, status: thrown.status, body: errorBody });
    }
    return structuredClone(slot.entry.response);
  }

  const graph: GraphClient = {
    async get<T>(pathOrUrl: string, headers?: Record<string, string>): Promise<T> {
      requestCount += 1;
      return answer("get", pathOrUrl, undefined, headers) as T;
    },
    async post<T>(pathOrUrl: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
      requestCount += 1;
      return answer("post", pathOrUrl, body, headers) as T;
    },
    async patch<T>(pathOrUrl: string, body: unknown, headers?: Record<string, string>): Promise<T> {
      requestCount += 1;
      return answer("patch", pathOrUrl, body, headers) as T;
    },
    async putBytes<T>(pathOrUrl: string, body: Uint8Array, contentType: string, headers?: Record<string, string>): Promise<T> {
      requestCount += 1;
      return answer("putBytes", pathOrUrl, { bytes: body, contentType }, headers) as T;
    },
    async getBytes(pathOrUrl: string): Promise<Uint8Array> {
      // Two, as in createFakeWorkbookGraphClient: the real client follows
      // Graph's 302 to the download URL with a second request.
      requestCount += 2;
      return answer("getBytes", pathOrUrl, undefined, undefined) as Uint8Array;
    },
    requests: () => requestCount,
  };

  return { graph, calls };
}

/** A list item shaped as Graph returns one (L2A), with the given id and fields. */
export function listItem(id: string, fields: Record<string, unknown>, eTag = `"item-${id},1"`): Record<string, unknown> {
  return { ...structuredClone(L2A_ITEM_CREATED), id, eTag, "@odata.etag": eTag, fields: { id, ...fields } };
}

/** A page of a list query (L1). */
export function page(items: readonly unknown[]): { value: unknown[] } {
  return { value: [...items] };
}

/** A folder driveItem shaped as F0. */
export function folderItem(name: string, etag = `"folder-${name}"`): Record<string, unknown> {
  return { ...structuredClone(F0_FOLDER_CREATED), id: `id-${name}`, name, eTag: etag, "@odata.etag": etag };
}

/** A file driveItem shaped as F2A. */
export function fileItem(name: string, etag: string, size: number): Record<string, unknown> {
  return { ...structuredClone(F2A_FILE_CREATED), id: `id-${name}`, name, eTag: etag, size };
}

export const SITE_URL = "https://contoso.sharepoint.com/sites/Example";

/** resolveDrive's two reads: the site lookup and the drives listing. */
export const RESOLVE_DRIVE_SCRIPT: readonly ScriptEntry[] = [
  { method: "get", pathIncludes: "/sites/contoso.sharepoint.com:/sites/Example", response: { id: "site-1" } },
  { method: "get", pathIncludes: "/sites/site-1/drives?", response: { value: [{ id: "drive-1", name: "Documents" }] } },
];

/** A tool context whose registry holds the assessment example, the compliance example and the library example. */
export function assessmentToolContext(graph: GraphClient): ToolContext {
  const read = (file: string): unknown => JSON.parse(readFileSync(`examples/profiles/${file}`, "utf8")) as unknown;
  const profiles = createProfileRegistry(
    [
      { source: "assessment-example.json", contents: read("assessment-example.json") },
      { source: "example.json", contents: read("example.json") },
      { source: "library-example.json", contents: read("library-example.json") },
    ],
    SITE_URL,
  );
  return createFakeToolContext({ profiles, graph });
}

export function resultText(result: CallToolResult): string {
  return result.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
}
