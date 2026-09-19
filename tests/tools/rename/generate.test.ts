import { describe, expect, it } from "vitest";
import { runGenerateRenamePlan } from "../../../src/tools/rename/generate.js";
import type { GenerateRenamePlanOutput } from "../../../src/tools/rename/output.js";
import {
  CANONICAL_NAME,
  CANONICAL_PATH,
  MISNAMED_PATH,
  contextWith,
  etagGraphClient,
  misnamedPathFor,
  snapshotWithMisnamedFile,
  snapshotWithMisnamedFilePerClient,
  workbookFixture,
} from "./fixtures.js";

function outputOf(result: Awaited<ReturnType<typeof runGenerateRenamePlan>>): GenerateRenamePlanOutput {
  return result.structuredContent as unknown as GenerateRenamePlanOutput;
}

describe("generate_rename_plan", () => {
  it("persists a plan pairing the misnamed file with its canonical name and a freshly fetched etag", async () => {
    const graph = etagGraphClient({ [MISNAMED_PATH]: '"{GUID},4"' });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const result = await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture());
    const output = outputOf(result);

    expect(result.isError).toBeUndefined();
    expect(output.itemCount).toBe(1);
    expect(output.items[0]?.path).toBe(MISNAMED_PATH);
    expect(output.items[0]?.targetName).toBe(CANONICAL_NAME);
    expect(output.items[0]?.targetPath).toBe(CANONICAL_PATH);
    expect(output.items[0]?.client).toBe("ACME");

    const stored = await context.store.getPlan("example", output.planId);
    expect(stored?.kind).toBe("rename");
    expect(stored?.driveId).toBe("drive-1");
    expect(stored?.reverses).toBeUndefined();
    expect(stored?.items[0]?.etag).toBe('"{GUID},4"');
  });

  it("uses the etag it fetched, not the one the inventory recorded", async () => {
    // The snapshot's own file carries "inventory-etag". A plan built on that
    // would refuse any change since the last scan rather than any change since
    // the plan a human read.
    const graph = etagGraphClient({ [MISNAMED_PATH]: '"{GUID},4"' });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const result = await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture());
    const stored = await context.store.getPlan("example", outputOf(result).planId);

    expect(stored?.items[0]?.etag).not.toBe("inventory-etag");
  });

  it("charges exactly one etag lookup per candidate and says so", async () => {
    const graph = etagGraphClient({ [MISNAMED_PATH]: '"{GUID},4"' });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const output = outputOf(
      await runGenerateRenamePlan({ profileId: "example" }, context, async () => workbookFixture()),
    );

    expect(graph.lookups).toEqual([MISNAMED_PATH]);
    expect(output.etagLookupGraphRequests).toBe(1);
  });

  it("narrows the plan to the clients it was asked about", async () => {
    const clients = ["ACME", "BETACO"];
    const graph = etagGraphClient({
      [misnamedPathFor("ACME")]: '"{GUID},4"',
      [misnamedPathFor("BETACO")]: '"{GUID},5"',
    });
    const context = contextWith(graph, snapshotWithMisnamedFilePerClient(clients));

    const output = outputOf(
      await runGenerateRenamePlan({ profileId: "example", clients: ["ACME"] }, context, async () =>
        workbookFixture(clients),
      ),
    );

    expect(output.itemCount).toBe(1);
    expect(output.items[0]?.client).toBe("ACME");
    // Scoping happens after pairing, so only the in-scope candidate was fetched.
    expect(graph.lookups).toEqual([misnamedPathFor("ACME")]);
  });

  it("names plans with a prefix and date a caller can predict", async () => {
    const graph = etagGraphClient({ [MISNAMED_PATH]: '"{GUID},4"' });
    const context = contextWith(graph, snapshotWithMisnamedFile());

    const output = outputOf(
      await runGenerateRenamePlan(
        { profileId: "example" },
        context,
        async () => workbookFixture(),
        () => "rnm-2026-09-14-deadbeef",
      ),
    );

    expect(output.planId).toBe("rnm-2026-09-14-deadbeef");
  });
});
