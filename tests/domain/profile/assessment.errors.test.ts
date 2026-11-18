import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ProfileValidationError } from "../../../src/domain/profile/load.js";
import { journalPartitionKey } from "../../../src/store/keys.js";
import { createProfileRegistry, loadAnyProfile } from "../../../src/profiles/registry.js";

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

  // The gates default to the vendor risk workflow, so a profile that sets none still needs the
  // two kinds that workflow names, and is told which gate asks for them.
  it("refuses a profile that sets no gates and defines no dossier, naming the gates that default to it", () => {
    const input = broken((p) => { delete p.workspace.artifacts.dossier; });
    expectIssue(input, "lifecycle.gates.findings", /names the artifact kind "dossier", which workspace\.artifacts does not define/);
    expectIssue(input, "lifecycle.gates.findings", /defaults to dossier/);
    expectIssue(input, "lifecycle.corrected", /"dossier"/);
  });

  it("refuses a profile that sets no gates and defines no publication, naming the gate and the external list", () => {
    const input = broken((p) => { delete p.workspace.artifacts.publication; });
    expectIssue(input, "lifecycle.gates.completed", /names the artifact kind "publication", which workspace\.artifacts does not define/);
    expectIssue(input, "lifecycle.external", /"publication"/);
  });

  it("refuses a gate that names a kind the profile does not define, listing the kinds it does", () => {
    expectIssue(
      broken((p) => { p.lifecycle.gates = { findings: ["dossier"], provisional: ["dossier"], completed: ["dossier", "sign_off"] }; }),
      "lifecycle.gates.completed",
      /names the artifact kind "sign_off", which workspace\.artifacts does not define; its kinds are dossier, executive_summary, publication/,
    );
  });

  it("refuses a completed gate that names no kind, since completion would then be verified against nothing", () => {
    expectIssue(broken((p) => { p.lifecycle.gates = { findings: [], provisional: [], completed: [] }; }), "lifecycle.gates.completed", /at least one/);
  });

  it("refuses a kind listed both as corrected and as external, since the server never writes an external kind", () => {
    expectIssue(broken((p) => { p.lifecycle.corrected = ["dossier", "publication"]; }), "lifecycle.corrected", /"publication" is listed as external/);
  });

  // The operator wrote only external here. The issue lands on corrected, a setting they never
  // wrote, so it has to say where the dossier in it came from.
  it("says corrected defaults to dossier when an external dossier collides with a corrected the profile never set", () => {
    expectIssue(broken((p) => { p.lifecycle.external = ["publication", "dossier"]; }), "lifecycle.corrected", /"dossier" is listed as external.*corrected defaults to dossier/);
  });

  it("refuses gates that set one stage and not the others, saying the three are set together", () => {
    const input = broken((p) => { p.lifecycle.gates = { findings: ["dossier"] }; });
    expectIssue(input, "lifecycle.gates.provisional", /a profile that sets gates sets all three/);
    expectIssue(input, "lifecycle.gates.completed", /a profile that sets gates sets all three/);
  });

  it("refuses a subfolder template that starts with a slash", () => {
    expectIssue(broken((p) => { p.workspace.subfolders = ["/Research"]; }), "workspace.subfolders.0", /does not start with/);
  });

  it("refuses an artifact template containing a .. segment", () => {
    expectIssue(broken((p) => { p.workspace.artifacts.dossier = "../escape/{vendor}.md"; }), "workspace.artifacts.dossier", /\.\./);
  });

  it("refuses a workspace root with a . segment, which the tools would refuse to join on every call", () => {
    expectIssue(broken((p) => { p.workspace.root = "./Assessments/{vendorFolder}/{assessmentId}"; }), "workspace.root", /"\." segment/);
  });

  it("refuses a .. segment padded with spaces, since a path segment is trimmed before it is joined", () => {
    expectIssue(broken((p) => { p.workspace.subfolders = ["Research/ .. /Other"]; }), "workspace.subfolders.0", /"\.\." segment/);
  });

  it("refuses an id prefix holding a character a folder name or a journal key cannot, naming it", () => {
    expectIssue(broken((p) => { p.assessmentId.prefix = "ASM/2026"; }), "assessmentId.prefix", /"\/"/);
    expectIssue(broken((p) => { p.assessmentId.prefix = "ASM#"; }), "assessmentId.prefix", /"#"/);
  });

  it("refuses a backslash and a control character in the id prefix, which a table key refuses", () => {
    expectIssue(broken((p) => { p.assessmentId.prefix = "ASM\\2026"; }), "assessmentId.prefix", /cannot contain/);
    expectIssue(broken((p) => { p.assessmentId.prefix = "ASM\u0007"; }), "assessmentId.prefix", /cannot contain/);
  });

  it("refuses a backslash in a workspace template", () => {
    expectIssue(broken((p) => { p.workspace.artifacts.dossier = "Research\\{vendor}.md"; }), "workspace.artifacts.dossier", /SharePoint refuses/);
  });

  it("refuses an id template whose own text holds such a character", () => {
    expectIssue(broken((p) => { p.assessmentId.template = "{prefix}:{item:5}"; }), "assessmentId.template", /":"/);
  });

  it("refuses an id template that would render an id ending in a dot, which SharePoint refuses on a folder", () => {
    expectIssue(broken((p) => { p.assessmentId.template = "{prefix}-{item}."; }), "assessmentId.template", /ends in a dot/);
  });

  it("refuses an id template without {item}, since every assessment would render the same id", () => {
    expectIssue(broken((p) => { p.assessmentId.template = "{prefix}-{yyyy}-{mm}"; }), "assessmentId.template", /\{item\}/);
  });

  it("refuses a workspace template whose own text holds a character SharePoint refuses in a name", () => {
    expectIssue(broken((p) => { p.workspace.artifacts.dossier = "Research/{vendor}: Dossier.md"; }), "workspace.artifacts.dossier", /":"/);
    expectIssue(broken((p) => { p.workspace.subfolders = ["Research?"]; }), "workspace.subfolders.0", /"\?"/);
  });

  it("refuses a workspace template with a segment ending in a dot", () => {
    expectIssue(broken((p) => { p.workspace.subfolders = ["Research./Notes"]; }), "workspace.subfolders.0", /ends in a dot/);
    expectIssue(broken((p) => { p.workspace.subfolders = ["A."]; }), "workspace.subfolders.0", /ends in a dot/);
  });

  it("refuses {vendor} at the end of a path segment, where a display name ending in a dot would end the name", () => {
    expectIssue(broken((p) => { p.workspace.artifacts.dossier = "Research/{vendor}/dossier.md"; }), "workspace.artifacts.dossier", /\{vendor\} ends a path segment/);
    expectIssue(broken((p) => { p.workspace.root = "Assessments/{assessmentId}_{vendor}"; }), "workspace.root", /\{vendor\} ends a path segment/);
  });

  it("refuses in an id every character the journal's key refuses, so a profile that loads can be journaled", () => {
    for (const character of ["/", "\\", "#", "?", "\u0007", "\u0085"]) {
      expect(() => journalPartitionKey("p", `ASM${character}1`), JSON.stringify(character)).toThrow();
      expectIssue(broken((p) => { p.assessmentId.prefix = `ASM${character}`; }), "assessmentId.prefix", /cannot contain/);
    }
  });

  it("refuses two artifact kinds whose templates name one file", () => {
    expectIssue(
      broken((p) => { p.workspace.artifacts.executive_summary = "research/{vendor}_Research_Dossier.md"; }),
      "workspace.artifacts.executive_summary",
      /same file as "dossier"/,
    );
  });

  it("refuses two of the three lists sharing a name", () => {
    expectIssue(broken((p) => { p.lists.findings.name = "assessments"; }), "lists.findings.name", /same list as lists\.assessments/);
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
