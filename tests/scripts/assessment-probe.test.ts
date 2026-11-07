// tests/scripts/assessment-probe.test.ts
import { describe, expect, it } from "vitest";
import { listDefinitions } from "../../scripts/assessment-probe/lists.js";

describe("probe list definitions", () => {
  it("defines the three lists the assessment module reads and writes, under the prefix", () => {
    const lists = listDefinitions("IW Probe");
    expect(lists.map((l) => l.displayName)).toEqual(["IW Probe Vendors", "IW Probe Assessments", "IW Probe Findings"]);
  });

  it("gives the assessment list a text AssessmentId column, which the ID stage writes back into", () => {
    const assessments = listDefinitions("IW Probe")[1]!.body as { columns: Array<{ name: string; text?: unknown }> };
    const column = assessments.columns.find((c) => c.name === "AssessmentId");
    expect(column).toBeDefined();
    expect(column!.text).toEqual({});
  });

  it("uses the generic list template for every list", () => {
    for (const list of listDefinitions("X")) {
      expect((list.body as { list: { template: string } }).list.template).toBe("genericList");
    }
  });
});
