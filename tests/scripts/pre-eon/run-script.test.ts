// tests/scripts/pre-eon/run-script.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runScript } from "../../../scripts/pre-eon/run-script.js";

const folder = mkdtempSync(join(tmpdir(), "iw-run-script-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function fixture(name: string, body: string): string {
  const file = join(folder, name);
  writeFileSync(file, body);
  return file;
}

describe("running one of the repo's scripts for the sitting", () => {
  it("returns the exit code and the unredacted text, and logs and shows the redacted lines", async () => {
    const script = fixture(
      "prints.mjs",
      [
        'console.log("To sign in, enter the code ABCD.");',
        'console.log("  IW_BOOTSTRAP_CLIENT_ID=app-id");',
        'console.log("  IW_BOOTSTRAP_CLIENT_SECRET=s3cr~et.Value_8Q");',
        'console.error("known secret quoted in an error: hunter2-known");',
        "process.exitCode = 3;",
      ].join("\n"),
    );
    const shown: string[] = [];
    const run = await runScript({ folder, label: "prints", script, args: [], secrets: ["hunter2-known"], show: (line) => shown.push(line) });

    expect(run.code).toBe(3);
    expect(run.text).toContain("IW_BOOTSTRAP_CLIENT_SECRET=s3cr~et.Value_8Q");
    const log = readFileSync(join(folder, "prints.log"), "utf8");
    for (const seen of [log, shown.join("\n")]) {
      expect(seen).toContain("To sign in, enter the code ABCD.");
      expect(seen).toContain("IW_BOOTSTRAP_CLIENT_ID=app-id");
      expect(seen).not.toContain("s3cr~et.Value_8Q");
      expect(seen).not.toContain("hunter2-known");
      expect(seen).toContain("known secret quoted in an error: <secret>");
    }
  });

  it("keeps a last line that ends without a newline", async () => {
    const script = fixture("no-newline.mjs", 'process.stdout.write("first\\nroles after PATCH: read");');
    const shown: string[] = [];
    const run = await runScript({ folder, label: "no-newline", script, args: [], secrets: [], show: (line) => shown.push(line) });
    expect(run.code).toBe(0);
    expect(run.text.trim().split("\n").at(-1)).toBe("roles after PATCH: read");
    expect(shown).toEqual(["first", "roles after PATCH: read"]);
  });

  it("passes arguments and added environment through to the script", async () => {
    const script = fixture("echo.mjs", 'console.log(process.argv.slice(2).join(",") + " " + process.env.IW_FIXTURE_VALUE);');
    const run = await runScript({ folder, label: "echo", script, args: ["--roles=write"], env: { IW_FIXTURE_VALUE: "from-env" }, secrets: [] });
    expect(run.text.trim()).toBe("--roles=write from-env");
  });
});
