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
/**
 * The suite runs well over a hundred test files in parallel worker processes.
 * This test shells out to a real, cold tsc compile, so it is not competing
 * against a fixed amount of work but against however many sibling workers
 * happen to be mid-run at that moment. Vitest's default five-second test
 * timeout was sized for in-process assertions, not for a child compiler
 * process under that contention, and a compile that takes a couple of
 * seconds in isolation has been observed to exceed five seconds when the
 * rest of the suite is busy. Sixty seconds is not a measured worst case, it
 * is a deliberately large margin so that ordinary scheduling noise cannot
 * flip this test red without the production compile itself having actually
 * broken.
 */
const PRODUCTION_COMPILE_TIMEOUT_MS = 60_000;

describe("production compile", () => {
  it("the production compile excludes the setup command", () => {
    const config = JSON.parse(readFileSync("tsconfig.build.json", "utf8")) as { exclude?: string[] };
    expect(config.exclude).toContain("src/setup");
  });

  it(
    "emits the server entry point and no setup output",
    () => {
      rmSync("dist", { recursive: true, force: true });
      execFileSync("npm", ["run", "build:prod"], { stdio: "pipe", shell: process.platform === "win32" });

      expect(existsSync("dist/server/main.js")).toBe(true);
      expect(existsSync("dist/setup/main.js")).toBe(false);
    },
    PRODUCTION_COMPILE_TIMEOUT_MS,
  );

  it("start runs what the production compile emits", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toContain("dist/server/main.js");
  });
});
