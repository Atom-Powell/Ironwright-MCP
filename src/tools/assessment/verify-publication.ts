import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { readDriveItem } from "../../graph/items.js";
import { resolveAssessmentContext } from "./context.js";
import { findAssessmentById, recordWorkspacePaths } from "./read-state.js";

export const VERIFY_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('The assessment profile, for example "vendor-assessments".'),
  assessmentId: z.string().min(1).describe('The id open_assessment returned, for example "ASM-2026-00002".'),
} satisfies z.ZodRawShape;

export const VERIFY_OUTPUT_SCHEMA = {
  present: z.boolean().describe("True when a file named exactly the expected name is at the canonical publication path, for example false before the publisher has run."),
  path: z.string().describe('Library-relative canonical path read, for example "Assessments/Acme Corp/ASM-2026-00002/Published/Acme Corp_ASM-2026-00002_Risk_Assessment.docx".'),
  expectedName: z.string().describe('The file name the profile\'s publication template renders, for example "Acme Corp_ASM-2026-00002_Risk_Assessment.docx".'),
  name: z.string().optional().describe('The name of the file found at the path, for example "Acme Corp_ASM-2026-00002_Risk_Assessment.docx". Present with present false when that name differs from expectedName by case; absent when no file is at the path.'),
  size: z.number().int().optional().describe("The file's size in bytes as read, for example 48213. Absent when no file is present."),
  eTag: z.string().optional().describe('The file\'s ETag as read, for example "\\"{GUID},1\\"". Absent when no file is present.'),
  lastModifiedDateTime: z.string().optional().describe('When the file was last modified, for example "2026-11-07T20:39:33Z". Absent when no file is present.'),
  webUrl: z.string().optional().describe('The file\'s browser URL, for example "https://contoso.sharepoint.com/sites/Example/Shared%20Documents/...". Absent when no file is present.'),
  graphRequests: z.number().int().describe("Graph requests this call issued, for example 4."),
} satisfies z.ZodRawShape;

const InputObject = z.object(VERIFY_INPUT_SCHEMA);
const TOOL = "verify_publication";

export async function runVerifyPublication(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: TOOL, profileId: args.profileId };
  const before = context.graph.requests();

  try {
    const ac = await resolveAssessmentContext(context, args.profileId);
    subject.siteUrl = ac.profile.identity.siteUrl;
    subject.library = ac.profile.identity.library;
    const listName = ac.profile.lists.assessments.name;

    const record = await findAssessmentById(context.graph, ac, args.assessmentId);
    if (record === undefined) {
      return { isError: true, content: [{ type: "text" as const, text: `No item in list "${listName}" carries the assessment id "${args.assessmentId}". Nothing was read from the drive.` }] };
    }
    const paths = recordWorkspacePaths(ac, record);
    if (paths === undefined) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `${listName} item ${record.itemId} lacks the Title or vendor folder the profile's paths are built from, so the publication path could not be computed. Nothing was read from the drive.` }],
      };
    }
    // The profile schema requires a publication kind, so its path is always rendered.
    const path = paths.artifacts.publication!;
    const expectedName = path.split("/").at(-1)!;

    const lookup = await readDriveItem(context.graph, { driveId: ac.driveId, path });
    if (lookup.kind !== "found" || lookup.item.isFolder) {
      const output = { present: false, path, expectedName, graphRequests: context.graph.requests() - before };
      const text =
        lookup.kind === "found"
          ? `The publication for ${args.assessmentId} is not present: a folder, not a file, is at ${path}.`
          : `The publication is not at ${path}; Graph answered 404 for that path.`;
      return { structuredContent: output, content: [{ type: "text" as const, text }] };
    }

    const item = lookup.item;
    // SharePoint names are case insensitive, so the lookup above may answer a file whose name differs
    // from the canonical one only by case; the 9c sitting measures whether it does. That file is not
    // the publication the template names, and reporting it present would let a misnamed upload pass.
    if (item.name !== expectedName) {
      const output = { present: false, path, expectedName, name: item.name, graphRequests: context.graph.requests() - before };
      const text =
        `The publication for ${args.assessmentId} is not present under its expected name: a file named "${item.name}" is at ${path}, ` +
        `and the expected name is "${expectedName}".`;
      return { structuredContent: output, content: [{ type: "text" as const, text }] };
    }
    const output = {
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
      `The publication for ${args.assessmentId} is at ${path}: ${item.name}, ` +
      `${item.size === undefined ? "size not returned" : `${item.size} bytes`}, last modified ${item.lastModifiedDateTime ?? "(not returned)"}.`;
    return { structuredContent: output, content: [{ type: "text" as const, text }] };
  } catch (error) {
    console.error(`${TOOL} failed for profile "${args.profileId}"`, error);
    return { isError: true, content: [{ type: "text" as const, text: describeToolFailure(error, subject) }] };
  }
}
