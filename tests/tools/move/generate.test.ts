import { describe, expect, it } from "vitest";
import { runGenerateMovePlan } from "../../../src/tools/move/generate.js";
import type { GenerateMovePlanOutput } from "../../../src/tools/move/output.js";
import { contextWith, etagGraphClient, textOf, workbookFixture } from "../rename/fixtures.js";
import { BOTH_WRONG_PATH, CANONICAL_NAME, MISPLACED_PATH, TARGET_PATH, snapshotWithBothWrong, snapshotWithMisplacedFile } from "./fixtures.js";

const PLAN_ID = "mov-2026-09-14-a1b2c3d4";

async function generate(context: Parameters<typeof runGenerateMovePlan>[1], input: unknown = { profileId: "example" }) {
  return runGenerateMovePlan(input, context, () => Promise.resolve(workbookFixture()), () => PLAN_ID);
}

function outputOf(result: Awaited<ReturnType<typeof generate>>): GenerateMovePlanOutput {
  return result.structuredContent as unknown as GenerateMovePlanOutput;
}

describe("generate_move_plan", () => {
  it("plans a misplaced file into its canonical folder and persists the plan as kind move", async () => {
    const context = contextWith(etagGraphClient({ [MISPLACED_PATH]: '"{GUID},3"' }), snapshotWithMisplacedFile());

    const output = outputOf(await generate(context));
    const stored = await context.store.getPlan("example", PLAN_ID);

    expect(output.items).toEqual([
      { path: MISPLACED_PATH, currentName: CANONICAL_NAME, targetName: CANONICAL_NAME, targetPath: TARGET_PATH, client: "ACME" },
    ]);
    expect(stored?.kind).toBe("move");
    expect(stored?.items[0]?.etag).toBe('"{GUID},3"');
    expect(output.etagLookupsIssued).toBe(1);
  });

  it("plans a misnamed and misplaced file as one item that changes folder and name", async () => {
    const context = contextWith(etagGraphClient({ [BOTH_WRONG_PATH]: '"{GUID},3"' }), snapshotWithBothWrong());

    const output = outputOf(await generate(context));

    expect(output.items[0]).toMatchObject({ path: BOTH_WRONG_PATH, targetName: CANONICAL_NAME, targetPath: TARGET_PATH });
  });

  it("points the reader at execute_move_plan", async () => {
    const context = contextWith(etagGraphClient({ [MISPLACED_PATH]: '"{GUID},3"' }), snapshotWithMisplacedFile());

    expect(textOf(await generate(context))).toContain("execute_move_plan");
  });
});
