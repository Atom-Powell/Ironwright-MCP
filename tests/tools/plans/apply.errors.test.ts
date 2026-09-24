import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPlan } from "../../../src/tools/plans/apply.js";
import type { StoredPlan } from "../../../src/store/types.js";
import type { GraphClient } from "../../../src/graph/client.js";
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
});
