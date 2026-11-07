import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { createProfileRegistry } from "../../src/profiles/registry.js";
import { ALL_MODULES, moduleForKind } from "../../src/modules/index.js";
import type { DomainModule } from "../../src/modules/types.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";
const example = () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;

describe("registry dispatch by kind", () => {
  it("validates a profile with the module that owns its kind", () => {
    const seen: string[] = [];
    const fake: DomainModule = {
      kind: "library",
      profileSchema: z.any().transform((v: { profileId: string }) => {
        seen.push(v.profileId);
        return { ...v, kind: "library" };
      }),
      tools: [],
    };
    const registry = createProfileRegistry(
      [{ source: "lib.json", contents: { kind: "library", profileId: "lib-one", identity: { siteUrl: SITE, library: "Docs" } } }],
      SITE,
      [fake],
    );
    expect(seen).toEqual(["lib-one"]);
    expect(registry.ids()).toEqual(["lib-one"]);
  });

  it("treats an absent kind as compliance, so the example profile loads through the compliance module", () => {
    const registry = createProfileRegistry([{ source: "example.json", contents: example() }], SITE);
    expect(registry.get("example").profileId).toBe("example");
  });

  it("accepts a profile whose every site is the granted site", () => {
    const input = example();
    const identity = input.identity as object;
    delete input.identity;
    input.sites = [identity, { ...identity }];
    const registry = createProfileRegistry([{ source: "two.json", contents: input }], SITE);
    expect(registry.ids()).toEqual(["example"]);
  });

  it("moduleForKind returns the module whose kind matches and undefined for a kind nobody owns", () => {
    expect(moduleForKind("library", ALL_MODULES)?.kind).toBe("library");
    expect(moduleForKind("compliance")?.kind).toBe("compliance");
    expect(moduleForKind("vendor-risk")).toBeUndefined();
  });
});
