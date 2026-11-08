import { describe, expect, it } from "vitest";
import { GraphRequestError } from "../../src/graph/errors.js";
import { getListItem, queryListItems } from "../../src/graph/lists.js";
import { L3B_FILTERED_PAGE } from "./fixtures/assessment-probe.js";

// Recorded 2026-11-07 (L3a): the body Graph sent for a filter on a non indexed column.
const L3A_BODY = JSON.stringify({
  error: {
    code: "invalidRequest",
    message:
      "Field 'AssessmentId' cannot be referenced in filter or orderby as it is not indexed. Provide the 'Prefer: HonorNonIndexedQueriesWarningMayFailRandomly' header to allow this, but be warned that such queries may fail on large lists.",
  },
});

const ARGS = { siteId: "site-1", listName: "IW Probe Assessments" };

function failingClient(error: unknown) {
  return {
    get: async <T>(): Promise<T> => {
      throw error;
    },
  };
}

describe("queryListItems failures", () => {
  it("rethrows a 400 unchanged so the caller can carry Graph's advice", async () => {
    const error = new GraphRequestError({ method: "GET", path: "/items", status: 400, body: L3A_BODY });
    await expect(queryListItems(failingClient(error), { ...ARGS, filter: "fields/AssessmentId eq 'x'" })).rejects.toBe(error);
  });

  it("throws naming the list when a page has no value array", async () => {
    const client = { get: async <T>(): Promise<T> => ({ value: "nope" }) as T };
    await expect(queryListItems(client, { ...ARGS, filter: "f eq 'x'" })).rejects.toThrow(/IW Probe Assessments/);
  });

  it("stops after 20 pages and names the count", async () => {
    let calls = 0;
    const client = {
      get: async <T>(): Promise<T> => {
        calls += 1;
        return { ...L3B_FILTERED_PAGE, "@odata.nextLink": "https://graph.microsoft.com/v1.0/loop" } as T;
      },
    };
    await expect(queryListItems(client, { ...ARGS, filter: "f eq 'x'" })).rejects.toThrow(/20 pages/);
    expect(calls).toBe(20);
  });
});

describe("getListItem failures", () => {
  it("maps 404 to undefined", async () => {
    const error = new GraphRequestError({ method: "GET", path: "/items/9", status: 404, body: "{}" });
    await expect(getListItem(failingClient(error), { ...ARGS, itemId: "9" })).resolves.toBeUndefined();
  });

  it("rethrows other statuses", async () => {
    const error = new GraphRequestError({ method: "GET", path: "/items/9", status: 403, body: "{}" });
    await expect(getListItem(failingClient(error), { ...ARGS, itemId: "9" })).rejects.toBe(error);
  });
});
