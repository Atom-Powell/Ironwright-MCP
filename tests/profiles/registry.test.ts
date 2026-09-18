import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProfileRegistry } from "../../src/profiles/registry.js";

const GRANTED_SITE_URL = "https://contoso.sharepoint.com/sites/Example";

function exampleProfile(): Record<string, unknown> {
  return JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;
}

describe("createProfileRegistry", () => {
  it("resolves a profile by the profileId inside the file, not by the file name", () => {
    const registry = createProfileRegistry([{ source: "not-the-id.json", contents: exampleProfile() }], GRANTED_SITE_URL);

    expect(registry.get("example").profileId).toBe("example");
  });

  it("lists the configured ids in a stable order", () => {
    const registry = createProfileRegistry(
      [
        { source: "b.json", contents: { ...exampleProfile(), profileId: "zulu" } },
        { source: "a.json", contents: { ...exampleProfile(), profileId: "alpha" } },
      ],
      GRANTED_SITE_URL,
    );

    expect(registry.ids()).toEqual(["alpha", "zulu"]);
  });

  it("returns the same profile object on repeated gets, so nothing revalidates per call", () => {
    const registry = createProfileRegistry([{ source: "a.json", contents: exampleProfile() }], GRANTED_SITE_URL);

    expect(registry.get("example")).toBe(registry.get("example"));
  });

  it("refuses a profile whose site disagrees with the granted site", () => {
    const contents = exampleProfile();
    const identity = contents.identity as Record<string, unknown>;
    const profile = { ...contents, identity: { ...identity, siteUrl: "https://contoso.sharepoint.com/sites/Other" } };

    expect(() =>
      createProfileRegistry([{ source: "a.json", contents: profile }], "https://contoso.sharepoint.com/sites/Ops"),
    ).toThrow(/"example".*sites\/Other.*sites\/Ops/s);
  });

  it("accepts a profile whose site matches, ignoring case", () => {
    // The comparison is a permission boundary, so both halves of what it
    // normalizes are pinned. Only the trailing slash was, which left the
    // case fold free to be narrowed, or widened to a host-only comparison
    // that would accept a profile pointed at a different site on the same
    // tenant, with nothing failing.
    const contents = exampleProfile();
    const identity = contents.identity as Record<string, unknown>;
    const profile = { ...contents, identity: { ...identity, siteUrl: "https://CONTOSO.sharepoint.com/sites/Ops" } };

    expect(() =>
      createProfileRegistry([{ source: "a.json", contents: profile }], "https://contoso.sharepoint.com/sites/ops"),
    ).not.toThrow();
  });

  it("still refuses a different path on the same host, which no normalization may fold away", () => {
    const contents = exampleProfile();
    const identity = contents.identity as Record<string, unknown>;
    const profile = { ...contents, identity: { ...identity, siteUrl: "https://contoso.sharepoint.com/sites/OpsArchive" } };

    expect(() =>
      createProfileRegistry([{ source: "a.json", contents: profile }], "https://contoso.sharepoint.com/sites/Ops"),
    ).toThrow(/sites\/OpsArchive/);
  });

  it("accepts a profile whose site matches, ignoring a trailing slash", () => {
    const contents = exampleProfile();
    const identity = contents.identity as Record<string, unknown>;
    const profile = { ...contents, identity: { ...identity, siteUrl: "https://contoso.sharepoint.com/sites/Ops/" } };

    expect(() =>
      createProfileRegistry([{ source: "a.json", contents: profile }], "https://contoso.sharepoint.com/sites/Ops"),
    ).not.toThrow();
  });
});
