import { describe, expect, it } from "vitest";
import { runExecuteMovePlan } from "../../../src/tools/move/execute.js";
import type { ExecuteMovePlanOutput } from "../../../src/tools/move/output.js";
import { createFakeToolContext } from "../fake-context.js";
import { AUG, MISPLACED_PATH, MOVE_ITEM, SEPT, TARGET_PATH, movePlanWith, movingLibraryGraphClient } from "./fixtures.js";

const PLAN_ID = "mov-2026-09-14-a1b2c3d4";
const outputOf = (r: Awaited<ReturnType<typeof runExecuteMovePlan>>) => r.structuredContent as unknown as ExecuteMovePlanOutput;

describe("execute_move_plan", () => {
  it("previews without contacting Graph", async () => {
    const graph = movingLibraryGraphClient({ [MISPLACED_PATH]: "etag-0" }, [AUG, SEPT]);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", movePlanWith([MOVE_ITEM]));

    const output = outputOf(await runExecuteMovePlan({ profileId: "example", planId: PLAN_ID }, context));

    expect(output.dryRun).toBe(true);
    expect(output.counts.wouldMove).toBe(1);
    expect(graph.requests()).toBe(0);
  });

  it("moves the file and rolls it back through its own reversal plan", async () => {
    const graph = movingLibraryGraphClient({ [MISPLACED_PATH]: "etag-0" }, [AUG, SEPT]);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", movePlanWith([MOVE_ITEM]));

    const forward = outputOf(
      await runExecuteMovePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => "rev-1"),
    );
    expect(forward.counts.moved).toBe(1);
    expect(graph.paths()).toEqual([TARGET_PATH]);

    const back = outputOf(
      await runExecuteMovePlan({ profileId: "example", planId: "rev-1", confirm: true }, context, () => "rev-2"),
    );
    expect(back.reverses).toBe(PLAN_ID);
    expect(back.counts.moved).toBe(1);
    expect(graph.paths()).toEqual([MISPLACED_PATH]);
  });
});
