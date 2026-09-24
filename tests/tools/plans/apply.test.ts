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
