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

/**
 * CLAUDE.md's Non-Negotiable Engineering Principles state that this repo's
 * prose avoids em dashes and en dashes, including inside string literals.
 * Before this case existed, nothing enforced that: the suite above checked
 * only for a NUL byte, and nothing anywhere caught a dash. See
 * docs/OPEN-ITEMS.md for how that gap was found and closed.
 *
 * The forbidden characters are written as escapes, not as literal em and en
 * dashes, so that this file does not fail the very check it defines.
 */
const EM_DASH = "\u2014";
const EN_DASH = "\u2013";

/**
 * Both are imported research source material that predates the style rule.
 * CLAUDE.md itself describes them as inputs to this project rather than as
 * its own prose: rewriting someone else's document to match our house style
 * would misrepresent what that document says and who wrote it.
 */
const DASH_EXEMPT = new Set(["competitive-landscape.md", "iw-mcp(research).md"]);

describe("tracked text sources, dash style", () => {
  const files = trackedTextFiles().filter((path) => !DASH_EXEMPT.has(path));

  it.each(files)("%s contains no em dash or en dash", (path) => {
    const content = readFileSync(path, "utf8");
    expect(content.includes(EM_DASH)).toBe(false);
    expect(content.includes(EN_DASH)).toBe(false);
  });
});
