import { describe, expect, it } from "vitest";
import { DeltaResyncRequiredError, deltaPages } from "../../src/graph/delta.js";
import type { GraphClient } from "../../src/graph/client.js";
import { GraphRequestError } from "../../src/graph/errors.js";

function throwingClient(error: unknown): GraphClient {
  return { requests: () => 1, get: async () => { throw error; } };
}

const RESYNC = new GraphRequestError({
  method: "GET",
  path: "/drives/d1/root/delta",
  status: 410,
  body: JSON.stringify({ error: { code: "resyncRequired", message: "gone" } }),
});

describe("deltaPages failures", () => {
  it("turns a 410 resyncRequired on a stored link into DeltaResyncRequiredError", async () => {
    const iterator = deltaPages(throwingClient(RESYNC), "d1", "https://graph.microsoft.com/v1.0/stored");
    await expect(iterator.next()).rejects.toThrow(DeltaResyncRequiredError);
  });

  it("leaves a 410 on a fresh enumeration as the Graph error it is, since there is nothing to resync from", async () => {
    const iterator = deltaPages(throwingClient(RESYNC), "d1");
    await expect(iterator.next()).rejects.toThrow(GraphRequestError);
  });

  it("refuses a page carrying neither a nextLink nor a deltaLink, rather than looping or stopping silently", async () => {
    const client: GraphClient = { requests: () => 1, get: async () => ({ value: [] }) as never };
    const iterator = deltaPages(client, "d1");
    await expect(iterator.next()).rejects.toThrow(/neither @odata.nextLink nor @odata.deltaLink/);
  });
});
