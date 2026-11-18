import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { readDriveItem } from "../../graph/items.js";
import { fileNameOf } from "../../domain/assessment/templates.js";
import { profileLifecycle, resolveAssessmentContext } from "./context.js";
import { artifactAt, findAssessmentById, recordWorkspacePaths } from "./read-state.js";

export const VERIFY_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('The assessment profile, for example "vendor-assessments".'),
  assessmentId: z.string().min(1).describe('The id open_assessment returned, for example "ASM-2026-00002".'),
  kind: z
    .string()
    .min(1)
    .optional()
    .describe('The external artifact kind to check, for example "publication". Optional when the profile lists exactly one external kind, which is then the one checked.'),
} satisfies z.ZodRawShape;

export const VERIFY_OUTPUT_SCHEMA = {
  kind: z.string().describe('The external artifact kind checked, for example "publication".'),
  present: z.boolean().describe("True when a file named exactly the expected name is at the kind's canonical path, for example false before the publisher has run."),
  path: z.string().describe('Library-relative canonical path read, for example "Assessments/Acme Corp/ASM-2026-00002/Published/Acme Corp_ASM-2026-00002_Risk_Assessment.docx".'),
  expectedName: z.string().describe('The file name the profile\'s template for the kind renders, for example "Acme Corp_ASM-2026-00002_Risk_Assessment.docx".'),
  name: z.string().optional().describe('The name of the file found at the path, for example "Acme Corp_ASM-2026-00002_Risk_Assessment.docx". Present with present false when that name differs from expectedName by case; absent when no file is at the path.'),
  size: z.number().int().optional().describe("The file's size in bytes as read, for example 48213. Absent when no file is present."),
  eTag: z.string().optional().describe('The file\'s ETag as read, for example "\\"{GUID},1\\"". Absent when no file is present.'),
  lastModifiedDateTime: z.string().optional().describe('When the file was last modified, for example "2026-11-07T20:39:33Z". Absent when no file is present.'),
  webUrl: z.string().optional().describe('The file\'s browser URL, for example "https://contoso.sharepoint.com/sites/Example/Shared%20Documents/...". Absent when no file is present.'),
  graphRequests: z.number().int().describe("Graph requests this call issued, for example 4."),
} satisfies z.ZodRawShape;

const InputObject = z.object(VERIFY_INPUT_SCHEMA);
const TOOL = "verify_publication";

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/**
 * Which kind this call checks, or the words for why there is none. Decided from the registry,
 * before any Graph request. A publication is whatever the profile lists as produced outside the
 * server: one such kind needs no naming, which is the vendor risk workflow.
 */
function kindToCheck(profileId: string, external: readonly string[], asked: string | undefined): { kind: string } | { refusal: string } {
  if (asked !== undefined) {
    if (external.includes(asked)) return { kind: asked };
    const listed = external.length === 0 ? "It lists none." : `Its external kinds are ${external.join(", ")}.`;
    return { refusal: `Profile "${profileId}" does not list "${asked}" as an external artifact kind. ${listed} Nothing was read.` };
  }
  if (external.length === 1) return { kind: external[0]! };
  if (external.length === 0) return { refusal: `Profile "${profileId}" lists no external artifact kind, so there is nothing for ${TOOL} to check. Nothing was read.` };
  return { refusal: `Profile "${profileId}" lists more than one external artifact kind (${external.join(", ")}); name the one to check as kind. Nothing was read.` };
}

export async function runVerifyPublication(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: TOOL, profileId: args.profileId };
  const before = context.graph.requests();

  try {
    // Undefined for a profile that is not an assessment profile, which resolveAssessmentContext
    // refuses below in its own words.
    const lifecycle = profileLifecycle(context, args.profileId);
    const chosen = lifecycle === undefined ? undefined : kindToCheck(args.profileId, lifecycle.external, args.kind);
    if (chosen !== undefined && "refusal" in chosen) return failure(chosen.refusal);

    const ac = await resolveAssessmentContext(context, args.profileId);
    subject.siteUrl = ac.profile.identity.siteUrl;
    subject.library = ac.profile.identity.library;
    const listName = ac.profile.lists.assessments.name;
    const kind = chosen!.kind;

    const record = await findAssessmentById(context.graph, ac, args.assessmentId);
    if (record === undefined) {
      return { isError: true, content: [{ type: "text" as const, text: `No item in list "${listName}" carries the assessment id "${args.assessmentId}". Nothing was read from the drive.` }] };
    }
    const paths = recordWorkspacePaths(ac, record);
    if (paths === undefined) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `${listName} item ${record.itemId} lacks the Title or vendor folder the profile's paths are built from, so the ${kind} path could not be computed. Nothing was read from the drive.` }],
      };
    }
    // The profile schema refuses an external kind the workspace does not define, so its path is always rendered.
    const path = paths.artifacts[kind]!;
    const expectedName = fileNameOf(path);
    // The id as the list stores it, which the lookup can match in another case than the caller's.
    const assessmentId = record.assessmentId;

    // The answer transition_assessment acts on: present only under the exact name the template
    // renders, which the 2026-11-09 campaign showed a case insensitive lookup does not guarantee.
    const at = artifactAt(await readDriveItem(context.graph, { driveId: ac.driveId, path }), path);
    if (!at.present && (at.occupant === undefined || at.occupant.isFolder)) {
      const output = { kind, present: false, path, expectedName, graphRequests: context.graph.requests() - before };
      const text =
        at.occupant !== undefined
          ? `The ${kind} for ${assessmentId} is not present: a folder, not a file, is at ${path}.`
          : `The ${kind} is not at ${path}; Graph answered 404 for that path.`;
      return { structuredContent: output, content: [{ type: "text" as const, text }] };
    }
    if (!at.present) {
      const name = at.occupant!.name;
      const output = { kind, present: false, path, expectedName, name, graphRequests: context.graph.requests() - before };
      const text =
        `The ${kind} for ${assessmentId} is not present under its expected name: a file named "${name}" is at ${path}, ` +
        `and the expected name is "${expectedName}".`;
      return { structuredContent: output, content: [{ type: "text" as const, text }] };
    }
    const item = at.item;
    const output = {
      kind,
      present: true,
      path,
      expectedName,
      name: item.name,
      size: item.size,
      eTag: item.eTag,
      lastModifiedDateTime: item.lastModifiedDateTime,
      webUrl: item.webUrl,
      graphRequests: context.graph.requests() - before,
    };
    const text =
      `The ${kind} for ${assessmentId} is at ${path}: ${item.name}, ` +
      `${item.size === undefined ? "size not returned" : `${item.size} bytes`}, last modified ${item.lastModifiedDateTime ?? "(not returned)"}.`;
    return { structuredContent: output, content: [{ type: "text" as const, text }] };
  } catch (error) {
    console.error(`${TOOL} failed for profile "${args.profileId}"`, error);
    return { isError: true, content: [{ type: "text" as const, text: describeToolFailure(error, subject) }] };
  }
}
