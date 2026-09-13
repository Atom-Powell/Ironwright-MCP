import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Git treats a file containing a NUL byte as binary. It then renders every
 * diff of that file as "Binary files ... differ", which means the file's
 * contents never reach a reviewer, `grep` reports it as "Binary file matches"
 * without the matching lines, and the change is invisible to every tool this
 * project's review process depends on.
 *
 * This is not hypothetical. A raw NUL was written into a template literal in
 * `src/domain/reconcile/match.ts` as a key separator, and the review package
 * generated for that task contained no source at all. Escapes (`\u0000`)
 * produce the identical string at runtime and keep the file text, so there is
 * never a reason to write the byte itself.
 */
const TRACKED_TEXT = /\.(ts|js|json|md|yml|yaml)$/;

function trackedTextFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return output.split("\0").filter((path) => path !== "" && TRACKED_TEXT.test(path));
}

describe("tracked text sources", () => {
  const files = trackedTextFiles();

  it("finds files to check", () => {
    // Guards the guard: a broken `git ls-files` invocation would otherwise
    // make every assertion below vacuously pass over an empty list.
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)("%s contains no NUL byte", (path) => {
    expect(readFileSync(path).includes(0)).toBe(false);
  });
});
