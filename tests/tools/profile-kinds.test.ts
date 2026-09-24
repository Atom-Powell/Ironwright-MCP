import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ALL_TOOLS } from "../../src/tools/registry.js";
import { createProfileRegistry } from "../../src/profiles/registry.js";
import { createFakeToolContext } from "./fake-context.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";
const REQUIRES_COMPLIANCE = new Set([
  "reconcile_workbook_vs_repository",
  "validate_structure",
  "generate_rename_plan",
  "execute_rename_plan",
  "generate_move_plan",
  "execute_move_plan",
  "replicate_template",
]);
const ACCEPTS_LIBRARY = new Set(["inventory_tree", "query_repository", "generate_custom_plan", "execute_custom_plan"]);
const TAKES_NO_PROFILE = new Set(["describe_workbook"]);

describe("which tools accept a library-only profile", () => {
  it("places every registered tool in exactly one set", () => {
    for (const tool of ALL_TOOLS) {
      const memberships = [REQUIRES_COMPLIANCE, ACCEPTS_LIBRARY, TAKES_NO_PROFILE].filter((set) => set.has(tool.name)).length;
      expect(memberships, `${tool.name} must be classified here; a new tool has to choose`).toBe(1);
    }
  });

  it("refuses a library-only profile before any Graph request in every tool that needs a compliance profile", async () => {
    const profiles = createProfileRegistry(
      [
        { source: "example.json", contents: JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) },
        { source: "library-example.json", contents: JSON.parse(readFileSync("examples/profiles/library-example.json", "utf8")) },
      ],
      SITE,
    );
    for (const tool of ALL_TOOLS.filter((t) => REQUIRES_COMPLIANCE.has(t.name) && t.handler !== undefined)) {
      const context = createFakeToolContext({ profiles });
      const input = { profileId: "shared-docs", planId: "rnm-2026-09-24-00000000", sourceClient: "A", targetClients: ["B"] };
      const result = await tool.handler!(input, context);

      expect(result.isError, tool.name).toBe(true);
      expect(context.graph.requests(), tool.name).toBe(0);
    }
  });
});
