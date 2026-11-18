import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProfileRegistry } from "../../../src/profiles/registry.js";
import { runDescribeAssessmentWorkflow } from "../../../src/tools/assessment/describe-workflow.js";
import { createFakeToolContext } from "../fake-context.js";
import { resultText } from "./fake-graph.js";

const SITE = "https://contoso.sharepoint.com/sites/Example";
const DESK = "https://contoso.sharepoint.com/sites/ServiceDesk";
const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(`examples/profiles/${file}`, "utf8")) as Record<string, unknown>;

/** A registry holding vendor risk on one site, the incident record on another, and a compliance profile. */
function context() {
  const incident = { ...read("msp-security-incident.json"), sites: [{ siteUrl: DESK, library: "Documents" }] };
  const profiles = createProfileRegistry(
    [
      { source: "example.json", contents: read("example.json") },
      { source: "assessment-example.json", contents: read("assessment-example.json") },
      { source: "incident.json", contents: incident },
    ],
    [SITE, DESK],
  );
  return createFakeToolContext({ profiles });
}

// An agent serving several departments cannot be told every workflow in its instructions. It asks.
describe("describe_assessment_workflow", () => {
  it("lists every assessment workflow the server holds, and no other kind of profile, without a Graph request", async () => {
    const ctx = context();

    const result = await runDescribeAssessmentWorkflow({}, ctx);

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent as { count: number; workflows: Array<{ profileId: string; siteUrl: string }> };
    expect(output.count).toBe(2);
    expect(output.workflows.map((workflow) => [workflow.profileId, workflow.siteUrl])).toEqual([
      ["security-incidents", DESK],
      ["vendor-assessments", SITE],
    ]);
    expect(ctx.graph.requests()).toBe(0);
  });

  it("says what a workflow saves, what is produced outside the server, and what each stage waits on", async () => {
    const result = await runDescribeAssessmentWorkflow({ profileId: "security-incidents" }, context());

    const [workflow] = (result.structuredContent as { workflows: Array<Record<string, unknown>> }).workflows;
    expect(workflow).toMatchObject({
      profileId: "security-incidents",
      library: "Documents",
      lists: { vendors: "Clients", assessments: "Incidents", findings: "Incident Findings" },
      gates: { findings: ["timeline"], provisional: ["timeline", "containment"], completed: ["timeline", "containment", "postmortem"] },
      status: { inProgress: "Open", provisional: "Contained", completed: "Closed" },
      dispositions: ["Resolved", "Resolved with follow up", "False positive"],
      risks: ["Low", "Medium", "High", "Critical"],
    });
    expect(workflow!.artifacts).toEqual([
      { kind: "timeline", pathTemplate: "Record/{assessmentId}_Timeline.md", external: false, corrected: true },
      { kind: "containment", pathTemplate: "Record/{assessmentId}_Containment.md", external: false, corrected: true },
      { kind: "client_notice", pathTemplate: "Review/{assessmentId}_Client_Notice.md", external: false, corrected: false },
      { kind: "postmortem", pathTemplate: "Review/{vendorFolder}_{assessmentId}_Postmortem.docx", external: true, corrected: false },
    ]);
    expect(resultText(result)).toBe(
      'Workflow "security-incidents" on https://contoso.sharepoint.com/sites/ServiceDesk, library Documents. ' +
        "The server saves timeline, containment and client_notice. postmortem is produced outside the server and only verified. " +
        'record_findings waits on timeline. Status "Contained" waits on timeline and containment. Status "Closed" waits on timeline, containment and postmortem. ' +
        "Dispositions: Resolved, Resolved with follow up, False positive. Risks: Low, Medium, High, Critical.",
    );
  });

  it("describes the defaults for a profile that sets none, which is the vendor risk workflow", async () => {
    const result = await runDescribeAssessmentWorkflow({ profileId: "vendor-assessments" }, context());

    const [workflow] = (result.structuredContent as { workflows: Array<Record<string, unknown>> }).workflows;
    expect(workflow).toMatchObject({ gates: { findings: ["dossier"], provisional: ["dossier"], completed: ["dossier", "publication"] } });
    expect(resultText(result)).toContain("publication is produced outside the server and only verified.");
  });

  it("says a stage that waits on nothing waits on no artifact", async () => {
    const open = { ...read("assessment-example.json"), profileId: "open-gates" } as unknown as { lifecycle: Record<string, unknown> } & Record<string, unknown>;
    open.lifecycle = { ...open.lifecycle, gates: { findings: [], provisional: [], completed: ["dossier"] }, external: [] };
    const profiles = createProfileRegistry([{ source: "open.json", contents: open }], SITE);

    const result = await runDescribeAssessmentWorkflow({ profileId: "open-gates" }, createFakeToolContext({ profiles }));

    expect(resultText(result)).toContain("record_findings waits on no artifact.");
    expect(resultText(result)).toContain("Nothing is produced outside the server.");
  });

  it("refuses a profile of another kind in the words the other assessment tools use", async () => {
    const ctx = context();

    const result = await runDescribeAssessmentWorkflow({ profileId: "example" }, ctx);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("this tool needs an assessment profile");
    expect(ctx.graph.requests()).toBe(0);
  });

  it("names the configured ids for a profile id the registry does not know", async () => {
    const result = await runDescribeAssessmentWorkflow({ profileId: "nope" }, context());

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("security-incidents");
  });

  it("says so plainly when the server holds no assessment profile", async () => {
    const profiles = createProfileRegistry([{ source: "example.json", contents: read("example.json") }], SITE);

    const result = await runDescribeAssessmentWorkflow({}, createFakeToolContext({ profiles }));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ count: 0, workflows: [] });
    expect(resultText(result)).toBe("This server holds no assessment profile, so it offers no assessment workflow.");
  });
});
