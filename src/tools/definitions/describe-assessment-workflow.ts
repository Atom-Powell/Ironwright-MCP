import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { DESCRIBE_WORKFLOW_INPUT_SCHEMA, DESCRIBE_WORKFLOW_OUTPUT_SCHEMA, runDescribeAssessmentWorkflow } from "../assessment/describe-workflow.js";

export const describeAssessmentWorkflow: ToolDefinition = {
  name: "describe_assessment_workflow",
  kind: "read",
  title: "Describe the assessment workflows",
  description: [
    "Say which assessment workflows this server offers and what each one is: its profile id, its site and library, its three lists, every artifact kind with whether the server saves it or it is produced outside the server, which kinds each stage waits on, and the status, disposition and risk labels its tools accept. Call it first when the workflow is not already known, since every other assessment tool takes a profile id and the labels and kinds differ by profile.",
    "Answered from the profiles loaded at startup, with no request to Microsoft Graph: it describes a workflow, not the state of any assessment, which get_assessment reads.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  // Not open world: it reads the server's own configuration and reaches nothing outside the process.
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object(DESCRIBE_WORKFLOW_INPUT_SCHEMA),
  outputSchema: DESCRIBE_WORKFLOW_OUTPUT_SCHEMA,
  handler: runDescribeAssessmentWorkflow,
};
