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
    const page: { value?: unknown; "@odata.nextLink"?: unknown } = await client.get(url, NON_INDEXED_QUERY_HEADER);
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
