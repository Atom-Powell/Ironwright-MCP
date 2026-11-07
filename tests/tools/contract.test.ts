import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ALL_TOOLS } from "../../src/tools/registry.js";
import { SAFETY_SENTENCES, requiredSentence } from "../../src/tools/kinds.js";
import type { ToolDefinition } from "../../src/tools/types.js";

describe("safety sentences", () => {
  // Pinned as literals. Every other assertion derives the expected sentence from
  // this same constant, so rewriting one to "Safe to run." would keep the whole
  // suite green while gutting the description contract it exists to enforce.
  it("says exactly what each kind of tool does", () => {
    expect(SAFETY_SENTENCES.read).toBe("Read-only: this tool makes no changes and is safe to repeat.");
    expect(SAFETY_SENTENCES.plan).toBe(
      "Not read-only: this tool saves a plan for review. It makes no changes to the repository, and repeated calls create separate plans.",
    );
    expect(SAFETY_SENTENCES.destructiveWrite).toBe(
      "Destructive: this tool changes the repository when confirmed. It defaults to a dry run, and repeated calls are not idempotent.",
    );
    expect(SAFETY_SENTENCES.additiveWrite).toBe(
      "Not read-only: this tool creates missing items in the repository when confirmed. It defaults to a dry run and skips items that already exist.",
    );
    expect(SAFETY_SENTENCES.lifecycle).toBe(
      "Not read-only: this tool advances an assessment by one stage when its preconditions hold. It creates records and files only at paths the server computes, overwrites only files it created and only under an ETag precondition, refuses when the prior stage is not verified, and records every write in the assessment journal. It needs no confirm flag and is safe to retry: a stage already completed is reported, not repeated.",
    );
  });

  it("maps each kind to its own sentence", () => {
    expect(requiredSentence("read", false)).toBe(SAFETY_SENTENCES.read);
    expect(requiredSentence("plan", false)).toBe(SAFETY_SENTENCES.plan);
    expect(requiredSentence("write", true)).toBe(SAFETY_SENTENCES.destructiveWrite);
    expect(requiredSentence("write", false)).toBe(SAFETY_SENTENCES.additiveWrite);
    expect(requiredSentence("lifecycle", false)).toBe(SAFETY_SENTENCES.lifecycle);
  });
});

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
      if (tool.kind === "lifecycle") {
        expect(tool.annotations.destructiveHint).toBe(false);
        expect(tool.annotations.idempotentHint).toBe(true);
        expect(tool.annotations.openWorldHint).toBe(true);
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
      // `inputSchema` is a full schema rather than a raw shape, so a refined
      // tool's fields live on the wrapped object's `.innerType()` rather than
      // on the schema itself.
      const base = tool.inputSchema instanceof z.ZodEffects ? tool.inputSchema.innerType() : tool.inputSchema;
      if (!(base instanceof z.ZodObject)) throw new Error(`${tool.name} input schema must be an object`);

      for (const [field, schema] of Object.entries(base.shape)) {
        const description = (schema as z.ZodTypeAny).description;
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
  "generate_custom_plan",
  "execute_custom_plan",
  "replicate_template",
];

describe("tool surface completeness", () => {
  it("registers exactly the planned tools", () => {
    expect(ALL_TOOLS.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("stays inside the recommended per-agent tool ceiling", () => {
    // Microsoft's guidance is at most 25 to 30 tools per agent under a 128 hard
    // cap, and this server may share an agent with other MCP servers.
    expect(ALL_TOOLS.length).toBeLessThanOrEqual(25);
  });
});

/**
 * True only for a `ZodEffects`, the schema `.refine()` or `.superRefine()`
 * produce on top of an object schema. Named for what it detects rather than
 * for the rule that consumes it, so the ban below and its own non-vacuousness
 * proof can both ask the same question through one function instead of two
 * copies of the same `instanceof` check drifting apart.
 */
function isZodEffects(schema: z.ZodTypeAny): boolean {
  return schema instanceof z.ZodEffects;
}

/**
 * True when a tool either declares no handler-enforced cross-field constraint
 * or repeats that constraint verbatim in its description.
 *
 * Verbatim rather than paraphrased, because a paraphrase is a second
 * description of the same rule and the two drift. The check is one direction
 * only: a description may say more than `inputConstraints` does.
 */
function statesItsInputConstraints(tool: ToolDefinition): boolean {
  return tool.inputConstraints === undefined || tool.description.includes(tool.inputConstraints);
}

describe("input schema contract", () => {
  it("every tool's input schema is a plain object", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.inputSchema, `${tool.name} input schema must be an object`).toBeInstanceOf(z.ZodObject);
    }
  });

  it("no tool's input schema is a ZodEffects (a top-level refinement)", () => {
    // The plan that introduced the wider ToolDefinition.inputSchema type
    // assumed a refinement would only lose its constraint at the JSON Schema
    // boundary. Registering a fixture tool through buildServer proved
    // otherwise: MCP SDK 1.30.0's normalizeObjectSchema recognizes an object
    // schema only by a bare `.shape` property, which a ZodEffects keeps on
    // `.innerType()` instead, so listTools advertises such a tool as
    // {type: "object", properties: {}} and every field disappears, not just
    // the constraint. A tool a caller cannot see the fields of is worse than
    // one with no cross-field rule at all, so this bans the shape outright
    // rather than requiring it to be documented. See
    // tests/mcp/build-server.test.ts for the characterization test this rule
    // is built on, and src/tools/types.ts for where a handler-enforced
    // constraint belongs instead.
    for (const tool of ALL_TOOLS) {
      expect(
        isZodEffects(tool.inputSchema),
        `${tool.name} input schema is a ZodEffects, built with .refine() or .superRefine(). ` +
          "MCP SDK 1.30.0 cannot advertise its fields at listTools time (see the comment above " +
          "this loop), so enforce any cross-field constraint inside the handler's own parse " +
          "instead, and state it through inputConstraints and the description.",
      ).toBe(false);
    }
  });

  it("the ban actually fails a tool whose input schema is a ZodEffects", () => {
    // Without this fixture, the rule above passes on an empty search: no tool
    // in this phase carries a refinement, so the loop finding nothing proves
    // nothing about whether isZodEffects can tell a ZodEffects from a plain
    // object. Building one here and confirming the detector flags it is what
    // makes the rule's pass mean something.
    const bad: ToolDefinition = {
      name: "fixture_tool",
      kind: "read",
      title: "Fixture",
      description: "A fixture whose input schema is a refinement, which this project forbids.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z
        .object({ a: z.string().optional(), b: z.string().optional() })
        .refine((value) => value.a !== undefined || value.b !== undefined),
      outputSchema: { ok: z.boolean() },
    };
    expect(isZodEffects(bad.inputSchema)).toBe(true);
  });

  it("every tool that sets inputConstraints states them in its own description", () => {
    // The ban above sends an author to `inputConstraints` for a cross-field
    // rule the advertised schema cannot carry, and until this rule existed
    // nothing checked that the words ever reached the description. A tool
    // could set the field, say nothing in its prose, and leave every gate
    // green while a caller still had no way to predict the rejection.
    // No tool needs one today: phase 6b-1 dropped generate_move_plan's scope and scopeValue, the pair this rule was written for.
    for (const tool of ALL_TOOLS) {
      expect(
        statesItsInputConstraints(tool),
        `${tool.name} sets inputConstraints but its description does not contain that text. A constraint the ` +
          "advertised schema cannot express is invisible to a caller unless the prose says it.",
      ).toBe(true);
    }
  });

  it("that rule fails a tool whose constraint is missing from its description and passes one where it is present", () => {
    // No tool in the registry sets inputConstraints yet, so the loop above
    // passes on an empty search and proves nothing about whether the check can
    // tell the two cases apart. These two fixtures exercise both branches, the
    // way the ZodEffects ban's own fixture does.
    const constraint = "Give scopeValue whenever scope is client or deliverable.";
    const base: ToolDefinition = {
      name: "fixture_constrained_tool",
      kind: "read",
      title: "Fixture",
      description: "A fixture whose handler enforces a rule its advertised schema cannot express.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({ scope: z.string(), scopeValue: z.string().optional() }),
      outputSchema: { ok: z.boolean() },
      inputConstraints: constraint,
    };

    expect(statesItsInputConstraints(base)).toBe(false);
    expect(statesItsInputConstraints({ ...base, description: `${base.description} ${constraint}` })).toBe(true);
  });
});
