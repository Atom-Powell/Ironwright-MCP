import { describe, expect, it } from "vitest";
import { runExecuteRenamePlan } from "../../../src/tools/rename/execute.js";
import { createFakeToolContext } from "../fake-context.js";
import type { ExecuteRenamePlanOutput } from "../../../src/tools/rename/output.js";
import { MalformedPlanEntityError } from "../../../src/store/types.js";
import type { StateStore } from "../../../src/store/types.js";
import { ITEM_A, ITEM_B, planWith, renamingGraphClient, storeWithFailingSavePlan } from "./fixtures.js";

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

    expect(output.counts.preconditionRefused).toBe(1);
    expect(output.counts.renamed).toBe(1);
    expect(output.results.find((entry) => entry.path === ITEM_A.path)?.outcome).toBe("precondition_refused");
    expect(output.results.find((entry) => entry.path === ITEM_B.path)?.outcome).toBe("renamed");
  });

  it("reports an item that is no longer there as not_found and keeps going, a case the fake can drive even though live Graph cannot reach it once If-Match is always sent", async () => {
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
    const graph = renamingGraphClient({ patchResponse: "item_without_etag", etagLookupStatus: 404 });
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
    const graph = renamingGraphClient({ patchResponse: "item_without_etag", etagLookupStatus: 404 });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const result = await runExecuteRenamePlan(
      { profileId: "example", planId: PLAN_ID, confirm: true },
      context,
      () => REVERSAL_ID,
    );

    expect(textOf(result)).toContain("refuse those items");
  });

  it("still reports a rename as renamed when the follow-up etag read fails outright", async () => {
    // The PATCH answers with no etag and the follow-up read fails with a 500,
    // not a 404: a bare exception from the etag lookup, not the "not found"
    // outcome the fixture above exercises. Either way, the rename itself
    // already happened and must not be reported as failed on account of a
    // problem discovered only after it landed.
    const graph = renamingGraphClient({ patchResponse: "item_without_etag", etagLookupStatus: 500 });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.results[0]?.outcome).toBe("renamed");
    expect(output.counts.renamed).toBe(1);
    expect(output.counts.failed).toBe(0);
    expect(output.reversalEntriesNotRefreshed).toBe(1);
    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.items[0]?.etag).toBe(ITEM_A.etag);
  });

  it("still reports a rename as renamed when saving the refreshed reversal entry fails", async () => {
    // The PATCH succeeds and returns a fresh etag, so no follow-up read is
    // needed at all; the only failure is the store call that persists that
    // etag into the reversal log. The first savePlan call is the reversal's
    // own initial write, which must succeed for there to be anything to roll
    // back with; the second is the per-item refresh this test makes fail.
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan("example", planWith([ITEM_A]));
    // Wrapped only now, after the forward plan is already stored, so the
    // counter that decides which call fails counts only the reversal writes
    // this run itself makes: call 1 is the initial reversal write, call 2 is
    // the per-item refresh this test makes fail.
    const failingStore = storeWithFailingSavePlan(context.store, 2);

    const output = outputOf(
      await runExecuteRenamePlan(
        { profileId: "example", planId: PLAN_ID, confirm: true },
        { ...context, store: failingStore },
        () => REVERSAL_ID,
      ),
    );

    expect(output.results[0]?.outcome).toBe("renamed");
    expect(output.counts.renamed).toBe(1);
    expect(output.counts.failed).toBe(0);
    expect(output.reversalEntriesNotRefreshed).toBe(1);
    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.items[0]?.etag).toBe(ITEM_A.etag);
  });
});

describe("a missing plan and a malformed one stay distinguishable", () => {
  it("gives an operator two different messages for wrong id versus damaged data", async () => {
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const brokenStore: StateStore = {
      ...context.store,
      getPlan: () => {
        throw new MalformedPlanEntityError(PLAN_ID, "items", "is not valid JSON");
      },
    };

    const missing = await runExecuteRenamePlan(
      { profileId: "example", planId: "rnm-2026-09-18-nosuch01" },
      context,
    );
    const malformed = await runExecuteRenamePlan(
      { profileId: "example", planId: PLAN_ID },
      { ...context, store: brokenStore },
    );

    expect(missing.isError).toBe(true);
    expect(malformed.isError).toBe(true);
    expect(textOf(missing)).toContain("is stored");
    expect(textOf(malformed)).toContain("cannot be read");
    // The two refusals must not read alike: one means the caller passed the
    // wrong id, the other means the stored data itself is damaged, and an
    // operator acting on the first by regenerating a plan would get nowhere
    // against the second.
    expect(textOf(missing)).not.toBe(textOf(malformed));
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

  it("refuses a move plan rather than applying it as a rename", async () => {
    const graph = renamingGraphClient();
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", { ...planWith([ITEM_A]), kind: "move" });

    const result = await runExecuteRenamePlan({ profileId: "example", planId: "rnm-2026-09-18-a1b2c3d4", confirm: true }, context);

    expect(result.isError).toBe(true);
    expect(result.content.map((c) => ("text" in c ? c.text : "")).join("")).toContain("execute_move_plan");
    expect(graph.calls).toEqual([]);
  });
});
