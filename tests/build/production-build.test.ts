import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * A command string rather than execFileSync with an args array, because an args
 * array combined with `shell: true`, which npm on Windows requires since Node
 * refuses to spawn a .cmd without it, raises Node's DEP0190 deprecation.
 *
 * stdio is captured rather than inherited so the suite's output stays readable,
 * and then printed here on failure. This is the test that guards the security
 * boundary; one that fails without saying what tsc objected to cannot be acted
 * on, which was the state it shipped in.
 */
function runNpmScript(script: string): void {
  try {
    execSync(`npm run ${script}`, { stdio: "pipe" });
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer };
    const output = [failure.stdout?.toString() ?? "", failure.stderr?.toString() ?? ""].join("\n").trim();
    throw new Error(`npm run ${script} failed:\n${output}`);
  }
}

describe("production compile", () => {
  it("the production compile excludes the setup command", () => {
    const config = JSON.parse(readFileSync("tsconfig.build.json", "utf8")) as { exclude?: string[] };
    expect(config.exclude).toContain("src/setup");
  });

  it(
    "emits the server entry point and clears setup output left by an earlier build",
    () => {
      // tsc does not prune its outDir, so excluding src/setup from the compile
      // only keeps setup output out of a tree that never had it. A developer
      // machine, or any image built from a cached workspace, has almost always
      // run the development build first, and dist/setup/main.js survives the
      // production compile untouched. The stand-in below is written rather than
      // compiled because the boundary is about what remains in dist, not about
      // where those bytes came from, and a real second compile would double
      // this test's cost for nothing.
      mkdirSync("dist/setup", { recursive: true });
      writeFileSync("dist/setup/main.js", "// left over from a development build\n");

      runNpmScript("build:prod");

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
