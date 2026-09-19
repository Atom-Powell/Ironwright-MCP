import { describe, expect, it } from "vitest";
import { runGenerateRenamePlan } from "../../../src/tools/rename/generate.js";
import { MAX_PLAN_ITEMS, type GenerateRenamePlanOutput } from "../../../src/tools/rename/output.js";
import {
  MISNAMED_PATH,
  contextWith,
  etagGraphClient,
  noEtag,
  snapshotWhereTargetIsOccupied,
  snapshotWithMisnamedFile,
  snapshotWithMisnamedFilePerClient,
  textOf,
  workbookFixture,
} from "./fixtures.js";

function outputOf(result: Awaited<ReturnType<typeof runGenerateRenamePlan>>): GenerateRenamePlanOutput {
  return result.structuredContent as unknown as GenerateRenamePlanOutput;
}

describe("exclusions rather than attempts", () => {
  it("excludes a candidate whose canonical path is already occupied", async () => {
    // No lookup is expected for it, so the fake carries no fixture: reaching
    // Graph for an excluded item would fail this test rather than pass it.
    const graph = etagGraphClient({});
    const context = contextWith(graph, snapshotWhereTargetIsOccupied());

    const output = outputOf(
      await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture()),
    );

    expect(output.itemCount).toBe(0);
    expect(output.excludedCount).toBe(1);
    expect(output.excluded[0]?.reason).toBe("target_path_already_occupied");
    expect(graph.requests()).toBe(0);
  });

  it("excludes a candidate whose file is gone by plan time", async () => {
    const graph = etagGraphClient({ [MISNAMED_PATH]: 404 });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const output = outputOf(
      await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture()),
    );

    expect(output.itemCount).toBe(0);
    expect(output.excluded[0]?.reason).toBe("file_not_found_at_plan_time");
  });

  it("excludes a candidate whose item carries no etag rather than writing it unguarded", async () => {
    const graph = etagGraphClient({ [MISNAMED_PATH]: noEtag("item_without_etag") });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const output = outputOf(
      await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture()),
    );

    expect(output.itemCount).toBe(0);
    expect(output.excluded[0]?.reason).toBe("no_etag_available");
  });
});

describe("refusals", () => {
  it("refuses a plan larger than one stored plan holds, before spending a single lookup", async () => {
    const clients = Array.from({ length: MAX_PLAN_ITEMS + 1 }, (_value, index) => `ACME${String(index).padStart(4, "0")}`);
    const graph = etagGraphClient({});
    const context = contextWith(graph, snapshotWithMisnamedFilePerClient(clients));

    const result = await runGenerateRenamePlan({ profileId: "example" }, context, async () =>
      workbookFixture(clients),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(String(MAX_PLAN_ITEMS));
    expect(textOf(result)).toContain("clients");
    expect(graph.requests()).toBe(0);
  });

  it("reports an unknown profile through the shared failure mapper", async () => {
    const context = contextWith(etagGraphClient({}), snapshotWithMisnamedFile());

    const result = await runGenerateRenamePlan({ profileId: "nope" }, context, async () => workbookFixture());

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("nope");
  });

  it("propagates an unexpected Graph failure from a lookup as a tool error, not as an exclusion", async () => {
    // Only 404 means "gone". A 500 is a failure this call cannot interpret,
    // and turning it into an exclusion would tell the operator the file has no
    // etag, which this code did not observe.
    const graph = etagGraphClient({ [MISNAMED_PATH]: 500 });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const result = await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture());

    expect(result.isError).toBe(true);
  });

  it("saves no plan at all when a lookup fails outright", async () => {
    // The id generator is injected so this assertion is about the plan that
    // WOULD have been saved. Without it the test would look up an id nothing
    // ever generated, and would pass no matter what the handler did.
    const graph = etagGraphClient({ [MISNAMED_PATH]: 500 });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    await runGenerateRenamePlan(
      { profileId: "example" },
      context,
      async () => workbookFixture(),
      () => "rnm-2026-09-14-deadbeef",
    );

    await expect(context.store.getPlan("example", "rnm-2026-09-14-deadbeef")).resolves.toBeUndefined();
  });
});
