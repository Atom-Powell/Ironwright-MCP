import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScanArguments, readProfile } from "../../src/scan/cli.js";

describe("parseScanArguments failures", () => {
  it("refuses a missing --profile, naming the flag and showing the usage", () => {
    expect(() => parseScanArguments([])).toThrow(/--profile/);
    expect(() => parseScanArguments([])).toThrow(/npm run scan/);
  });

  it("refuses --profile with no value rather than reading the next flag as a path", () => {
    expect(() => parseScanArguments(["--profile", "--sub-path", "2026"])).toThrow(/--profile needs a value/);
  });

  it("refuses --profile as the last argument with nothing after it", () => {
    expect(() => parseScanArguments(["--profile"])).toThrow(/--profile needs a value/);
  });

  it("refuses an unrecognized flag rather than ignoring a typo", () => {
    expect(() => parseScanArguments(["--profile", "p.json", "--subpath", "2026"])).toThrow(/--subpath/);
  });
});

describe("readProfile failures", () => {
  it("names the profile file when its contents are not valid JSON", async () => {
    const path = join(tmpdir(), `ironwright-bad-profile-${process.pid}.json`);
    await writeFile(path, "{ not json", "utf8");

    try {
      await expect(readProfile(path)).rejects.toThrow(new RegExp(path.replace(/\\/g, "\\\\")));
      await expect(readProfile(path)).rejects.toThrow(/not valid JSON/);
    } finally {
      await rm(path, { force: true });
    }
  });
});
