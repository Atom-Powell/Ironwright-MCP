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
// Ruling 4: a tool that accepts a library profile accepts an assessment profile too, because
// both carry only a site and a library and these tools read nothing else.
const ACCEPTS_SITE_PROFILES = new Set(["inventory_tree", "query_repository", "generate_custom_plan", "execute_custom_plan"]);
// The assessment module's own tools, which no other kind of profile can use. Filled in when they are registered.
const ACCEPTS_ASSESSMENT = new Set<string>();
const TAKES_NO_PROFILE = new Set(["describe_workbook"]);

describe("which tools accept a library-only profile", () => {
  it("places every registered tool in exactly one set", () => {
    for (const tool of ALL_TOOLS) {
      const memberships = [REQUIRES_COMPLIANCE, ACCEPTS_SITE_PROFILES, ACCEPTS_ASSESSMENT, TAKES_NO_PROFILE].filter((set) => set.has(tool.name)).length;
      expect(memberships, `${tool.name} must be classified here; a new tool has to choose`).toBe(1);
    }
  });

  it("refuses a library-only profile before any Graph request in every tool that needs a compliance profile", async () => {
    const profiles = createProfileRegistry(
      [
        { source: "example.json", contents: JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) },
        { source: "library-example.json", contents: JSON.parse(readFileSync("examples/profiles/library-example.json", "utf8")) },
        { source: "assessment-example.json", contents: JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8")) },
      ],
      SITE,
    );
    for (const tool of ALL_TOOLS.filter((t) => REQUIRES_COMPLIANCE.has(t.name) && t.handler !== undefined)) {
      const context = createFakeToolContext({ profiles });
      const input = { profileId: "shared-docs", planId: "rnm-2026-09-24-00000000", sourceClient: "A", targetClients: ["B"] };
      const result = await tool.handler!(input, context);

      expect(result.isError, tool.name).toBe(true);
      // Pinned to the reason, so a tool failing for any other cause, a
      // malformed input among them, cannot pass as having refused the profile.
      const text = result.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      expect(text, tool.name).toContain("library-only");
      expect(context.graph.requests(), tool.name).toBe(0);
    }
  });
  it("refuses an assessment profile before any Graph request in every tool that needs a compliance profile", async () => {
    const profiles = createProfileRegistry(
      [
        { source: "example.json", contents: JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) },
        { source: "assessment-example.json", contents: JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8")) },
      ],
      SITE,
    );
    for (const tool of ALL_TOOLS.filter((t) => REQUIRES_COMPLIANCE.has(t.name) && t.handler !== undefined)) {
      const context = createFakeToolContext({ profiles });
      const input = { profileId: "vendor-assessments", planId: "rnm-2026-09-24-00000000", sourceClient: "A", targetClients: ["B"] };
      const result = await tool.handler!(input, context);

      expect(result.isError, tool.name).toBe(true);
      const text = result.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      expect(text, tool.name).toContain("assessment profile");
      expect(context.graph.requests(), tool.name).toBe(0);
    }
  });
});
