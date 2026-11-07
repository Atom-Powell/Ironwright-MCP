import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { odataString, queryListItems } from "../../graph/lists.js";
import { sanitizeFolderName } from "../../domain/assessment/templates.js";
import { recordFromFields, type AssessmentRecord } from "../../domain/assessment/state.js";
import type { JournalEntry } from "../../store/types.js";
import { resolveAssessmentContext } from "./context.js";
import { findAssessmentById, readAssessmentState } from "./read-state.js";
import { ARTIFACT_PRESENCE_SHAPE, ASSESSMENT_SUMMARY_SHAPE, JOURNAL_SUMMARY_SHAPE } from "./output.js";

export const GET_INPUT_CONSTRAINTS = "Exactly one of assessmentId or vendor is given.";

export const GET_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('The assessment profile to read under, for example "vendor-assessments".'),
  assessmentId: z.string().min(1).optional().describe('One assessment to read in full, for example "ASM-2026-00002".'),
  vendor: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('A vendor whose assessments to list, for example "Acme Corp". Matched on the folder name the server derives from it.'),
} satisfies z.ZodRawShape;

export const GET_OUTPUT_SCHEMA = {
  found: z.boolean().describe("True when at least one assessment matched, for example false for an id no item carries."),
  assessment: z.object(ASSESSMENT_SUMMARY_SHAPE).optional().describe('The assessment read by id, for example {"assessmentId": "ASM-2026-00002", "itemId": "2"}. Absent on a vendor lookup.'),
  artifacts: z
    .array(z.object(ARTIFACT_PRESENCE_SHAPE))
    .optional()
    .describe('Each artifact kind at its canonical path as read, for example [{"kind": "dossier", "present": true}]. Absent on a vendor lookup.'),
  journal: z.object(JOURNAL_SUMMARY_SHAPE).optional().describe('A summary of the assessment\'s journal, for example {"entries": 7}. Absent on a vendor lookup.'),
  assessments: z
    .array(z.object(ASSESSMENT_SUMMARY_SHAPE))
    .optional()
    .describe('Every assessment for the vendor, for example two items for a vendor assessed twice. Absent on an id lookup.'),
  graphRequests: z.number().int().describe("Graph requests this call issued, for example 7."),
} satisfies z.ZodRawShape;

const InputObject = z.object(GET_INPUT_SCHEMA);

export function assessmentSummary(record: AssessmentRecord): z.infer<z.ZodObject<typeof ASSESSMENT_SUMMARY_SHAPE>> {
  return {
    assessmentId: record.assessmentId,
    itemId: record.itemId,
    vendor: record.vendorTitle,
    vendorFolder: record.vendorFolder,
    scope: record.scope,
    status: record.status,
    state: record.state,
    disposition: record.disposition,
    risk: record.risk,
  };
}

function journalSummary(entries: readonly JournalEntry[]): z.infer<z.ZodObject<typeof JOURNAL_SUMMARY_SHAPE>> {
  const byOperation: Record<string, number> = {};
  for (const entry of entries) byOperation[entry.operation] = (byOperation[entry.operation] ?? 0) + 1;
  // listJournal returns entries ascending by `at`, so the last is the latest.
  return { entries: entries.length, lastAt: entries.at(-1)?.at, byOperation };
}

export async function runGetAssessment(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  if ((args.assessmentId === undefined) === (args.vendor === undefined)) {
    return { isError: true, content: [{ type: "text" as const, text: GET_INPUT_CONSTRAINTS }] };
  }
  const subject: FailureSubject = { tool: "get_assessment", profileId: args.profileId };
  const before = context.graph.requests();

  try {
    const ac = await resolveAssessmentContext(context, args.profileId);
    subject.siteUrl = ac.profile.identity.siteUrl;
    subject.library = ac.profile.identity.library;
    const listName = ac.profile.lists.assessments.name;

    if (args.assessmentId !== undefined) {
      const record = await findAssessmentById(context.graph, ac, args.assessmentId);
      if (record === undefined) {
        return {
          structuredContent: { found: false, graphRequests: context.graph.requests() - before },
          content: [{ type: "text" as const, text: `No item in list "${listName}" carries the assessment id "${args.assessmentId}".` }],
        };
      }
      const state = await readAssessmentState(context.graph, ac, record);
      // The journal is keyed by the assessment id; entries written under a placeholder before the id existed are not read here.
      const journal = journalSummary(await context.store.listJournal(ac.profile.profileId, args.assessmentId));
      const artifacts = state.artifacts.map((artifact) => ({ kind: artifact.kind, path: artifact.path, present: artifact.present, eTag: artifact.eTag, size: artifact.size }));
      const output = { found: true, assessment: assessmentSummary(record), artifacts, journal, graphRequests: context.graph.requests() - before };
      const present = artifacts.filter((artifact) => artifact.present).map((artifact) => artifact.kind);
      const text =
        `${args.assessmentId}: item ${record.itemId} in ${listName}, status ${JSON.stringify(record.status ?? null)}, state ${JSON.stringify(record.state ?? null)}. ` +
        `Workspace root ${state.rootPath ?? "(not computed)"} ${state.rootPresent ? "is present" : "was not found"}. ` +
        `Artifacts present: ${present.length === 0 ? "none" : present.join(", ")}. Journal entries: ${journal.entries}.`;
      return { structuredContent: output, content: [{ type: "text" as const, text }] };
    }

    const vendorFolder = sanitizeFolderName(args.vendor!);
    const columns = ac.profile.lists.assessments.columns;
    const items = await queryListItems(context.graph, { siteId: ac.siteId, listName, filter: `fields/${columns.vendorFolder} eq ${odataString(vendorFolder)}` });
    const assessments = items.map((item) => assessmentSummary(recordFromFields(item.fields, item.id, item.eTag, columns)));
    const output = { found: assessments.length > 0, assessments, graphRequests: context.graph.requests() - before };
    const text =
      assessments.length === 0
        ? `No item in list "${listName}" has ${columns.vendorFolder} "${vendorFolder}".`
        : `${assessments.length} ${assessments.length === 1 ? "assessment" : "assessments"} in ${listName} for ${columns.vendorFolder} "${vendorFolder}": ` +
          assessments.map((summary) => `${summary.assessmentId ?? `item ${summary.itemId} (no id)`} ${JSON.stringify(summary.status ?? null)}`).join(", ") +
          ".";
    return { structuredContent: output, content: [{ type: "text" as const, text }] };
  } catch (error) {
    console.error(`get_assessment failed for profile "${args.profileId}"`, error);
    return { isError: true, content: [{ type: "text" as const, text: describeToolFailure(error, subject) }] };
  }
}
