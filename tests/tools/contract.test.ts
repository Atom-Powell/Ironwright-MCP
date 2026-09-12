import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../../src/tools/registry.js";
import { requiredSentence } from "../../src/tools/kinds.js";

describe("tool contract", () => {
  it("registers at least one tool", () => {
    expect(ALL_TOOLS.length).toBeGreaterThan(0);
  });

  it.each(ALL_TOOLS)("$name uses snake_case", (tool) => {
    expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it.each(ALL_TOOLS)("$name sets all four annotations", (tool) => {
    expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
    expect(typeof tool.annotations.destructiveHint).toBe("boolean");
    expect(typeof tool.annotations.idempotentHint).toBe("boolean");
    expect(typeof tool.annotations.openWorldHint).toBe("boolean");
  });

  it.each(ALL_TOOLS)(
    "$name has annotations consistent with its kind",
    (tool) => {
      if (tool.kind === "read") {
        expect(tool.annotations.readOnlyHint).toBe(true);
        expect(tool.annotations.destructiveHint).toBe(false);
      } else {
        expect(tool.annotations.readOnlyHint).toBe(false);
      }
      if (tool.kind === "plan") {
        expect(tool.annotations.destructiveHint).toBe(false);
      }
    },
  );

  it.each(ALL_TOOLS)(
    "$name states its safety status in the description prose",
    (tool) => {
      // An automated survey of 856 published MCP tools found 97 percent had at
      // least one description defect, most commonly not stating read-only or
      // destructive status. A name implying safety is not a description saying it.
      expect(tool.description).toContain(requiredSentence(tool.kind, tool.annotations.destructiveHint));
    },
  );

  it.each(ALL_TOOLS)("$name declares an output schema", (tool) => {
    expect(Object.keys(tool.outputSchema).length).toBeGreaterThan(0);
  });

  it.each(ALL_TOOLS)(
    "$name describes every input field with an example",
    (tool) => {
      for (const [field, schema] of Object.entries(tool.inputSchema)) {
        const description = schema.description;
        expect(description, `${tool.name}.${field} has no description`).toBeDefined();
        expect(description, `${tool.name}.${field} description gives no example`).toMatch(/for example/i);
      }
    },
  );

  it("has no duplicate tool names", () => {
    const names = ALL_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

const EXPECTED_TOOL_NAMES = [
  "inventory_tree",
  "describe_workbook",
  "reconcile_workbook_vs_repository",
  "query_repository",
  "validate_structure",
  "generate_rename_plan",
  "execute_rename_plan",
  "generate_move_plan",
  "execute_move_plan",
  "replicate_template",
];

describe("tool surface completeness", () => {
  it("registers exactly the ten planned tools", () => {
    expect(ALL_TOOLS.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("stays inside the recommended per-agent tool ceiling", () => {
    // Microsoft's guidance is at most 25 to 30 tools per agent under a 128 hard
    // cap, and this server may share an agent with other MCP servers.
    expect(ALL_TOOLS.length).toBeLessThanOrEqual(25);
  });
});
