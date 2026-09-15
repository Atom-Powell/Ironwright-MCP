import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProfileRegistry,
  loadProfileDirectory,
  ProfileRegistryError,
  UnknownProfileError,
} from "../../src/profiles/registry.js";

function exampleProfile(): Record<string, unknown> {
  return JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as Record<string, unknown>;
}

describe("createProfileRegistry rejections", () => {
  it("names every invalid profile in one message, not the first one only", () => {
    const attempt = (): unknown =>
      createProfileRegistry([
        { source: "one.json", contents: { profileId: "one" } },
        { source: "two.json", contents: { profileId: "two" } },
      ]);

    expect(attempt).toThrow(ProfileRegistryError);
    try {
      attempt();
    } catch (error) {
      expect((error as ProfileRegistryError).issues).toHaveLength(2);
      expect((error as ProfileRegistryError).message).toContain("one.json");
      expect((error as ProfileRegistryError).message).toContain("two.json");
    }
  });

  it("refuses two files claiming one profileId, naming both files", () => {
    const attempt = (): unknown =>
      createProfileRegistry([
        { source: "first.json", contents: exampleProfile() },
        { source: "second.json", contents: exampleProfile() },
      ]);

    expect(attempt).toThrow(/first\.json and second\.json|second\.json and first\.json/);
    expect(attempt).toThrow(/"example"/);
  });

  it("refuses an empty directory rather than starting a server that can answer nothing", () => {
    expect(() => createProfileRegistry([])).toThrow(/no profile files/);
  });

  it("names the configured ids when asked for one that is not there", () => {
    const registry = createProfileRegistry([{ source: "a.json", contents: exampleProfile() }]);

    try {
      registry.get("missing");
      expect.unreachable("get should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownProfileError);
      expect((error as UnknownProfileError).configured).toEqual(["example"]);
      expect((error as UnknownProfileError).message).toContain('"example"');
      expect((error as UnknownProfileError).message).toContain("profile is");
    }
  });
});

describe("loadProfileDirectory rejections", () => {
  it("names the file when its JSON will not parse, since JSON.parse reports only an offset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iw-profiles-"));
    await writeFile(join(dir, "broken.json"), "{ not json", "utf8");

    await expect(loadProfileDirectory(dir)).rejects.toThrow(/broken\.json/);
  });

  it("names the directory when it does not exist", async () => {
    const missing = join(tmpdir(), "iw-profiles-does-not-exist-12345");

    await expect(loadProfileDirectory(missing)).rejects.toThrow(missing);
  });

  it("ignores files that are not .json rather than failing on them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iw-profiles-"));
    await writeFile(join(dir, "example.json"), JSON.stringify(exampleProfile()), "utf8");
    await writeFile(join(dir, "README.md"), "not a profile", "utf8");

    const registry = await loadProfileDirectory(dir);

    expect(registry.ids()).toEqual(["example"]);
  });
});
