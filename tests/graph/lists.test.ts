import { describe, expect, it } from "vitest";
import { createListItem, getListItem, listItemsPath, odataString, queryListItems, updateListItemFields } from "../../src/graph/lists.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { L1B_ITEM_READ, L1_ITEMS_PAGE, L2A_ITEM_CREATED, L2B_FIELDS_UPDATED, L3B_FILTERED_PAGE } from "./fixtures/assessment-probe.js";

const PATH = "/sites/site-1/lists/IW%20Probe%20Assessments/items";
const LIST = "IW Probe Assessments";

function recordingClient(responses: unknown[]) {
  const calls: Array<{ verb: string; path: string; body?: unknown; headers?: Record<string, string> }> = [];
  let next = 0;
  const answer = <T>(): T => responses[Math.min(next++, responses.length - 1)] as T;
  return {
    calls,
    get: async <T>(path: string, headers?: Record<string, string>): Promise<T> => {
      calls.push({ verb: "get", path, ...(headers === undefined ? {} : { headers }) });
      return answer<T>();
    },
    post: async <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ verb: "post", path, body });
      return answer<T>();
    },
    patch: async <T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> => {
      calls.push({ verb: "patch", path, body, ...(headers === undefined ? {} : { headers }) });
      const response = answer<unknown>();
      if (response instanceof Error) throw response;
      return response as T;
    },
  };
}

describe("listItemsPath and odataString", () => {
  it("encodes the list name into the path", () => {
    expect(listItemsPath("site-1", LIST)).toBe(PATH);
  });

  it("doubles single quotes in an OData string literal", () => {
    expect(odataString("O'Neil")).toBe("'O''Neil'");
  });
});

describe("queryListItems", () => {
  const filter = "fields/AssessmentId eq 'PRB-1'";

  it("sends the filter with the non-indexed header and maps the record", async () => {
    const client = recordingClient([L3B_FILTERED_PAGE]);
    const records = await queryListItems(client, { siteId: "site-1", listName: LIST, filter });

    expect(client.calls[0]?.verb).toBe("get");
    expect(client.calls[0]?.path).toBe(`${PATH}?$expand=fields&$top=50&$filter=${encodeURIComponent(filter)}`);
    expect(client.calls[0]?.headers).toEqual({ Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "2", eTag: L3B_FILTERED_PAGE.value[0]?.eTag });
    expect(records[0]?.fields.AssessmentId).toBe("PRB-20261107T203924Z-00002");
  });

  it("follows the nextLink once and stops at a page without one", async () => {
    const next = "https://graph.microsoft.com/v1.0/next-page";
    const client = recordingClient([{ ...L1_ITEMS_PAGE, "@odata.nextLink": next }, L3B_FILTERED_PAGE]);
    const records = await queryListItems(client, { siteId: "site-1", listName: LIST, filter });

    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.path).toBe(next);
    expect(records.length).toBe(L1_ITEMS_PAGE.value.length + 1);
  });
});

describe("getListItem", () => {
  it("reads one item with its fields expanded", async () => {
    const client = recordingClient([L1B_ITEM_READ]);
    const record = await getListItem(client, { siteId: "site-1", listName: LIST, itemId: "2" });

    expect(client.calls[0]?.path).toBe(`${PATH}/2?$expand=fields`);
    expect(record).toMatchObject({ id: "2" });
  });
});

describe("createListItem", () => {
  it("posts the fields and returns the created item", async () => {
    const client = recordingClient([L2A_ITEM_CREATED]);
    const fields = { Title: "probe", AssessmentId: "PRB-1" };
    const record = await createListItem(client, { siteId: "site-1", listName: LIST, fields });

    expect(client.calls[0]).toMatchObject({ verb: "post", path: PATH, body: { fields } });
    expect(record.id).toBe("2");
  });
});

describe("updateListItemFields", () => {
  const args = { siteId: "site-1", listName: LIST, itemId: "2", fields: { Status: "In Progress" }, etag: '"abc,1"' };

  it("patches the fields under the eTag given and returns them with the item's new eTag", async () => {
    const client = recordingClient([L2B_FIELDS_UPDATED]);
    const result = await updateListItemFields(client, args);

    expect(client.calls[0]).toMatchObject({ verb: "patch", path: `${PATH}/2/fields`, body: args.fields, headers: { "if-match": '"abc,1"' } });
    // Measured 2026-11-17 (L4c) and already in the 2026-11-07 recording: the answer carries the
    // item's eTag after the write, so a second write in one call needs no read between.
    expect(result).toMatchObject({ kind: "updated", eTag: '"<guid>,2"' });
    if (result.kind !== "updated") throw new Error("expected an update");
    expect(result.fields.AssessmentId).toBe("PRB-20261107T203924Z-00002");
  });

  it("reports a 412 as a precondition that failed, the answer L4a measured for a stale eTag", async () => {
    const refused = new GraphRequestError({ method: "PATCH", path: `${PATH}/2/fields`, status: 412, body: JSON.stringify({ error: { code: "resourceModified", message: "The resource has changed since the caller last read it; usually an eTag mismatch" } }) });
    const client = recordingClient([refused]);
    expect(await updateListItemFields(client, args)).toEqual({ kind: "precondition_failed" });
  });

  it("lets every other failure through as the error it is", async () => {
    const denied = new GraphRequestError({ method: "PATCH", path: `${PATH}/2/fields`, status: 403, body: JSON.stringify({ error: { code: "accessDenied" } }) });
    const client = recordingClient([denied]);
    await expect(updateListItemFields(client, args)).rejects.toBe(denied);
  });

  it("answers with no eTag when Graph's answer carries none, and does not invent one", async () => {
    const client = recordingClient([{ Status: "In Progress" }]);
    expect(await updateListItemFields(client, args)).toEqual({ kind: "updated", fields: { Status: "In Progress" }, eTag: undefined });
  });
});
