import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPlan } from "../../../src/tools/plans/apply.js";
import type { StoredPlan } from "../../../src/store/types.js";
import type { GraphClient } from "../../../src/graph/client.js";
import { UnexpectedTokenRolesError } from "../../../src/graph/token.js";
import { createFakeToolContext } from "../fake-context.js";

function countingGraph(): GraphClient {
  let requestCount = 0;
  const answer = () => {
    requestCount += 1;
    return Promise.reject(new Error("this fake answers nothing"));
  };
  return { get: answer, post: answer, patch: answer, getBytes: answer, requests: () => requestCount };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyPlan failures", () => {
  it("reports an item that changes neither name nor folder as failed without counting a Graph operation", async () => {
    // Unreachable through either generator, which never pairs a file with
    // itself. A stored row can still hold one, and relocateDriveItem refuses
    // it before any request, so counting it as an operation issued would
    // report a request that was never made.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const graph = countingGraph();
    const path = "2026/ACME/09-September/2026-09_ACME_MonthlyTraining.xlsx";
    const plan: StoredPlan = {
      planId: "p1",
      profileId: "example",
      kind: "move",
      driveId: "drive-1",
      createdAt: "2026-09-24T12:00:00Z",
      items: [
        {
          path,
          currentName: "2026-09_ACME_MonthlyTraining.xlsx",
          targetName: "2026-09_ACME_MonthlyTraining.xlsx",
          targetPath: path,
          etag: '"{GUID},1"',
          client: "ACME",
        },
      ],
      excluded: [],
    };

    const result = await applyPlan(plan, {
      confirm: true,
      context: createFakeToolContext({ graph }),
      profileId: "example",
      toolName: "execute_move_plan",
      makeReversalPlanId: () => "rev-1",
    });

    expect(result.results.map((entry) => entry.outcome)).toEqual(["failed"]);
    expect(result.graphOperationsIssued).toBe(0);
    expect(graph.requests()).toBe(0);
  });

  it("reports a write refused for its token as failed without counting a Graph operation", async () => {
    // The guard refuses the token inside the client, before any request is
    // sent, so counting the item would report an operation never issued. The
    // other item still applies: the refusal is recorded per item, so the
    // plan's report survives it.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refusal = new UnexpectedTokenRolesError({
      found: ["Sites.Selected", "Files.Read.All"],
      extra: ["Files.Read.All"],
      missing: [],
    });
    let patches = 0;
    const graph: GraphClient = {
      ...countingGraph(),
      patch: (async (path: string) => {
        patches += 1;
        if (path.includes("Refused")) throw refusal;
        return { eTag: '"{GUID},2"' };
      }) as GraphClient["patch"],
    };
    const item = (name: string) => ({
      path: `2026/ACME/09-September/${name}`,
      currentName: name,
      targetName: `Renamed_${name}`,
      targetPath: `2026/ACME/09-September/Renamed_${name}`,
      etag: '"{GUID},1"',
      client: "ACME",
    });
    const plan: StoredPlan = {
      planId: "p1",
      profileId: "example",
      kind: "rename",
      driveId: "drive-1",
      createdAt: "2026-09-24T12:00:00Z",
      items: [item("Applied.xlsx"), item("Refused.xlsx")],
      excluded: [],
    };

    const result = await applyPlan(plan, {
      confirm: true,
      context: createFakeToolContext({ graph }),
      profileId: "example",
      toolName: "execute_rename_plan",
      makeReversalPlanId: () => "rev-1",
    });

    expect(patches).toBe(2);
    expect(result.results.map((entry) => [entry.item.currentName, entry.outcome])).toEqual([
      ["Applied.xlsx", "applied"],
      ["Refused.xlsx", "failed"],
    ]);
    expect(result.graphOperationsIssued).toBe(1);
  });

  it("does not count the follow-up etag read when its token is refused", async () => {
    // A PATCH answer carrying no eTag sends the executor to read the item's
    // etag. If that read's token is refused, no request was sent, so only the
    // PATCH counts; the write itself stays applied and the reversal entry is
    // reported as not refreshed.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refusal = new UnexpectedTokenRolesError({
      found: ["Sites.Selected", "Files.Read.All"],
      extra: ["Files.Read.All"],
      missing: [],
    });
    const graph: GraphClient = {
      ...countingGraph(),
      patch: (async () => ({})) as GraphClient["patch"],
      get: (async () => {
        throw refusal;
      }) as GraphClient["get"],
    };
    const plan: StoredPlan = {
      planId: "p1",
      profileId: "example",
      kind: "rename",
      driveId: "drive-1",
      createdAt: "2026-09-24T12:00:00Z",
      items: [
        {
          path: "2026/ACME/09-September/Old.xlsx",
          currentName: "Old.xlsx",
          targetName: "New.xlsx",
          targetPath: "2026/ACME/09-September/New.xlsx",
          etag: '"{GUID},1"',
          client: "ACME",
        },
      ],
      excluded: [],
    };

    const result = await applyPlan(plan, {
      confirm: true,
      context: createFakeToolContext({ graph }),
      profileId: "example",
      toolName: "execute_rename_plan",
      makeReversalPlanId: () => "rev-1",
    });

    expect(result.results.map((entry) => entry.outcome)).toEqual(["applied"]);
    expect(result.reversalEntriesNotRefreshed).toBe(1);
    expect(result.graphOperationsIssued).toBe(1);
  });
});
