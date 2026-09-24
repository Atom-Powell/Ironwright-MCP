import { describe, expect, it } from "vitest";
import type { RepositoryFile } from "../../../src/domain/reconcile/index.js";
import { runGenerateCustomPlan } from "../../../src/tools/custom/generate.js";
import type { GenerateCustomPlanOutput } from "../../../src/tools/custom/output.js";
import { file, textOf } from "../rename/fixtures.js";
import { FEB_2025, FOLDERS, JAN_2025, PLAN_ID, customContext, customGraph, customSnapshot } from "./fixtures.js";

const PROFILE = "shared-docs";

async function refusedWith(steps: unknown[], files?: RepositoryFile[]) {
  const graph = customGraph(files);
  const context = customContext(graph, files === undefined ? customSnapshot() : customSnapshot(files, [...FOLDERS, "Bulk"]));
  const result = await runGenerateCustomPlan({ profileId: PROFILE, steps }, context, () => PLAN_ID);

  expect(result.isError).toBe(true);
  expect(await context.store.getPlan(PROFILE, PLAN_ID)).toBeUndefined();
  expect(graph.lookups).toEqual([]);
  return textOf(result);
}

describe("generate_custom_plan refusals", () => {
  it("refuses an unknown folder, naming it, the nearest existing folder and its children", async () => {
    const text = await refusedWith([{ selector: { folder: "/Client A/2025" }, moveTo: "/Client A/2027" }]);

    expect(text).toContain('"/Client A/2027"');
    expect(text).toContain('"Client A"');
    expect(text).toContain('"Client A/2025"');
    expect(text).toContain('"Client A/2026"');
    expect(text).toContain("No ETag was fetched");
    expect(text).toContain("No plan was saved.");
  });

  it("refuses an ambiguous setName, naming how many files it matched", async () => {
    const text = await refusedWith([
      { selector: { folder: "/Client A/2025", extensions: [".pdf"] }, rename: { setName: "Report.pdf" } },
    ]);

    expect(text).toContain("Step 1");
    expect(text).toContain("matched 2 files");
    expect(text).toContain("No plan was saved.");
  });

  it("refuses too many files, naming the total, the limit and each step's count", async () => {
    const bulk = [
      ...Array.from({ length: 70 }, (_v, i) => file(`Bulk/a-${String(i).padStart(3, "0")}.pdf`)),
      ...Array.from({ length: 40 }, (_v, i) => file(`Bulk/b-${String(i).padStart(3, "0")}.pdf`)),
    ];
    const text = await refusedWith(
      [
        { selector: { folder: "/Bulk", nameContains: "a-" }, moveTo: "/Archive" },
        { selector: { folder: "/Bulk", nameContains: "b-" }, moveTo: "/Archive" },
      ],
      bulk,
    );

    expect(text).toContain("110 files");
    expect(text).toContain("100");
    expect(text).toContain("step 1: 70");
    expect(text).toContain("step 2: 40");
    expect(text).toContain("No ETag was fetched");
    expect(text).toContain("No plan was saved.");
  });

  it("refuses a request where nothing matched, naming each step's zero", async () => {
    const text = await refusedWith([
      { selector: { folder: "/Client A/2025", extensions: [".xlsx"] }, moveTo: "/Archive" },
      { selector: { folder: "/Client A/2026", extensions: [".xlsx"] }, moveTo: "/Archive" },
    ]);

    expect(text).toContain("step 1: 0");
    expect(text).toContain("step 2: 0");
    expect(text).toContain("No plan was saved.");
  });

  it("refuses an invalid step, naming the step and the rule it breaks", async () => {
    const text = await refusedWith([
      { selector: { folder: "/Client A/2025" }, moveTo: "/Archive" },
      { selector: { folder: "/Client A/2026" } },
    ]);

    expect(text).toContain("Step 2");
    expect(text).toContain("neither moveTo nor rename");
    expect(text).toContain("No plan was saved.");
  });

  it("refuses an offset-less date-time, naming the step and the field", async () => {
    const text = await refusedWith([
      { selector: { folder: "/Client A/2025", modifiedAfter: "2025-01-01T00:00:00" }, moveTo: "/Archive" },
    ]);

    expect(text).toContain("Step 1");
    expect(text).toContain("modifiedAfter");
    expect(text).toContain('"2025-01-01T00:00:00"');
    expect(text).toContain("No plan was saved.");
  });

  it("refuses an unparseable date, naming the step and the field", async () => {
    const text = await refusedWith([
      { selector: { folder: "/Client A/2025" }, moveTo: "/Archive" },
      { selector: { folder: "/Client A/2026", modifiedBefore: "next Tuesday" }, moveTo: "/Archive" },
    ]);

    expect(text).toContain("Step 2");
    expect(text).toContain("modifiedBefore");
    expect(text).toContain('"next Tuesday"');
    expect(text).toContain("No plan was saved.");
  });
});

describe("generate_custom_plan exclusions", () => {
  it("stores a plan despite a file matched by two steps, lists that exclusion with its steps, and spends no lookup on it", async () => {
    const graph = customGraph();
    const context = customContext(graph);

    const result = await runGenerateCustomPlan(
      {
        profileId: PROFILE,
        steps: [
          { selector: { folder: "/Client A/2025", extensions: [".pdf"] }, moveTo: "/Archive/2025" },
          { selector: { folder: "/Client A/2025", nameEquals: "Jan report.pdf" }, rename: { addSuffix: " v2" } },
        ],
      },
      context,
      () => PLAN_ID,
    );
    const output = result.structuredContent as unknown as GenerateCustomPlanOutput;
    const stored = await context.store.getPlan(PROFILE, PLAN_ID);

    expect(result.isError).not.toBe(true);
    expect(stored?.items.map((item) => item.path)).toEqual([FEB_2025]);
    expect(stored?.excluded).toEqual([
      {
        path: JAN_2025,
        currentName: "Jan report.pdf",
        targetName: "Jan report.pdf",
        client: "",
        reason: "matched_by_multiple_steps",
        steps: [1, 2],
      },
    ]);
    expect(output.excluded).toEqual([
      {
        path: JAN_2025,
        currentName: "Jan report.pdf",
        targetName: "Jan report.pdf",
        reason: "matched_by_multiple_steps",
        steps: [1, 2],
      },
    ]);
    expect(output.perStep).toEqual([2, 1]);
    expect(output.etagLookupsIssued).toBe(1);
    expect(graph.lookups).toEqual([FEB_2025]);
    expect(textOf(result)).toContain(`excluded: ${JAN_2025} (matched_by_multiple_steps, steps 1, 2)`);
  });
});
