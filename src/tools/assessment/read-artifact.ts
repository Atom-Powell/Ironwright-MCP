import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { readDriveItem } from "../../graph/items.js";
import { downloadDriveItem } from "../../graph/content.js";
import { profileArtifactKinds, resolveAssessmentContext, unknownKindText } from "./context.js";
import { findAssessmentById, recordWorkspacePaths } from "./read-state.js";
import { sha256Hex } from "./hash.js";

export const READ_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('The assessment profile, for example "vendor-assessments".'),
  assessmentId: z.string().min(1).describe('The id open_assessment returned, for example "ASM-2026-00002".'),
  kind: z
    .string()
    .min(1)
    .describe('An artifact kind the profile names, for example "dossier". "publication" is allowed and is returned only if its bytes decode as UTF-8 text.'),
} satisfies z.ZodRawShape;

export const READ_OUTPUT_SCHEMA = {
  assessmentId: z.string().describe('For example "ASM-2026-00002".'),
  kind: z.string().describe('For example "dossier".'),
  path: z.string().describe('Library-relative path read, for example "Assessments/Acme Corp/ASM-2026-00002/Research/Acme Corp_Research_Dossier.md".'),
  content: z.string().describe('The file\'s bytes decoded as UTF-8, for example "# Acme Corp research dossier ...".'),
  bytes: z.number().int().describe("Bytes downloaded, for example 2048."),
  sha256: z.string().describe('sha256 of the bytes downloaded, for example "9f86d0...".'),
  eTag: z.string().optional().describe('The item\'s ETag as read, for example "\\"{...},2\\"". Absent when Graph returned none.'),
  graphRequests: z.number().int().describe("Graph requests this call issued, for example 7."),
} satisfies z.ZodRawShape;

const InputObject = z.object(READ_INPUT_SCHEMA);
const TOOL = "read_assessment_artifact";

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

export async function runReadAssessmentArtifact(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: TOOL, profileId: args.profileId };
  const before = context.graph.requests();

  try {
    const kinds = profileArtifactKinds(context, args.profileId);
    if (kinds !== undefined && !kinds.includes(args.kind)) return failure(unknownKindText(args.profileId, args.kind, kinds));

    const ac = await resolveAssessmentContext(context, args.profileId);
    subject.siteUrl = ac.profile.identity.siteUrl;
    subject.library = ac.profile.identity.library;
    const listName = ac.profile.lists.assessments.name;

    const record = await findAssessmentById(context.graph, ac, args.assessmentId);
    if (record === undefined) return failure(`No item in list "${listName}" carries the assessment id "${args.assessmentId}". Nothing was read from the drive.`);
    const paths = recordWorkspacePaths(ac, record);
    if (paths === undefined) {
      return failure(`${listName} item ${record.itemId} lacks the Title or vendor folder the profile's paths are built from, so no artifact path could be computed. Nothing was read from the drive.`);
    }
    const path = paths.artifacts[args.kind]!;

    const lookup = await readDriveItem(context.graph, { driveId: ac.driveId, path });
    if (lookup.kind !== "found") return failure(`No file is at ${path}, where the profile puts the ${args.kind} for ${args.assessmentId}.`);
    if (lookup.item.isFolder) return failure(`A folder, not a file, is at ${path}, where the profile puts the ${args.kind} for ${args.assessmentId}.`);

    const bytes = await downloadDriveItem(context.graph, { driveId: ac.driveId, workbookPath: path });
    const sha256 = sha256Hex(bytes);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return failure(`The ${args.kind} at ${path} is not UTF-8 text, so its content is not returned: ${bytes.byteLength} bytes, sha256 ${sha256}.`);
    }

    const output = {
      assessmentId: args.assessmentId,
      kind: args.kind,
      path,
      content,
      bytes: bytes.byteLength,
      sha256,
      eTag: lookup.item.eTag,
      graphRequests: context.graph.requests() - before,
    };
    const text = `Read the ${args.kind} at ${path}: ${output.bytes} bytes, sha256 ${sha256.slice(0, 12)}, ETag ${lookup.item.eTag ?? "(none returned)"}.`;
    return { structuredContent: output, content: [{ type: "text" as const, text }] };
  } catch (error) {
    console.error(`${TOOL} failed for profile "${args.profileId}"`, error);
    return { isError: true, content: [{ type: "text" as const, text: describeToolFailure(error, subject) }] };
  }
}
