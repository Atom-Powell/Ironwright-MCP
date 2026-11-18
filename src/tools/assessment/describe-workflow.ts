import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AssessmentProfile } from "../../domain/profile/assessment.js";
import { isAssessmentProfile } from "../../domain/profile/library.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure } from "../errors.js";
import { NotAnAssessmentProfileError } from "./context.js";

export const DESCRIBE_WORKFLOW_INPUT_SCHEMA = {
  profileId: z
    .string()
    .min(1)
    .optional()
    .describe('One assessment profile to describe, for example "vendor-assessments". Omitted, every assessment profile this server holds is described.'),
} satisfies z.ZodRawShape;

const ARTIFACT_SHAPE = {
  kind: z.string().describe('The artifact kind, as the other tools take it, for example "dossier".'),
  pathTemplate: z.string().describe('The kind\'s path template under the workspace root, for example "Research/{vendor}_Research_Dossier.md".'),
  external: z.boolean().describe("True when the kind is produced outside this server, so save_assessment_artifact refuses it and verify_publication reads it, for example true for a publication."),
  corrected: z.boolean().describe("True when an overwrite of the kind is recorded as stage CORRECTION, for example true for a dossier."),
} satisfies z.ZodRawShape;

const WORKFLOW_SHAPE = {
  profileId: z.string().describe('The profile id every other assessment tool takes, for example "vendor-assessments".'),
  siteUrl: z.string().describe('The SharePoint site the workflow keeps its lists and files in, for example "https://contoso.sharepoint.com/sites/Example".'),
  library: z.string().describe('The document library holding the workspaces, for example "Documents".'),
  lists: z
    .object({
      vendors: z.string().describe('The list of parties a case is about, for example "Vendors" or "Clients".'),
      assessments: z.string().describe('The list of cases, for example "Assessments" or "Incidents".'),
      findings: z.string().describe('The list of findings, for example "Findings".'),
    })
    .describe('The three lists by display name, for example {"vendors": "Vendors", "assessments": "Assessments", "findings": "Findings"}.'),
  artifacts: z.array(z.object(ARTIFACT_SHAPE)).describe("Every artifact kind the profile defines, in the profile's order, for example a dossier, an executive summary and a publication."),
  gates: z
    .object({
      findings: z.array(z.string()).describe('Kinds that must be present before record_findings writes, for example ["dossier"].'),
      provisional: z.array(z.string()).describe('Kinds that must be present before a transition to the provisional status, for example ["dossier"].'),
      completed: z.array(z.string()).describe('Kinds that must be present before a transition to the completed status, for example ["dossier", "publication"].'),
    })
    .describe('Which kinds each stage waits on, for example {"findings": ["dossier"], "provisional": ["dossier"], "completed": ["dossier", "publication"]}.'),
  status: z
    .object({
      inProgress: z.string().describe('The label of the status a new case holds, for example "In Progress".'),
      provisional: z.string().describe('The label of the provisional status, for example "Provisional".'),
      completed: z.string().describe('The label of the completed status, for example "Completed".'),
    })
    .describe('The three status labels as the list stores them, for example {"inProgress": "In Progress", "provisional": "Provisional", "completed": "Completed"}.'),
  dispositions: z.array(z.string()).describe('The disposition labels transition_assessment accepts, for example ["Approved", "Approved with conditions", "Rejected"].'),
  risks: z.array(z.string()).describe('The risk labels record_findings and transition_assessment accept, for example ["Low", "Medium", "High"].'),
} satisfies z.ZodRawShape;

export const DESCRIBE_WORKFLOW_OUTPUT_SCHEMA = {
  count: z.number().int().describe("How many workflows are described, for example 3."),
  workflows: z.array(z.object(WORKFLOW_SHAPE)).describe("One entry per assessment profile, ordered by profile id, for example a vendor risk workflow and an incident record."),
} satisfies z.ZodRawShape;

const InputObject = z.object(DESCRIBE_WORKFLOW_INPUT_SCHEMA);
const TOOL = "describe_assessment_workflow";

type Workflow = z.infer<z.ZodObject<typeof WORKFLOW_SHAPE>>;

function joined(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

function workflowOf(profile: AssessmentProfile): Workflow {
  const { gates, external, corrected, status, dispositions, risks } = profile.lifecycle;
  return {
    profileId: profile.profileId,
    siteUrl: profile.identity.siteUrl,
    library: profile.identity.library,
    lists: { vendors: profile.lists.vendors.name, assessments: profile.lists.assessments.name, findings: profile.lists.findings.name },
    artifacts: Object.entries(profile.workspace.artifacts).map(([kind, pathTemplate]) => ({ kind, pathTemplate, external: external.includes(kind), corrected: corrected.includes(kind) })),
    gates: { findings: [...gates.findings], provisional: [...gates.provisional], completed: [...gates.completed] },
    status: { inProgress: status.inProgress, provisional: status.provisional, completed: status.completed },
    dispositions: [...dispositions],
    risks: [...risks],
  };
}

/** One workflow as sentences an agent can act on: what it may save, what it must wait for, and which labels are valid. */
function sentences(workflow: Workflow): string {
  const saved = workflow.artifacts.filter((artifact) => !artifact.external).map((artifact) => artifact.kind);
  const outside = workflow.artifacts.filter((artifact) => artifact.external).map((artifact) => artifact.kind);
  const waits = (kinds: readonly string[]): string => (kinds.length === 0 ? "no artifact" : joined(kinds));
  return [
    `Workflow "${workflow.profileId}" on ${workflow.siteUrl}, library ${workflow.library}.`,
    saved.length === 0 ? "The server saves no artifact." : `The server saves ${joined(saved)}.`,
    outside.length === 0 ? "Nothing is produced outside the server." : `${joined(outside)} ${outside.length === 1 ? "is" : "are"} produced outside the server and only verified.`,
    `record_findings waits on ${waits(workflow.gates.findings)}.`,
    `Status "${workflow.status.provisional}" waits on ${waits(workflow.gates.provisional)}.`,
    `Status "${workflow.status.completed}" waits on ${waits(workflow.gates.completed)}.`,
    `Dispositions: ${workflow.dispositions.join(", ")}.`,
    `Risks: ${workflow.risks.join(", ")}.`,
  ].join(" ");
}

/**
 * Answers from the profiles the server loaded at startup and from nothing
 * else: no Graph request, no list read. It says what each workflow is, not
 * whether its lists exist or what they hold, which get_assessment answers.
 */
export async function runDescribeAssessmentWorkflow(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  try {
    let profiles: AssessmentProfile[];
    if (args.profileId !== undefined) {
      const profile = context.profiles.getAny(args.profileId);
      if (!isAssessmentProfile(profile)) throw new NotAnAssessmentProfileError(args.profileId, profile.kind ?? "compliance");
      profiles = [profile];
    } else {
      profiles = context.profiles
        .ids()
        .map((id) => context.profiles.getAny(id))
        .filter(isAssessmentProfile);
    }
    const workflows = profiles.map(workflowOf).sort((a, b) => (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
    const output = { count: workflows.length, workflows };
    const text = workflows.length === 0 ? "This server holds no assessment profile, so it offers no assessment workflow." : workflows.map(sentences).join("\n");
    return { structuredContent: output, content: [{ type: "text" as const, text }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: describeToolFailure(error, { tool: TOOL, ...(args.profileId === undefined ? {} : { profileId: args.profileId }) }) }] };
  }
}
