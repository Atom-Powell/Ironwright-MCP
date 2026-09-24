import { describe, expect, it } from "vitest";
import { runExecuteMovePlan } from "../../../src/tools/move/execute.js";
import type { ExecuteMovePlanOutput } from "../../../src/tools/move/output.js";
import { createFakeToolContext } from "../fake-context.js";
import { planWith, ITEM_A } from "../rename/fixtures.js";
import { AUG, MISPLACED_PATH, MOVE_ITEM, SEPT, TARGET_PATH, movePlanWith, movingLibraryGraphClient } from "./fixtures.js";

const PLAN_ID = "mov-2026-09-14-a1b2c3d4";
const outputOf = (r: Awaited<ReturnType<typeof runExecuteMovePlan>>) => r.structuredContent as unknown as ExecuteMovePlanOutput;

describe("execute_move_plan failures", () => {
  it("refuses a rename plan rather than applying it", async () => {
    const graph = movingLibraryGraphClient({}, []);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", { ...planWith([ITEM_A]), planId: PLAN_ID });

    const result = await runExecuteMovePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context);

    expect(result.isError).toBe(true);
    expect(result.content.map((c) => ("text" in c ? c.text : "")).join("")).toContain("execute_rename_plan");
    expect(graph.requests()).toBe(0);
  });

  it("refuses only the item edited since planning and still reports the plan", async () => {
    const graph = movingLibraryGraphClient({ [MISPLACED_PATH]: "etag-edited" }, [AUG, SEPT]);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", movePlanWith([MOVE_ITEM]));

    const output = outputOf(await runExecuteMovePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context));

    expect(output.counts.preconditionRefused).toBe(1);
    expect(graph.paths()).toEqual([MISPLACED_PATH]);
  });

  it("reports a target folder that vanished after planning as failed, since Graph's 400 names no cause", async () => {
    const graph = movingLibraryGraphClient({ [MISPLACED_PATH]: "etag-0" }, [AUG]);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", movePlanWith([MOVE_ITEM]));

    const output = outputOf(await runExecuteMovePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context));

    expect(output.counts.failed).toBe(1);
  });

  it("reports a file that arrived at the target after planning as target_name_taken and replaces nothing", async () => {
    const graph = movingLibraryGraphClient({ [MISPLACED_PATH]: "etag-0", [TARGET_PATH]: "occupant" }, [AUG, SEPT]);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", movePlanWith([MOVE_ITEM]));

    const output = outputOf(await runExecuteMovePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context));

    expect(output.counts.targetNameTaken).toBe(1);
    expect(graph.paths()).toEqual([MISPLACED_PATH, TARGET_PATH].sort());
  });

  it("refuses an unknown plan id without contacting Graph", async () => {
    const graph = movingLibraryGraphClient({}, []);
    const result = await runExecuteMovePlan({ profileId: "example", planId: "nope" }, createFakeToolContext({ graph }));

    expect(result.isError).toBe(true);
    expect(graph.requests()).toBe(0);
  });
});
