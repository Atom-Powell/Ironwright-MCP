import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Excluding the setup command is a security boundary rather than a size saving.
 * That command issues per-site permission grants through a separate application
 * holding Sites.FullControl.All, and a deployed server has no business carrying
 * that machinery: it widens a compromise from "can read one granted site" to
 * "contains the means to grant access to others".
 *
 * The devDependency failure is the symptom that surfaced it. src/setup/main.ts
 * imports @azure/identity, so a production install cannot compile it.
 */
describe("production compile", () => {
  it("the production compile excludes the setup command", () => {
    const config = JSON.parse(readFileSync("tsconfig.build.json", "utf8")) as { exclude?: string[] };
    expect(config.exclude).toContain("src/setup");
  });

  it("emits the server entry point and no setup output", () => {
    rmSync("dist", { recursive: true, force: true });
    execFileSync("npm", ["run", "build:prod"], { stdio: "pipe", shell: process.platform === "win32" });

    expect(existsSync("dist/server/main.js")).toBe(true);
    expect(existsSync("dist/setup/main.js")).toBe(false);
  });

  it("start runs what the production compile emits", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toContain("dist/server/main.js");
  });
});
