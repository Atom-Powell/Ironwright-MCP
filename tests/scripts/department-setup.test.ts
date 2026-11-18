// tests/scripts/department-setup.test.ts
import { describe, expect, it } from "vitest";
import { parseSetupArguments } from "../../scripts/department-setup.js";

describe("the department setup command's arguments", () => {
  it("takes a profile and leaves the grant at write unless told otherwise", () => {
    expect(parseSetupArguments(["--profile=profiles/desk.json"])).toEqual({ profile: "profiles/desk.json", roles: "write", dryRun: false });
  });

  it("takes read for a deployment that only reads, and a dry run", () => {
    expect(parseSetupArguments(["--profile=p.json", "--roles=read", "--dry-run"])).toEqual({ profile: "p.json", roles: "read", dryRun: true });
  });

  it("refuses to run without a profile, saying what the profile is for", () => {
    expect(parseSetupArguments([])).toEqual({ refusal: "--profile=<file> is required: the assessment profile whose site is to be prepared." });
    expect(parseSetupArguments(["--profile="])).toMatchObject({ refusal: expect.stringContaining("--profile=<file> is required") });
  });

  it("refuses a role that is neither read nor write, quoting it", () => {
    expect(parseSetupArguments(["--profile=p.json", "--roles=fullcontrol"])).toEqual({ refusal: '--roles must be read or write, received "fullcontrol".' });
  });

  // A mistyped flag that was ignored would run for real when a dry run was meant.
  it("refuses an argument it does not know, so a mistyped --dry-run cannot become a real run", () => {
    expect(parseSetupArguments(["--profile=p.json", "--dryrun"])).toEqual({
      refusal: "Unknown argument --dryrun. The arguments are --profile=<file>, --roles=read|write and --dry-run.",
    });
  });
});
