import { describe, expect, it } from "vitest";
import { runGenerateCustomPlan } from "../../../src/tools/custom/generate.js";
import type { GenerateCustomPlanOutput } from "../../../src/tools/custom/output.js";
import { textOf } from "../rename/fixtures.js";
import { FEB_2025, JAN_2025, MOVE_PDFS_STEPS, PLAN_ID, customContext, customGraph } from "./fixtures.js";

async function generate(context: Parameters<typeof runGenerateCustomPlan>[1], profileId: string) {
  return runGenerateCustomPlan({ profileId, steps: MOVE_PDFS_STEPS }, context, () => PLAN_ID);
}

function outputOf(result: Awaited<ReturnType<typeof generate>>): GenerateCustomPlanOutput {
  return result.structuredContent as unknown as GenerateCustomPlanOutput;
}

const EXPECTED_ITEMS = [
  {
    path: FEB_2025,
    currentName: "Feb report.pdf",
    targetName: "Feb report.pdf",
    targetPath: "Archive/2025/Feb report.pdf",
    step: 1,
  },
  {
    path: JAN_2025,
    currentName: "Jan report.pdf",
    targetName: "Jan report.pdf",
    targetPath: "Archive/2025/Jan report.pdf",
    step: 1,
  },
];

describe("generate_custom_plan", () => {
  it("plans a step moving PDFs between folders for the library profile and stores it as kind custom", async () => {
    const graph = customGraph();
    const context = customContext(graph);

    const result = await generate(context, "shared-docs");
    const output = outputOf(result);
    const stored = await context.store.getPlan("shared-docs", PLAN_ID);

    expect(result.isError).not.toBe(true);
    expect(stored?.kind).toBe("custom");
    expect(stored?.steps).toEqual(MOVE_PDFS_STEPS);
    expect(stored?.items.map((item) => item.step)).toEqual([1, 1]);
    expect(stored?.items.map((item) => item.client)).toEqual(["", ""]);
    expect(output.items).toEqual(EXPECTED_ITEMS);
    expect(output.perStep).toEqual([2]);
    expect(output.etagLookupsIssued).toBe(2);
    expect(graph.lookups.sort()).toEqual([FEB_2025, JAN_2025]);
  });

  it("plans the same request for the compliance profile", async () => {
    const context = customContext(customGraph());

    const output = outputOf(await generate(context, "example"));
    const stored = await context.store.getPlan("example", PLAN_ID);

    expect(stored?.kind).toBe("custom");
    expect(output.profileId).toBe("example");
    expect(output.items).toEqual(EXPECTED_ITEMS);
    expect(output.perStep).toEqual([2]);
  });

  it("names each move, the plan id, and ends pointing at execute_custom_plan with the dry-run default", async () => {
    const text = textOf(await generate(customContext(customGraph()), "shared-docs"));
    const lines = text.split("\n");

    expect(text).toContain(`${FEB_2025} -> Archive/2025/Feb report.pdf`);
    expect(text).toContain(`${JAN_2025} -> Archive/2025/Jan report.pdf`);
    expect(text).toContain(PLAN_ID);
    expect(lines[lines.length - 1]).toBe(
      "Review this plan, then apply it with execute_custom_plan. It runs as a dry run unless confirm is true.",
    );
  });
});
