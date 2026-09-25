import { describe, expect, it } from "vitest";
import { runExecuteCustomPlan } from "../../../src/tools/custom/execute.js";
import type { ExecuteCustomPlanOutput } from "../../../src/tools/custom/output.js";
import { createFakeToolContext } from "../fake-context.js";
import { movingLibraryGraphClient } from "../move/fixtures.js";
import {
  FEB_2025,
  FEB_ITEM,
  FEB_TARGET,
  FOLDERS,
  JAN_2025,
  JAN_ITEM,
  JAN_TARGET,
  PLAN_ID,
  customPlanWith,
} from "./fixtures.js";

const outputOf = (r: Awaited<ReturnType<typeof runExecuteCustomPlan>>) =>
  r.structuredContent as unknown as ExecuteCustomPlanOutput;

describe("execute_custom_plan", () => {
  it("previews without contacting Graph", async () => {
    const graph = movingLibraryGraphClient({ [JAN_2025]: "etag-0", [FEB_2025]: "etag-0" }, FOLDERS);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", customPlanWith([JAN_ITEM, FEB_ITEM]));

    const output = outputOf(await runExecuteCustomPlan({ profileId: "example", planId: PLAN_ID }, context));

    expect(output.dryRun).toBe(true);
    expect(output.counts.wouldApply).toBe(2);
    expect(output.results.every((result) => result.outcome === "would_apply")).toBe(true);
    expect(graph.requests()).toBe(0);
  });

  it("moves and renames the files, and rolls them back through their own reversal plan", async () => {
    const graph = movingLibraryGraphClient({ [JAN_2025]: "etag-0", [FEB_2025]: "etag-0" }, FOLDERS);
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", customPlanWith([JAN_ITEM, FEB_ITEM]));

    const forward = outputOf(
      await runExecuteCustomPlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => "rev-1"),
    );
    expect(forward.counts.applied).toBe(2);
    // step carried through on the forward run, since these items were
    // produced by the operator's own step 1.
    expect(forward.results.every((result) => result.step === 1)).toBe(true);
    expect(graph.paths()).toEqual([FEB_TARGET, JAN_TARGET].sort());

    const back = outputOf(
      await runExecuteCustomPlan({ profileId: "example", planId: "rev-1", confirm: true }, context, () => "rev-2"),
    );
    expect(back.reverses).toBe(PLAN_ID);
    expect(back.counts.applied).toBe(2);
    // reversalItemsFor does not carry step forward, since a reversal item was
    // not produced by any of the operator's own steps.
    expect(back.results.every((result) => result.step === undefined)).toBe(true);
    expect(graph.paths()).toEqual([FEB_2025, JAN_2025].sort());
  });
});
