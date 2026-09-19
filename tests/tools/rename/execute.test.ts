import { describe, expect, it } from "vitest";
import { runExecuteRenamePlan } from "../../../src/tools/rename/execute.js";
import { createFakeToolContext } from "../fake-context.js";
import type { ExecuteRenamePlanOutput } from "../../../src/tools/rename/output.js";
import { ITEM_A, ITEM_B, planWith, renamingGraphClient } from "./fixtures.js";

const PLAN_ID = "rnm-2026-09-18-a1b2c3d4";
const REVERSAL_ID = "rev-2026-09-18-ffffffff";

function outputOf(result: Awaited<ReturnType<typeof runExecuteRenamePlan>>): ExecuteRenamePlanOutput {
  return result.structuredContent as unknown as ExecuteRenamePlanOutput;
}

describe("execute_rename_plan dry run", () => {
  it("contacts Graph not at all and reports every item as would_rename", async () => {
    const graph = renamingGraphClient();
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));

    const output = outputOf(await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID }, context));

    expect(output.dryRun).toBe(true);
    expect(output.counts.wouldRename).toBe(2);
    expect(output.counts.renamed).toBe(0);
    expect(output.graphRequests).toBe(0);
    expect(graph.calls).toEqual([]);
  });

  it("writes no reversal log, since it changed nothing to reverse", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const output = outputOf(await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID }, context));

    expect(output.reversalPlanId).toBeUndefined();
  });

  it("says in its own prose that it checked no preconditions", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const result = await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID }, context);
    const text = result.content.map((entry) => ("text" in entry ? entry.text : "")).join("\n");

    expect(text).toContain("contacted Graph not at all");
  });

  it("carries the plan's own exclusions into the report", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan(
      "example",
      planWith(
        [ITEM_A],
        [
          {
            path: "2026/ACME/02-February/other.xlsx",
            currentName: "other.xlsx",
            targetName: "2026-02_ACME_MonthlyTraining.xlsx",
            client: "ACME",
            reason: "target_path_already_occupied",
          },
        ],
      ),
    );

    const output = outputOf(await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID }, context));

    expect(output.excludedCount).toBe(1);
    expect(output.excluded[0]?.reason).toBe("target_path_already_occupied");
  });
});

describe("execute_rename_plan confirmed run", () => {
  it("renames each item under its own if-match and reports what it did", async () => {
    const graph = renamingGraphClient();
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.dryRun).toBe(false);
    expect(output.counts.renamed).toBe(2);
    expect(graph.calls.map((call) => call.name)).toEqual([ITEM_A.targetName, ITEM_B.targetName]);
    expect(graph.calls.map((call) => call.ifMatch)).toEqual([ITEM_A.etag, ITEM_B.etag]);
    expect(output.graphRequests).toBe(2);
  });

  it("writes a reversal log that is a valid plan with the pairs inverted", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.reversalPlanId).toBe(REVERSAL_ID);
    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.reverses).toBe(PLAN_ID);
    expect(reversal?.items[0]?.path).toBe(ITEM_A.targetPath);
    expect(reversal?.items[0]?.currentName).toBe(ITEM_A.targetName);
    expect(reversal?.items[0]?.targetName).toBe(ITEM_A.currentName);
    expect(reversal?.items[0]?.targetPath).toBe(ITEM_A.path);
  });

  it("writes the reversal log BEFORE the first rename, so a crash mid-apply still has one", async () => {
    // Proven by ordering rather than asserted: the fake's first PATCH reads the
    // store, and the reversal must already be there when it does.
    const graph = renamingGraphClient();
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    let reversalExistedAtFirstPatch: boolean | undefined;
    const originalPatch = graph.patch.bind(graph);
    graph.patch = async <T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> => {
      reversalExistedAtFirstPatch ??= (await context.store.getPlan("example", REVERSAL_ID)) !== undefined;
      return originalPatch<T>(path, body, headers);
    };

    await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID);

    expect(reversalExistedAtFirstPatch).toBe(true);
  });

  it("gives each reversal entry the file's NEW etag, so replaying it is not refused on a stale precondition", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan("example", planWith([ITEM_A]));

    await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID);

    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.items[0]?.etag).not.toBe(ITEM_A.etag);
    expect(reversal?.items[0]?.etag).toMatch(/^"\{GUID\},\d+"$/);
  });

  it("falls back to a metadata read when the PATCH response carries no etag, and charges for it", async () => {
    const graph = renamingGraphClient({ etagOnPatchResponse: false });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.graphRequests).toBe(2);
    expect(output.reversalEntriesNotRefreshed).toBe(0);
    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.items[0]?.etag).not.toBe(ITEM_A.etag);
  });
});
