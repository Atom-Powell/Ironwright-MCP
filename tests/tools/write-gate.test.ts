import { describe, expect, it } from "vitest";
import { ALL_TOOLS, selectTools } from "../../src/tools/registry.js";
import type { ToolDefinition } from "../../src/tools/types.js";
import { loadConfig } from "../../src/server/config.js";

describe("selectTools", () => {
  it("omits every write tool when writes are disabled", () => {
    const selected = selectTools(false);
    expect(selected.some((tool) => tool.kind === "write")).toBe(false);
  });

  it("keeps plan tools when writes are disabled, since a plan is reviewable on its own", () => {
    const selected = selectTools(false);
    expect(selected.filter((tool) => tool.kind === "plan").length).toBeGreaterThan(0);
  });

  it("omits lifecycle tools when writes are disabled, since they advance state", () => {
    const lifecycleFixture = { ...ALL_TOOLS[0], name: "fixture_lifecycle", kind: "lifecycle" } as ToolDefinition;
    expect(selectTools(false, [lifecycleFixture])).toEqual([]);
    expect(selectTools(true, [lifecycleFixture])).toContain(lifecycleFixture);
  });

  it("keeps every tool when writes are enabled", () => {
    expect(selectTools(true)).toHaveLength(ALL_TOOLS.length);
  });
});

describe("loadConfig port", () => {
  it("defaults to 3000 when PORT is absent", () => {
    expect(loadConfig({ IW_PROFILE_DIR: "profiles" }).port).toBe(3000);
  });

  it("reads a valid PORT", () => {
    expect(loadConfig({ PORT: "8080", IW_PROFILE_DIR: "profiles" }).port).toBe(8080);
  });

  it.each(["3000abc", "3000 ", " 3000", "80.5", "0x1f", "", "eighty"])(
    "rejects the malformed port %j rather than reading a number out of the front of it",
    (value) => {
      expect(() => loadConfig({ PORT: value, IW_PROFILE_DIR: "profiles" })).toThrow(/PORT/);
    },
  );

  it.each(["0", "65536", "-1"])("rejects the out-of-range port %j", (value) => {
    expect(() => loadConfig({ PORT: value, IW_PROFILE_DIR: "profiles" })).toThrow(/PORT/);
  });
});

describe("loadConfig write gate", () => {
  it("disables writes when the variable is absent", () => {
    expect(loadConfig({ IW_PROFILE_DIR: "profiles" }).allowWrites).toBe(false);
  });

  it("disables writes for any value other than the exact string true", () => {
    for (const value of ["false", "1", "yes", "TRUE", "True", ""]) {
      expect(loadConfig({ IW_ALLOW_WRITES: value, IW_PROFILE_DIR: "profiles" }).allowWrites, `value "${value}"`).toBe(false);
    }
  });

  it("enables writes only for the exact string true", () => {
    expect(loadConfig({ IW_ALLOW_WRITES: "true", IW_PROFILE_DIR: "profiles" }).allowWrites).toBe(true);
  });
});
