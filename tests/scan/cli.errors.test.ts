import { describe, expect, it } from "vitest";
import { parseScanArguments } from "../../src/scan/cli.js";

describe("parseScanArguments failures", () => {
  it("refuses a missing --profile, naming the flag and showing the usage", () => {
    expect(() => parseScanArguments([])).toThrow(/--profile/);
    expect(() => parseScanArguments([])).toThrow(/npm run scan/);
  });

  it("refuses --profile with no value rather than reading the next flag as a path", () => {
    expect(() => parseScanArguments(["--profile", "--sub-path", "2026"])).toThrow(/--profile needs a value/);
  });

  it("refuses an unrecognized flag rather than ignoring a typo", () => {
    expect(() => parseScanArguments(["--profile", "p.json", "--subpath", "2026"])).toThrow(/--subpath/);
  });
});
