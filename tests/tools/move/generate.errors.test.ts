import { describe, expect, it } from "vitest";
import { runGenerateMovePlan } from "../../../src/tools/move/generate.js";
import type { GenerateMovePlanOutput } from "../../../src/tools/move/output.js";
import { contextWith, etagGraphClient, workbookFixture } from "../rename/fixtures.js";
import { AUG, MISPLACED_PATH, snapshotWithMisplacedFile } from "./fixtures.js";

async function generate(context: Parameters<typeof runGenerateMovePlan>[1]) {
  return runGenerateMovePlan({ profileId: "example" }, context, () => Promise.resolve(workbookFixture()), () => "mov-1");
}

describe("generate_move_plan exclusions", () => {
  it("excludes a file whose target folder is absent and spends no etag lookup on it", async () => {
    const graph = etagGraphClient({});
    const context = contextWith(graph, snapshotWithMisplacedFile(["2026", "2026/ACME", AUG]));

    const output = (await generate(context)).structuredContent as unknown as GenerateMovePlanOutput;

    expect(output.itemCount).toBe(0);
    expect(output.excluded[0]).toMatchObject({ path: MISPLACED_PATH, reason: "target_folder_absent" });
    expect(graph.lookups).toEqual([]);
  });

  it("excludes a file that is gone by plan time", async () => {
    const context = contextWith(etagGraphClient({ [MISPLACED_PATH]: 404 }), snapshotWithMisplacedFile());

    const output = (await generate(context)).structuredContent as unknown as GenerateMovePlanOutput;

    expect(output.excluded[0]).toMatchObject({ reason: "file_not_found_at_plan_time" });
  });
});
