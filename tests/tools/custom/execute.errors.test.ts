import { describe, expect, it } from "vitest";
import { runExecuteCustomPlan } from "../../../src/tools/custom/execute.js";
import type { ExecuteCustomPlanOutput } from "../../../src/tools/custom/output.js";
import { createFakeToolContext } from "../fake-context.js";
import { ITEM_A, planWith } from "../rename/fixtures.js";
import { MOVE_ITEM, movePlanWith, movingLibraryGraphClient } from "../move/fixtures.js";
import { FEB_2025, FOLDERS, JAN_2025, JAN_ITEM, JAN_TARGET, PLAN_ID, customPlanWith } from "./fixtures.js";

const outputOf = (r: Awaited<ReturnType<typeof runExecuteCustomPlan>>) =>
  r.structuredContent as unknown as ExecuteCustomPlanOutput;

describe("execute_custom_plan failures", () => {
  it("refuses a rename plan rather than applying it", async () => {
    const graph = movingLibraryGraphClient({}, []);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", { ...planWith([ITEM_A]), planId: PLAN_ID });

    const result = await runExecuteCustomPlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context);

    expect(result.isError).toBe(true);
    expect(result.content.map((c) => ("text" in c ? c.text : "")).join("")).toContain("execute_rename_plan");
    expect(graph.requests()).toBe(0);
  });

  it("refuses a move plan rather than applying it", async () => {
    const graph = movingLibraryGraphClient({}, []);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", { ...movePlanWith([MOVE_ITEM]), planId: PLAN_ID });

    const result = await runExecuteCustomPlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context);

    expect(result.isError).toBe(true);
    expect(result.content.map((c) => ("text" in c ? c.text : "")).join("")).toContain("execute_move_plan");
    expect(graph.requests()).toBe(0);
  });

  it("refuses an unknown plan id without contacting Graph", async () => {
    const graph = movingLibraryGraphClient({}, []);
    const result = await runExecuteCustomPlan({ profileId: "example", planId: "nope" }, createFakeToolContext({ graph }));

    expect(result.isError).toBe(true);
    expect(graph.requests()).toBe(0);
  });

  it("refuses a stored custom plan whose excluded list holds a reason no custom plan can carry, before any write", async () => {
    // The store checks only that excluded is an array, so a row carrying a
    // foreign reason reaches the executor; the cast stands in for that row.
    const graph = movingLibraryGraphClient({ [JAN_2025]: "etag-0" }, FOLDERS);
    const context = createFakeToolContext({ graph });
    const excluded = [
      { path: FEB_2025, currentName: "Feb report.pdf", targetName: "Feb report.pdf", client: "", reason: "not_a_real_reason", steps: [1] },
    ] as unknown as Parameters<typeof customPlanWith>[1];
    await context.store.savePlan("example", customPlanWith([JAN_ITEM], excluded));

    const result = await runExecuteCustomPlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context);

    expect(result.isError).toBe(true);
    expect(result.content.map((c) => ("text" in c ? c.text : "")).join("")).toContain("not_a_real_reason");
    expect(graph.requests()).toBe(0);
  });

  it("refuses only the item edited since planning and still reports the plan", async () => {
    const graph = movingLibraryGraphClient({ [JAN_2025]: "etag-edited" }, FOLDERS);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", customPlanWith([JAN_ITEM]));

    const output = outputOf(await runExecuteCustomPlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context));

    expect(output.counts.preconditionRefused).toBe(1);
    expect(graph.paths()).toEqual([JAN_2025]);
  });

  it("reports a file that arrived at the target after planning as target_name_taken and replaces nothing", async () => {
    const graph = movingLibraryGraphClient({ [JAN_2025]: "etag-0", [JAN_TARGET]: "occupant" }, FOLDERS);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", customPlanWith([JAN_ITEM]));

    const output = outputOf(await runExecuteCustomPlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context));

    expect(output.counts.targetNameTaken).toBe(1);
    expect(graph.paths()).toEqual([JAN_2025, JAN_TARGET].sort());
  });
});
