import { randomUUID } from "node:crypto";
import { GRAPH_BASE, type GraphClient } from "../../src/graph/client.js";
import { GraphRequestError } from "../../src/graph/errors.js";

/**
 * A simulated tenant: one site, one document library and some lists, held in
 * memory, answering the Graph requests the assessment module sends. It exists
 * so the lifecycle tools can be run end to end, by a person or by a test,
 * with no tenant, no grant and no secret.
 *
 * What it proves and what it does not. It holds state between requests, so a
 * run against it shows whether the server's own steps compose: that a save
 * finds what an open created, that two overlapping calls are ordered, that a
 * retry writes nothing. It proves nothing about Microsoft Graph. Each behavior
 * below was copied from a dated measurement against a real tenant where one
 * exists, and the comment beside it names the probe; where none exists the
 * comment says "modeled". A modeled behavior is this author's reading of the
 * documentation, which is exactly what a fake proves and no more. The scripted
 * fake in tests/tools/assessment answers one request at a time from a list;
 * this answers from state, and neither is a tenant.
 *
 * Requests it does not simulate throw a plain error that says so. An empty
 * answer invented here would read exactly like an empty library.
 */
export interface SimTenantOptions {
  siteUrl: string;
  /** The document library's name, as the drive listing returns it. */
  library: string;
  /** Each list's name and the internal column names it has besides Title. */
  lists: Record<string, readonly string[]>;
  /**
   * Whether a list filter's `eq` matches text without regard to case. Not
   * measured against a tenant for lists (the 2026-11-09 campaign measured it
   * for drive paths only), so both readings can be run. Defaults to true.
   */
  listFilterIgnoresCase?: boolean;
  /** Milliseconds each request takes, so a run can show what concurrency saves. Defaults to none. */
  latencyMs?: number;
  now?: () => Date;
}

export interface SimFailure {
  method: "GET" | "POST" | "PATCH" | "PUT";
  pathIncludes: string;
  status: number;
  code: string;
}

export interface SimTenant {
  graph: GraphClient;
  siteId: string;
  driveId: string;
  /** Every request received, in order, with its path percent-decoded. */
  calls: { method: string; path: string }[];
  /** What a person or a publisher does outside this server: put a file at a path, parents included. */
  putFile(path: string, bytes: Uint8Array): void;
  /** Remove a file, or a folder and everything under it. */
  removeItem(path: string): void;
  /** Edit a list item by hand, as an operator would in the browser. */
  setListItemFields(listName: string, itemId: string, fields: Record<string, unknown>): void;
  listItems(listName: string): { id: string; fields: Record<string, unknown> }[];
  tree(): { path: string; kind: "folder" | "file"; size: number }[];
  /** The next request matching this fails once with the status and code given. */
  failNext(failure: SimFailure): void;
}

interface DriveNode {
  id: string;
  /** The path as stored, with the casing the item was created under. */
  path: string;
  name: string;
  isFolder: boolean;
  bytes: Uint8Array;
  guid: string;
  version: number;
  modified: string;
}

interface ListItem {
  id: string;
  guid: string;
  version: number;
  fields: Record<string, unknown>;
  modified: string;
}

interface SimList {
  name: string;
  columns: Set<string>;
  nextId: number;
  items: Map<string, ListItem>;
}

const REFUSED_NAME_CHARACTERS = /["*:<>?/\\|]/;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function createSimTenant(options: SimTenantOptions): SimTenant {
  const siteId = "sim-site";
  const driveId = "sim-drive";
  const now = options.now ?? ((): Date => new Date());
  const ignoresCase = options.listFilterIgnoresCase ?? true;
  const site = new URL(options.siteUrl);
  const siteLookup = `${site.hostname}:${site.pathname.replace(/\/+$/, "")}`.toLowerCase();

  const lists = new Map<string, SimList>();
  for (const [name, columns] of Object.entries(options.lists)) {
    lists.set(name.toLowerCase(), { name, columns: new Set(["Title", ...columns]), nextId: 1, items: new Map() });
  }
  // Keyed by the lowercased path: SharePoint treats two paths differing only by case as one.
  const drive = new Map<string, DriveNode>();
  const calls: { method: string; path: string }[] = [];
  const failures: SimFailure[] = [];
  let requestCount = 0;

  function refuse(method: string, path: string, status: number, code: string, message: string): never {
    throw new GraphRequestError({ method, path, status, body: JSON.stringify({ error: { code, message } }) });
  }

  function listItemJson(list: SimList, item: ListItem, expand: boolean): Record<string, unknown> {
    const etag = `"${item.guid},${item.version}"`;
    return {
      "@odata.etag": etag,
      eTag: etag,
      id: item.id,
      lastModifiedDateTime: item.modified,
      webUrl: `${options.siteUrl}/Lists/${encodeURIComponent(list.name)}/${item.id}_.000`,
      ...(expand ? { fields: fieldsJson(item) } : {}),
    };
  }

  function fieldsJson(item: ListItem): Record<string, unknown> {
    return { "@odata.etag": `"${item.guid},${item.version}"`, ...structuredClone(item.fields), id: item.id };
  }

  function driveItemJson(node: DriveNode): Record<string, unknown> {
    const etag = `"{${node.guid.toUpperCase()}},${node.version}"`;
    const parent = parentOf(node.path);
    const encodedParent = parent.length === 0 ? "" : `/${parent.split("/").map(encodeURIComponent).join("/")}`;
    const children = [...drive.values()].filter((other) => parentOf(other.path).toLowerCase() === node.path.toLowerCase()).length;
    return {
      "@odata.etag": etag,
      eTag: etag,
      id: node.id,
      name: node.name,
      size: node.isFolder ? 0 : node.bytes.byteLength,
      lastModifiedDateTime: node.modified,
      webUrl: `${options.siteUrl}/${encodeURIComponent(options.library)}/${node.path.split("/").map(encodeURIComponent).join("/")}`,
      parentReference: { driveId, driveType: "documentLibrary", path: `/drives/${driveId}/root:${encodedParent}` },
      ...(node.isFolder ? { folder: { childCount: children } } : { file: { mimeType: "application/octet-stream" } }),
    };
  }

  function newNode(path: string, isFolder: boolean, bytes: Uint8Array): DriveNode {
    const node: DriveNode = { id: `sim-item-${randomUUID()}`, path, name: nameOf(path), isFolder, bytes, guid: randomUUID(), version: 1, modified: now().toISOString() };
    drive.set(path.toLowerCase(), node);
    return node;
  }

  /** The stored path of a folder, by any casing; the root is the empty path. */
  function storedFolderPath(path: string): string | undefined {
    if (path.length === 0) return "";
    const node = drive.get(path.toLowerCase());
    return node !== undefined && node.isFolder ? node.path : undefined;
  }

  /**
   * Creates the folders a path's parent chain lacks and returns the parent as
   * stored. Measured 2026-11-09 for one level (a content PUT recreated a
   * deleted `Published`); deeper levels are modeled the same way.
   */
  function ensureParents(method: string, requestPath: string, path: string): string {
    let stored = "";
    for (const segment of parentOf(path).split("/").filter((part) => part.length > 0)) {
      const candidate = stored.length === 0 ? segment : `${stored}/${segment}`;
      const existing = drive.get(candidate.toLowerCase());
      if (existing === undefined) stored = newNode(candidate, true, new Uint8Array()).path;
      else if (existing.isFolder) stored = existing.path;
      else refuse(method, requestPath, 409, "nameAlreadyExists", "A file holds the name of a parent folder.");
    }
    return stored;
  }

  /** Modeled on SharePoint's published name rules; the status and code were not measured. */
  function checkName(method: string, requestPath: string, name: string): void {
    if (name.length === 0 || REFUSED_NAME_CHARACTERS.test(name) || /[.\s]$/.test(name) || /^\s/.test(name)) {
      refuse(method, requestPath, 400, "invalidRequest", `The name "${name}" is not one SharePoint accepts.`);
    }
  }

  function requireList(method: string, requestPath: string, name: string): SimList {
    const list = lists.get(name.toLowerCase());
    if (list === undefined) refuse(method, requestPath, 404, "itemNotFound", `The list "${name}" was not found.`);
    return list;
  }

  /** Modeled: Graph documents a 400 for a field the list does not have. */
  function checkColumns(method: string, requestPath: string, list: SimList, names: readonly string[]): void {
    for (const name of names) {
      if (!list.columns.has(name)) refuse(method, requestPath, 400, "invalidRequest", `Field '${name}' is not recognized.`);
    }
  }

  function parseFilter(method: string, requestPath: string, filter: string): { column: string; value: string }[] {
    const clauses: { column: string; value: string }[] = [];
    const clause = /fields\/([A-Za-z0-9_]+) eq '((?:[^']|'')*)'/y;
    let position = 0;
    for (;;) {
      clause.lastIndex = position;
      const match = clause.exec(filter);
      if (match === null) refuse(method, requestPath, 400, "invalidRequest", `The simulated tenant reads only "fields/X eq 'value'" clauses joined by and; it could not read: ${filter}`);
      clauses.push({ column: match[1]!, value: match[2]!.replace(/''/g, "'") });
      position = clause.lastIndex;
      if (position === filter.length) return clauses;
      if (!filter.startsWith(" and ", position)) refuse(method, requestPath, 400, "invalidRequest", `The simulated tenant could not read the filter past character ${position}: ${filter}`);
      position += " and ".length;
    }
  }

  function queryList(requestPath: string, list: SimList, query: URLSearchParams, headers: Record<string, string> | undefined): unknown {
    const filter = query.get("$filter");
    let items = [...list.items.values()];
    if (filter !== null) {
      // L3a, 2026-11-07: a $filter on a non indexed column answers 400 invalidRequest without this
      // header and 200 with it. No simulated column is indexed.
      if (headers?.Prefer !== "HonorNonIndexedQueriesWarningMayFailRandomly") {
        refuse("GET", requestPath, 400, "invalidRequest", "Field cannot be referenced in filter or orderby as it is not indexed. Provide the 'Prefer: HonorNonIndexedQueriesWarningMayFailRandomly' header to allow partial results for filters on unindexed fields.");
      }
      const clauses = parseFilter("GET", requestPath, filter);
      checkColumns("GET", requestPath, list, clauses.map((entry) => entry.column));
      const same = (stored: unknown, wanted: string): boolean =>
        typeof stored === "string" && (ignoresCase ? stored.toLowerCase() === wanted.toLowerCase() : stored === wanted);
      items = items.filter((item) => clauses.every((entry) => same(item.fields[entry.column], entry.value)));
    }
    const top = Number(query.get("$top") ?? "200");
    const skip = Number(query.get("$skiptoken") ?? "0");
    const page = items.slice(skip, skip + top);
    const expand = query.get("$expand") === "fields";
    const body: Record<string, unknown> = { value: page.map((item) => listItemJson(list, item, expand)) };
    if (skip + top < items.length) {
      const next = new URLSearchParams(query);
      next.set("$skiptoken", String(skip + top));
      // Absolute, as Graph's own next link is.
      body["@odata.nextLink"] = `${GRAPH_BASE}${requestPath.split("?")[0]}?${next.toString()}`;
    }
    return body;
  }

  function route(method: SimFailure["method"], raw: string, body: unknown, headers: Record<string, string> | undefined): unknown {
    const relative = raw.startsWith(GRAPH_BASE) ? raw.slice(GRAPH_BASE.length) : raw;
    const mark = relative.indexOf("?");
    const path = mark === -1 ? relative : relative.slice(0, mark);
    const query = new URLSearchParams(mark === -1 ? "" : relative.slice(mark + 1));
    const notSimulated = (): never => {
      throw new Error(`The simulated tenant does not simulate ${method} ${decodeSegment(path)}. It answers only what the assessment module sends.`);
    };

    const listMatch = /^\/sites\/([^/]+)\/lists\/([^/]+)\/items(?:\/([^/]+))?(\/fields)?$/.exec(path);
    if (listMatch !== null && listMatch[1] === siteId) {
      const list = requireList(method, relative, decodeSegment(listMatch[2]!));
      const itemId = listMatch[3] === undefined ? undefined : decodeSegment(listMatch[3]);
      const onFields = listMatch[4] !== undefined;
      if (itemId === undefined && method === "GET") return queryList(relative, list, query, headers);
      if (itemId === undefined && method === "POST") {
        const fields = (body as { fields?: Record<string, unknown> } | undefined)?.fields ?? {};
        checkColumns(method, relative, list, Object.keys(fields));
        // L2a, 2026-11-07: the id is the list's integer item id rendered as a string. SharePoint never reuses one.
        const item: ListItem = { id: String(list.nextId), guid: randomUUID(), version: 1, fields: structuredClone(fields), modified: now().toISOString() };
        list.nextId += 1;
        list.items.set(item.id, item);
        return listItemJson(list, item, true);
      }
      if (itemId !== undefined) {
        const item = list.items.get(itemId);
        if (item === undefined) refuse(method, relative, 404, "itemNotFound", "The specified list item was not found.");
        if (!onFields && method === "GET") return listItemJson(list, item, query.get("$expand") === "fields");
        if (onFields && method === "PATCH") {
          const fields = (body ?? {}) as Record<string, unknown>;
          checkColumns(method, relative, list, Object.keys(fields));
          // L4a and L4b, 2026-11-17: a stale If-Match answers 412 resourceModified and writes
          // nothing. A PATCH with no If-Match is unconditional, as L2b sent it on 2026-11-07.
          const ifMatch = headers?.["if-match"];
          if (ifMatch !== undefined && ifMatch !== `"${item.guid},${item.version}"`) {
            refuse(method, relative, 412, "resourceModified", "The resource has changed since the caller last read it; usually an eTag mismatch");
          }
          Object.assign(item.fields, structuredClone(fields));
          item.version += 1;
          item.modified = now().toISOString();
          // L2b, 2026-11-07: the response is the whole fields object after the update.
          return fieldsJson(item);
        }
      }
      return notSimulated();
    }

    if (path === `/sites/${siteId}/drives` && method === "GET") {
      return { value: [{ id: driveId, name: options.library, webUrl: `${options.siteUrl}/${encodeURIComponent(options.library)}` }] };
    }

    // The site by hostname and server relative path, "host:/sites/Name", or a root site by hostname alone.
    const siteMatch = /^\/sites\/([^/:]+(?::\/.*)?)$/.exec(path);
    if (siteMatch !== null && method === "GET") {
      const asked = decodeSegment(siteMatch[1]!).toLowerCase().replace(/:$/, "");
      if (asked !== siteLookup.replace(/:$/, "") && siteMatch[1] !== siteId) refuse(method, relative, 404, "itemNotFound", "Requested site could not be found.");
      return { id: siteId, webUrl: options.siteUrl };
    }

    const driveMatch = /^\/drives\/([^/]+)\/root(?::\/(.*?):)?(\/children|\/content)?$/.exec(path);
    if (driveMatch !== null && driveMatch[1] === driveId) {
      const itemPath = (driveMatch[2] ?? "").split("/").map(decodeSegment).join("/");
      const suffix = driveMatch[3];
      const node = drive.get(itemPath.toLowerCase());

      if (suffix === undefined && method === "GET") {
        if (itemPath.length === 0) return { id: "sim-root", name: "root", folder: { childCount: 0 }, size: 0 };
        // The campaign, 2026-11-09: a path is looked up without regard to case, and the item
        // answered carries its stored name.
        if (node === undefined) refuse(method, relative, 404, "itemNotFound", "The resource could not be found.");
        return driveItemJson(node);
      }

      if (suffix === "/children" && method === "POST") {
        const request = (body ?? {}) as { name?: unknown; folder?: unknown; "@microsoft.graph.conflictBehavior"?: unknown };
        if (typeof request.name !== "string" || request.folder === undefined || request["@microsoft.graph.conflictBehavior"] !== "fail") return notSimulated();
        const parent = storedFolderPath(itemPath);
        if (parent === undefined) refuse(method, relative, 404, "itemNotFound", "The parent folder could not be found.");
        checkName(method, relative, request.name);
        const target = parent.length === 0 ? request.name : `${parent}/${request.name}`;
        // F1b, 2026-11-07: a present folder answers 409 nameAlreadyExists under conflictBehavior fail.
        if (drive.has(target.toLowerCase())) refuse(method, relative, 409, "nameAlreadyExists", "Name already exists");
        return driveItemJson(newNode(target, true, new Uint8Array()));
      }

      if (suffix === "/content" && method === "GET") {
        if (node === undefined || node.isFolder) refuse(method, relative, 404, "itemNotFound", "The resource could not be found.");
        return node.bytes.slice();
      }

      if (suffix === "/content" && method === "PUT") {
        const upload = body as { bytes: Uint8Array };
        const ifMatch = headers?.["if-match"];
        const failOnConflict = query.get("@microsoft.graph.conflictBehavior") === "fail";
        if (node !== undefined && node.isFolder) refuse(method, relative, 409, "nameAlreadyExists", "A folder holds this name.");
        if (node !== undefined) {
          // F2b, 2026-11-07: an occupied name answers 409 nameAlreadyExists and nothing is replaced.
          if (failOnConflict) refuse(method, relative, 409, "nameAlreadyExists", "Name already exists");
          // F3b, 2026-11-07: a stale ETag answers 412 with code notAllowed.
          if (ifMatch !== undefined && ifMatch !== `"{${node.guid.toUpperCase()}},${node.version}"`) {
            refuse(method, relative, 412, "notAllowed", "ETag does not match current item's value");
          }
          node.bytes = upload.bytes.slice();
          node.version += 1;
          node.modified = now().toISOString();
          return driveItemJson(node);
        }
        // F3c, 2026-11-07: a PUT under If-Match against a path holding nothing creates the file.
        checkName(method, relative, nameOf(itemPath));
        const parent = ensureParents(method, relative, itemPath);
        const name = nameOf(itemPath);
        return driveItemJson(newNode(parent.length === 0 ? name : `${parent}/${name}`, false, upload.bytes.slice()));
      }
    }

    return notSimulated();
  }

  async function handle(method: SimFailure["method"], raw: string, body: unknown, headers: Record<string, string> | undefined): Promise<unknown> {
    requestCount += 1;
    // Every request yields before it is answered, as a network request does, so two calls running
    // at once interleave here the way they would against a tenant. Without it one call would run
    // to completion before the other started and a missing lock could never show.
    await new Promise<void>((resolve) => (options.latencyMs === undefined ? setImmediate(resolve) : setTimeout(resolve, options.latencyMs)));
    const readable = decodeSegment(raw.startsWith(GRAPH_BASE) ? raw.slice(GRAPH_BASE.length) : raw);
    calls.push({ method, path: readable });
    const planned = failures.findIndex((failure) => failure.method === method && readable.includes(failure.pathIncludes));
    if (planned !== -1) {
      const [failure] = failures.splice(planned, 1);
      refuse(method, raw, failure!.status, failure!.code, "A failure the test asked for.");
    }
    return route(method, raw, body, headers);
  }

  const graph: GraphClient = {
    get: <T>(pathOrUrl: string, headers?: Record<string, string>) => handle("GET", pathOrUrl, undefined, headers) as Promise<T>,
    post: <T>(pathOrUrl: string, body?: unknown, headers?: Record<string, string>) => handle("POST", pathOrUrl, body, headers) as Promise<T>,
    patch: <T>(pathOrUrl: string, body: unknown, headers?: Record<string, string>) => handle("PATCH", pathOrUrl, body, headers) as Promise<T>,
    putBytes: <T>(pathOrUrl: string, body: Uint8Array, contentType: string, headers?: Record<string, string>) =>
      handle("PUT", pathOrUrl, { bytes: body, contentType }, headers) as Promise<T>,
    async getBytes(pathOrUrl: string): Promise<Uint8Array> {
      // Two, as the real client spends: Graph answers a content request with a redirect to the download URL.
      requestCount += 1;
      return (await handle("GET", pathOrUrl, undefined, undefined)) as Uint8Array;
    },
    requests: () => requestCount,
  };

  return {
    graph,
    siteId,
    driveId,
    calls,
    putFile(path: string, bytes: Uint8Array): void {
      const existing = drive.get(path.toLowerCase());
      if (existing !== undefined && !existing.isFolder) {
        existing.bytes = bytes.slice();
        existing.version += 1;
        existing.modified = now().toISOString();
        return;
      }
      if (existing !== undefined) throw new Error(`A folder is at ${path}; the simulated tenant will not put a file over it.`);
      const parent = ensureParents("PUT", path, path);
      const name = nameOf(path);
      newNode(parent.length === 0 ? name : `${parent}/${name}`, false, bytes.slice());
    },
    removeItem(path: string): void {
      const key = path.toLowerCase();
      for (const candidate of [...drive.keys()]) {
        if (candidate === key || candidate.startsWith(`${key}/`)) drive.delete(candidate);
      }
    },
    setListItemFields(listName: string, itemId: string, fields: Record<string, unknown>): void {
      const item = lists.get(listName.toLowerCase())?.items.get(itemId);
      if (item === undefined) throw new Error(`The simulated list "${listName}" holds no item ${itemId}.`);
      Object.assign(item.fields, structuredClone(fields));
      item.version += 1;
      item.modified = now().toISOString();
    },
    listItems(listName: string): { id: string; fields: Record<string, unknown> }[] {
      const list = lists.get(listName.toLowerCase());
      if (list === undefined) throw new Error(`The simulated tenant has no list "${listName}".`);
      return [...list.items.values()].map((item) => ({ id: item.id, fields: structuredClone(item.fields) }));
    },
    tree(): { path: string; kind: "folder" | "file"; size: number }[] {
      return [...drive.values()]
        .map((node) => ({ path: node.path, kind: node.isFolder ? ("folder" as const) : ("file" as const), size: node.isFolder ? 0 : node.bytes.byteLength }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
    failNext(failure: SimFailure): void {
      failures.push(failure);
    },
  };
}
