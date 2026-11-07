import { describe, expect, it } from "vitest";
import { ALL_MODULES } from "../../src/modules/index.js";
import { ALL_TOOLS } from "../../src/tools/registry.js";

describe("domain modules", () => {
  it("registers compliance, library and assessment, each with a distinct kind", () => {
    expect(ALL_MODULES.map((m) => m.kind)).toEqual(["compliance", "library", "assessment"]);
  });

  it("owns every tool exactly once across modules", () => {
    const names = ALL_MODULES.flatMap((m) => m.tools.map((t) => t.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it("is the source of the registry's tool list, in module order", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toEqual(ALL_MODULES.flatMap((m) => m.tools.map((t) => t.name)));
  });

  it("keeps the twelve tools that existed before modules did, under the same names", () => {
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "inventory_tree", "describe_workbook", "reconcile_workbook_vs_repository", "query_repository", "validate_structure",
        "generate_rename_plan", "execute_rename_plan", "generate_move_plan", "execute_move_plan",
        "generate_custom_plan", "execute_custom_plan", "replicate_template",
      ].sort(),
    );
  });
});
