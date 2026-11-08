import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadAnyProfile } from "../../../src/domain/profile/library.js";
import { ProfileValidationError } from "../../../src/domain/profile/load.js";
import { createProfileRegistry } from "../../../src/profiles/registry.js";

// A loose shape on purpose: each case reaches into the example and breaks one nested field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const SITE = "https://contoso.sharepoint.com/sites/Example";
const example = JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8")) as Loose;

function broken(change: (copy: Loose) => void): Loose {
  const copy = structuredClone(example);
  change(copy);
  return copy;
}

function issuesOf(input: unknown): string[] {
  try {
    loadAnyProfile(input);
  } catch (error) {
    if (error instanceof ProfileValidationError) return error.issues;
    throw error;
  }
  throw new Error("the profile loaded, but a refusal was expected");
}

function expectIssue(input: unknown, path: string, fragment: string | RegExp): void {
  const matching = issuesOf(input).filter((issue) => issue.startsWith(`${path}: `));
  expect(matching.length, `no issue at ${path}`).toBeGreaterThan(0);
  expect(matching.join(" | ")).toMatch(fragment);
}

describe("assessment profile refusals", () => {
  it("refuses an unknown workspace root placeholder, naming it", () => {
    expectIssue(broken((p) => { p.workspace.root = "Assessments/{client}/{assessmentId}"; }), "workspace.root", /client/);
  });

  it("refuses a date placeholder in the workspace root and lists the three it allows", () => {
    expectIssue(
      broken((p) => { p.workspace.root = "Assessments/{yyyy}/{vendorFolder}/{assessmentId}"; }),
      "workspace.root",
      /"\{yyyy\}" is not a workspace placeholder; the placeholders are \{vendor\}, \{vendorFolder\} and \{assessmentId\}/,
    );
  });

  it("refuses an unknown assessment id placeholder", () => {
    expectIssue(broken((p) => { p.assessmentId.template = "{prefix}-{vendor}"; }), "assessmentId.template", /vendor/);
  });

  it("refuses artifacts with no dossier", () => {
    expectIssue(broken((p) => { delete p.workspace.artifacts.dossier; }), "workspace.artifacts.dossier", /the module needs/);
  });

  it("refuses artifacts with no publication", () => {
    expectIssue(broken((p) => { delete p.workspace.artifacts.publication; }), "workspace.artifacts.publication", /the module needs/);
  });

  it("refuses a subfolder template that starts with a slash", () => {
    expectIssue(broken((p) => { p.workspace.subfolders = ["/Research"]; }), "workspace.subfolders.0", /does not start with/);
  });

  it("refuses an artifact template containing a .. segment", () => {
    expectIssue(broken((p) => { p.workspace.artifacts.dossier = "../escape/{vendor}.md"; }), "workspace.artifacts.dossier", /\.\./);
  });

  it("refuses two equal status labels", () => {
    expectIssue(broken((p) => { p.lifecycle.status.completed = "In Progress"; }), "lifecycle.status", /must differ/);
  });

  it("refuses an empty disposition list with the schema's own message", () => {
    expectIssue(broken((p) => { p.lifecycle.dispositions = []; }), "lifecycle.dispositions", /at least 1/i);
  });

  it("refuses two sites", () => {
    expectIssue(
      broken((p) => { p.sites = [p.sites[0], { siteUrl: "https://contoso.sharepoint.com/sites/Other", library: "Documents" }]; }),
      "sites",
      /exactly one site in this phase/,
    );
  });

  it("refuses a workbookPath on the site", () => {
    const input = broken((p) => { p.sites[0].workbookPath = "/Tracker.xlsx"; p.identity = undefined; });
    expect(() => loadAnyProfile(input)).toThrow(ProfileValidationError);
  });

  it("refuses an unknown top level key", () => {
    expect(() => loadAnyProfile(broken((p) => { p.taxonomy = {}; }))).toThrow(ProfileValidationError);
  });

  it("reports a bad template through the registry prefixed by its source name", () => {
    const contents = broken((p) => { p.workspace.root = "{client}"; });

    expect(() => createProfileRegistry([{ source: "assess.json", contents }], SITE)).toThrow(/assess\.json: .*workspace\.root/);
  });
});
