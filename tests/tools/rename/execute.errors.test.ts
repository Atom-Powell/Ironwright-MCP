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

function textOf(result: Awaited<ReturnType<typeof runExecuteRenamePlan>>): string {
  return result.content.map((entry) => ("text" in entry ? entry.text : "")).join("\n");
}

describe("per-item refusals", () => {
  it("skips only the item whose precondition failed and still applies the rest", async () => {
    const graph = renamingGraphClient({ patchStatuses: { [ITEM_A.path]: 412 } });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.counts.changedSincePlan).toBe(1);
    expect(output.counts.renamed).toBe(1);
    expect(output.results.find((entry) => entry.path === ITEM_A.path)?.outcome).toBe("changed_since_plan");
    expect(output.results.find((entry) => entry.path === ITEM_B.path)?.outcome).toBe("renamed");
  });

  it("reports an item that is no longer there as not_found and keeps going", async () => {
    const graph = renamingGraphClient({ patchStatuses: { [ITEM_A.path]: 404 } });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.counts.notFound).toBe(1);
    expect(output.counts.renamed).toBe(1);
  });

  it("records an unexpected Graph failure as failed and still applies the rest", async () => {
    // Abandoning the run would discard the report, which is the operator's
    // only account of which renames already applied; the reversal log alone
    // does not say which of its entries are live.
    const graph = renamingGraphClient({ patchStatuses: { [ITEM_A.path]: 500 } });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));

    const result = await runExecuteRenamePlan(
      { profileId: "example", planId: PLAN_ID, confirm: true },
      context,
      () => REVERSAL_ID,
    );
    const output = outputOf(result);

    expect(result.isError).toBeUndefined();
    expect(output.counts.failed).toBe(1);
    expect(output.counts.renamed).toBe(1);
  });

  it("leaves a reversal entry on its stale etag when no fresh one could be read, and counts it", async () => {
    // The PATCH answers with no etag and the follow-up read answers 404, which
    // is what someone renaming the file again between the two looks like.
    const graph = renamingGraphClient({ etagOnPatchResponse: false, etagLookupStatus: 404 });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.counts.renamed).toBe(1);
    expect(output.reversalEntriesNotRefreshed).toBe(1);
    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.items[0]?.etag).toBe(ITEM_A.etag);
  });

  it("says in its prose that an unrefreshed reversal entry will refuse rather than undo", async () => {
    const graph = renamingGraphClient({ etagOnPatchResponse: false, etagLookupStatus: 404 });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const result = await runExecuteRenamePlan(
      { profileId: "example", planId: PLAN_ID, confirm: true },
      context,
      () => REVERSAL_ID,
    );

    expect(textOf(result)).toContain("refuse those items");
  });
});

describe("refusals before anything is attempted", () => {
  it("refuses a plan id that is not stored, naming the profile and the tool that makes one", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });

    const result = await runExecuteRenamePlan(
      { profileId: "example", planId: "rnm-2026-09-18-nosuch01", confirm: true },
      context,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("rnm-2026-09-18-nosuch01");
    expect(textOf(result)).toContain("example");
    expect(textOf(result)).toContain("generate_rename_plan");
  });

  it("refuses an unknown profile through the shared failure mapper", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });

    const result = await runExecuteRenamePlan({ profileId: "nope", planId: PLAN_ID }, context);

    expect(result.isError).toBe(true);
  });
});
