import { describe, expect, it } from "vitest";
import { runExecuteRenamePlan } from "../../../src/tools/rename/execute.js";
import { createFakeToolContext } from "../fake-context.js";
import { MAX_PLAN_ITEMS_LISTED, type ExecuteRenamePlanOutput } from "../../../src/tools/rename/output.js";
import { ITEM_A, ITEM_B, libraryGraphClient, manyRenameItems, planWith, renamingGraphClient } from "./fixtures.js";

const PLAN_ID = "rnm-2026-09-18-a1b2c3d4";
const REVERSAL_ID = "rev-2026-09-18-ffffffff";
const ROLLBACK_REVERSAL_ID = "rev-2026-09-18-eeeeeeee";

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
    expect(output.graphOperationsIssued).toBe(0);
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

  it("computes counts over the complete set before the listing is truncated", async () => {
    // A plan far larger than MAX_PLAN_ITEMS_LISTED, kept well under the store's
    // character cap, so this proves counts.wouldRename reflects the whole plan
    // rather than only the sliced results the listing shows.
    const itemCount = MAX_PLAN_ITEMS_LISTED + 5;
    const context = createFakeToolContext({ graph: renamingGraphClient() });
    await context.store.savePlan("example", planWith(manyRenameItems(itemCount)));

    const output = outputOf(await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID }, context));

    expect(output.resultCount).toBe(itemCount);
    expect(output.results).toHaveLength(MAX_PLAN_ITEMS_LISTED);
    expect(output.resultsOmitted).toBe(itemCount - MAX_PLAN_ITEMS_LISTED);
    expect(output.counts.wouldRename).toBe(itemCount);
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
    expect(output.graphOperationsIssued).toBe(2);
  });

  it("reports the drive it actually wrote to, not a library name it never read", async () => {
    // A plan carries the drive it was generated against. If a profile's
    // identity.library is changed afterwards and this older plan is then
    // executed, the renames still land on the drive the plan names, and under
    // Sites.Selected both drives are writable. Naming the profile's current
    // library in the report would name a library this call did not touch.
    const graph = renamingGraphClient();
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", { ...planWith([ITEM_A]), driveId: "drive-the-plan-was-made-against" });

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.driveId).toBe("drive-the-plan-was-made-against");
    expect(graph.calls[0]?.path).toContain("drive-the-plan-was-made-against");
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
    const graph = renamingGraphClient({ patchResponse: "item_without_etag" });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.graphOperationsIssued).toBe(2);
    expect(output.reversalEntriesNotRefreshed).toBe(0);
    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.items[0]?.etag).not.toBe(ITEM_A.etag);
  });

  // The two below cover the way a PATCH most plausibly carries no etag: Graph
  // answers 204 with no body at all, which the Graph client hands back as
  // `undefined`, not as an empty object. The fallback branch above existed for
  // exactly this case and was unreachable for it, because reading `.eTag` off
  // `undefined` threw first and the PATCH error boundary reported the item as
  // failed although the file had been renamed.
  it("treats a PATCH answered with an empty body as a rename and reaches the fallback read", async () => {
    const graph = renamingGraphClient({ patchResponse: "empty_body" });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    expect(output.results[0]?.outcome).toBe("renamed");
    expect(output.counts.failed).toBe(0);
    expect(output.graphOperationsIssued).toBe(2);
    expect(output.reversalEntriesNotRefreshed).toBe(0);
    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.items[0]?.etag).not.toBe(ITEM_A.etag);
  });

  it("reports a rename whose empty PATCH body and unreadable follow-up left the reversal entry stale", async () => {
    const graph = renamingGraphClient({ patchResponse: "empty_body", etagLookupStatus: 404 });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A]));

    const output = outputOf(
      await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID),
    );

    // Renamed, and the reversal entry openly stale, is the honest account of
    // this situation. Reporting it as failed, which is what the crash produced,
    // told an operator the opposite of what had happened to their file.
    expect(output.results[0]?.outcome).toBe("renamed");
    expect(output.reversalEntriesNotRefreshed).toBe(1);
    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    expect(reversal?.items[0]?.etag).toBe(ITEM_A.etag);
  });
});

/**
 * The reversal log's own usefulness, which every other test in this file
 * approaches by asserting the plan's contents rather than by using it.
 *
 * That gap let a real defect sit unpinned: writing each item's fresh etag into
 * `reversal.items[0]` instead of `reversal.items[index]` left the whole suite
 * green, while on a multi-item plan it gives entry zero the last item's etag
 * and leaves every other entry stale. A rollback then refuses every item and
 * reports a clean run having undone nothing, which is the silently-useless
 * failure the design spec names.
 */
describe("the reversal log as something that is actually replayed", () => {
  it("gives each reversal entry the fresh etag of its own file, not another item's", async () => {
    const graph = libraryGraphClient({ [ITEM_A.path]: ITEM_A.etag, [ITEM_B.path]: ITEM_B.etag });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));

    await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID);

    const reversal = await context.store.getPlan("example", REVERSAL_ID);
    const entries = reversal?.items ?? [];
    expect(entries).toHaveLength(2);
    // Each entry's path is where its file now sits, and the fake stamps an etag
    // naming the path it belongs to, so this asserts alignment rather than only
    // that the two etags differ. An entry carrying another file's etag is what
    // the off-by-index defect produces.
    for (const entry of entries) {
      expect(entry.etag).toBe(graph.etagAt(entry.path));
    }
    expect(entries[0]?.etag).not.toBe(entries[1]?.etag);
    expect(entries[0]?.etag).not.toBe(ITEM_A.etag);
    expect(entries[1]?.etag).not.toBe(ITEM_B.etag);
  });

  it("puts the library back where it started when the reversal plan is executed", async () => {
    const graph = libraryGraphClient({ [ITEM_A.path]: ITEM_A.etag, [ITEM_B.path]: ITEM_B.etag });
    const context = createFakeToolContext({ graph });
    await context.store.savePlan("example", planWith([ITEM_A, ITEM_B]));
    const before = graph.paths();

    await runExecuteRenamePlan({ profileId: "example", planId: PLAN_ID, confirm: true }, context, () => REVERSAL_ID);
    expect(graph.paths()).toEqual([ITEM_A.targetPath, ITEM_B.targetPath].sort());

    const rollback = outputOf(
      await runExecuteRenamePlan(
        { profileId: "example", planId: REVERSAL_ID, confirm: true },
        context,
        () => ROLLBACK_REVERSAL_ID,
      ),
    );

    expect(rollback.counts.renamed).toBe(2);
    expect(rollback.counts.preconditionRefused).toBe(0);
    expect(rollback.reverses).toBe(PLAN_ID);
    expect(graph.paths()).toEqual(before);
  });
});
