import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProfileRegistry } from "../../src/profiles/registry.js";

function exampleProfile(): Record<string, unknown> {
  return JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;
}

describe("createProfileRegistry", () => {
  it("resolves a profile by the profileId inside the file, not by the file name", () => {
    const registry = createProfileRegistry([{ source: "not-the-id.json", contents: exampleProfile() }]);

    expect(registry.get("example").profileId).toBe("example");
  });

  it("lists the configured ids in a stable order", () => {
    const registry = createProfileRegistry([
      { source: "b.json", contents: { ...exampleProfile(), profileId: "zulu" } },
      { source: "a.json", contents: { ...exampleProfile(), profileId: "alpha" } },
    ]);

    expect(registry.ids()).toEqual(["alpha", "zulu"]);
  });

  it("returns the same profile object on repeated gets, so nothing revalidates per call", () => {
    const registry = createProfileRegistry([{ source: "a.json", contents: exampleProfile() }]);

    expect(registry.get("example")).toBe(registry.get("example"));
  });
});
