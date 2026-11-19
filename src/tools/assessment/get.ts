import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { odataString, queryListItems, queryListItemsUpTo } from "../../graph/lists.js";
import { sanitizeFolderName } from "../../domain/assessment/templates.js";
import { lifecycleReadiness, recordFromFields, type ActionReadiness, type AssessmentRecord } from "../../domain/assessment/state.js";
import type { JournalEntry } from "../../store/types.js";
import { resolveAssessmentContext } from "./context.js";
import { findAssessmentById, findVendor, readAssessmentState } from "./read-state.js";
import { ARTIFACT_PRESENCE_SHAPE, ASSESSMENT_SUMMARY_SHAPE, FINDING_READ_SHAPE, JOURNAL_ENTRY_SHAPE, JOURNAL_SUMMARY_SHAPE, READINESS_SHAPE } from "./output.js";
import { inWords as joined } from "../../domain/words.js";
import { readJournal } from "./journal.js";

export const GET_INPUT_CONSTRAINTS = "Exactly one of assessmentId, vendor or status is given, and include is given only with assessmentId.";

/**
 * A status listing has no natural bound: completed assessments accumulate for as long as the list
 * lives. It stops here and says so, where an unbounded query would page until it threw.
 */
export const STATUS_LISTING_LIMIT = 200;

/** The three statuses by the names the tool takes; the profile holds the labels the list stores. */
const STATUS_KEYS = { in_progress: "inProgress", completed: "completed", provisional: "provisional" } as const;

export const GET_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('The assessment profile to read under, for example "vendor-assessments".'),
  assessmentId: z.string().min(1).optional().describe('One assessment to read in full, for example "ASM-2026-00002".'),
  vendor: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('A vendor whose assessments to list, for example "Acme Corp". Matched on the folder name the server derives from it.'),
  status: z
    .enum(["in_progress", "completed", "provisional"])
    .optional()
    .describe('A status whose assessments to list across every vendor, for example "in_progress" for everything still open. The server maps it to the profile\'s own label, and returns at most 200, saying so when more exist.'),
  include: z
    .array(z.enum(["findings", "journal"]))
    .max(2)
    .optional()
    .describe('More to read on an id lookup, for example ["findings", "journal"]: "findings" reads the recorded findings and the summary back from the lists, and "journal" returns every journal entry rather than the summary alone.'),
} satisfies z.ZodRawShape;

export const GET_OUTPUT_SCHEMA = {
  found: z.boolean().describe("True when at least one assessment matched, for example false for an id no item carries."),
  assessment: z.object(ASSESSMENT_SUMMARY_SHAPE).optional().describe('The assessment read by id, for example {"assessmentId": "ASM-2026-00002", "itemId": "2"}. Absent on a listing.'),
  artifacts: z
    .array(z.object(ARTIFACT_PRESENCE_SHAPE))
    .optional()
    .describe('Each artifact kind at its canonical path as read, for example [{"kind": "dossier", "present": true}]. Absent on a listing.'),
  readiness: z
    .array(z.object(READINESS_SHAPE))
    .optional()
    .describe(
      'What each lifecycle tool\'s precondition found on the state this call read, for example [{"tool": "record_findings", "ready": true}]. It is the tool\'s own check, and each tool reads the state again when called. A transition already made is reported by that tool, not refused, although it shows here as not ready. Absent on a listing.',
    ),
  journal: z.object(JOURNAL_SUMMARY_SHAPE).optional().describe('A summary of the assessment\'s journal, for example {"entries": 7}. Absent on a listing.'),
  journalEntries: z
    .array(z.object(JOURNAL_ENTRY_SHAPE))
    .optional()
    .describe('Every journal entry under this assessment id, oldest first, for example [{"operation": "folder_created"}]. Present only when include names "journal". The writes an open makes before the id exists are journaled under a placeholder and are not here.'),
  summary: z.string().optional().describe('The assessment summary record_findings wrote to the item, for example "Three findings, one high.". Present only when include names "findings" and the item holds one.'),
  findings: z
    .array(z.object(FINDING_READ_SHAPE))
    .optional()
    .describe('The findings recorded for this assessment as the Findings list holds them, for example [{"key": "F-1", "risk": "High"}]. Present only when include names "findings".'),
  assessments: z
    .array(z.object(ASSESSMENT_SUMMARY_SHAPE))
    .optional()
    .describe('Every assessment for the vendor or holding the status, for example two items for a vendor assessed twice. Absent on an id lookup.'),
  truncated: z.boolean().optional().describe("True when a status listing stopped at 200 assessments and more exist that were not read, for example true for a list holding years of completed assessments. Absent otherwise."),
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
  // readJournal returns entries ascending by `at`, so the last is the latest.
  return { entries: entries.length, lastAt: entries.at(-1)?.at, byOperation };
}

/**
 * The readiness as a sentence. Tools refused for one reason are named
 * together, so an assessment that is completed says so once, not four times.
 */
export function readinessText(readiness: readonly ActionReadiness[]): string {
  const name = (entry: ActionReadiness): string => (entry.target === undefined ? entry.tool : `${entry.tool} to ${entry.target}`);
  const ready = readiness.filter((entry) => entry.ready).map(name);
  const reasons = new Map<string, string[]>();
  for (const entry of readiness.filter((candidate) => !candidate.ready)) {
    const reason = `expected ${entry.expected ?? "(not stated)"}, observed ${entry.observed ?? "(not stated)"}`;
    reasons.set(reason, [...(reasons.get(reason) ?? []), name(entry)]);
  }
  if (ready.length === 0 && reasons.size === 1) return `On what this call read: no lifecycle tool would proceed (${[...reasons.keys()][0]!}).`;
  const refused = [...reasons].map(([reason, names]) => `${joined(names)} would be refused (${reason})`);
  const proceed = ready.length === 0 ? "no lifecycle tool would proceed" : `${joined(ready)} would proceed`;
  return `On what this call read: ${[proceed, ...refused].join("; ")}.`;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runGetAssessment(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const selectors = [args.assessmentId, args.vendor, args.status].filter((value) => value !== undefined).length;
  if (selectors !== 1 || (args.include !== undefined && args.assessmentId === undefined)) {
    return { isError: true, content: [{ type: "text" as const, text: GET_INPUT_CONSTRAINTS }] };
  }
  if (args.vendor !== undefined && sanitizeFolderName(args.vendor).length === 0) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `The vendor name "${args.vendor}" has no characters SharePoint allows in a folder name, so no assessment could be filed under it. Nothing was read.` }],
    };
  }
  const subject: FailureSubject = { tool: "get_assessment", profileId: args.profileId };
  const before = context.graph.requests();

  try {
    const ac = await resolveAssessmentContext(context, args.profileId);
    subject.siteUrl = ac.profile.identity.siteUrl;
    subject.library = ac.profile.identity.library;
    const listName = ac.profile.lists.assessments.name;
    const columns = ac.profile.lists.assessments.columns;

    if (args.assessmentId !== undefined) {
      const record = await findAssessmentById(context.graph, ac, args.assessmentId);
      if (record === undefined) {
        return {
          structuredContent: { found: false, graphRequests: context.graph.requests() - before },
          content: [{ type: "text" as const, text: `No item in list "${listName}" carries the assessment id "${args.assessmentId}".` }],
        };
      }
      const state = await readAssessmentState(context.graph, ac, record);
      // The journal is keyed by the assessment id as the list stores it, which the lookup can match in
      // another case; entries written under a placeholder before the id existed are not read here.
      const assessmentId = record.assessmentId;
      const entries = await readJournal(context, ac, assessmentId);
      const journal = journalSummary(entries);
      const artifacts = state.artifacts.map((artifact) => ({
        kind: artifact.kind,
        path: artifact.path,
        present: artifact.present,
        eTag: artifact.eTag,
        size: artifact.size,
        ...(artifact.occupant === undefined ? {} : { occupant: artifact.occupant }),
      }));
      // The tools' own preconditions over the state just read, so this cannot disagree with them.
      const readiness = lifecycleReadiness(state, ac.profile.lifecycle, `${listName} where ${columns.assessmentId} is "${args.assessmentId}"`);

      const wantFindings = args.include?.includes("findings") === true;
      const wantJournal = args.include?.includes("journal") === true;
      let findings: z.infer<z.ZodObject<typeof FINDING_READ_SHAPE>>[] | undefined;
      if (wantFindings) {
        const fc = ac.profile.lists.findings.columns;
        const rows = await queryListItems(context.graph, { siteId: ac.siteId, listName: ac.profile.lists.findings.name, filter: `fields/${fc.assessmentId} eq ${odataString(assessmentId)}` });
        findings = rows.map((row) => ({
          key: text(row.fields[fc.findingKey]),
          itemId: row.id,
          risk: text(row.fields[fc.risk]),
          observation: text(row.fields[fc.observation]),
          recommendation: text(row.fields[fc.recommendation]),
        }));
      }

      const output = {
        found: true,
        assessment: assessmentSummary(record),
        artifacts,
        readiness,
        journal,
        ...(wantJournal ? { journalEntries: entries } : {}),
        ...(wantFindings && record.summary !== undefined ? { summary: record.summary } : {}),
        ...(findings === undefined ? {} : { findings }),
        graphRequests: context.graph.requests() - before,
      };

      const present = artifacts.filter((artifact) => artifact.present).map((artifact) => artifact.kind);
      const sentences = [
        `${assessmentId}: item ${record.itemId} in ${listName}, status ${JSON.stringify(record.status ?? null)}, state ${JSON.stringify(record.state ?? null)}.`,
        state.rootPath === undefined
          ? `The workspace root path could not be computed: ${state.rootPathUnavailable ?? "the state carries no root path"}, so the drive was not read.`
          : `Workspace root ${state.rootPath} ${state.rootPresent ? "is present" : "was not found"}. Artifacts present: ${present.length === 0 ? "none" : present.join(", ")}.`,
        `Journal entries: ${journal.entries}.`,
        readinessText(readiness),
      ];
      if (findings !== undefined) {
        sentences.push(
          `${record.summary === undefined ? "The item holds no summary." : `Summary: ${JSON.stringify(record.summary)}`} Findings recorded: ${findings.length}.` +
            findings.map((finding) => ` ${finding.key ?? `item ${finding.itemId} (no key)`} (${finding.risk ?? "no risk"}): ${finding.observation ?? "(no observation)"} Recommendation: ${finding.recommendation ?? "(none)"}`).join(""),
        );
      }
      if (wantJournal && entries.length > 0) {
        sentences.push(`Journal, oldest first: ${entries.map((entry) => `${entry.at} ${entry.stage} ${entry.operation} ${entry.target}`).join("; ")}.`);
      }
      return { structuredContent: output, content: [{ type: "text" as const, text: sentences.join(" ") }] };
    }

    if (args.status !== undefined) {
      const label = ac.profile.lifecycle.status[STATUS_KEYS[args.status]];
      const { items, more } = await queryListItemsUpTo(context.graph, { siteId: ac.siteId, listName, filter: `fields/${columns.status} eq ${odataString(label)}`, limit: STATUS_LISTING_LIMIT });
      const assessments = items.map((item) => assessmentSummary(recordFromFields(item.fields, item.id, item.eTag, columns)));
      const output = { found: assessments.length > 0, assessments, ...(more ? { truncated: true } : {}), graphRequests: context.graph.requests() - before };
      const counted = more
        ? `The first ${assessments.length} assessments in ${listName} with ${columns.status} "${label}", and more exist that were not read: `
        : `${assessments.length} ${assessments.length === 1 ? "assessment" : "assessments"} in ${listName} with ${columns.status} "${label}": `;
      const described =
        assessments.length === 0
          ? `No item in list "${listName}" has ${columns.status} "${label}".`
          : counted +
            assessments.map((summary) => `${summary.assessmentId ?? `item ${summary.itemId} (no id)`} for ${summary.vendor ?? "(no vendor)"} (${summary.scope ?? "no scope"})`).join(", ") +
            ".";
      return { structuredContent: output, content: [{ type: "text" as const, text: described }] };
    }

    // Filed under the vendor's stored folder name when it has one, as open_assessment files it.
    const vendorFolder = (await findVendor(context.graph, ac, args.vendor!)).folder;
    const items = await queryListItems(context.graph, { siteId: ac.siteId, listName, filter: `fields/${columns.vendorFolder} eq ${odataString(vendorFolder)}` });
    const assessments = items.map((item) => assessmentSummary(recordFromFields(item.fields, item.id, item.eTag, columns)));
    const output = { found: assessments.length > 0, assessments, graphRequests: context.graph.requests() - before };
    const described =
      assessments.length === 0
        ? `No item in list "${listName}" has ${columns.vendorFolder} "${vendorFolder}".`
        : `${assessments.length} ${assessments.length === 1 ? "assessment" : "assessments"} in ${listName} for ${columns.vendorFolder} "${vendorFolder}": ` +
          assessments.map((summary) => `${summary.assessmentId ?? `item ${summary.itemId} (no id)`} ${JSON.stringify(summary.status ?? null)}`).join(", ") +
          ".";
    return { structuredContent: output, content: [{ type: "text" as const, text: described }] };
  } catch (error) {
    console.error(`get_assessment failed for profile "${args.profileId}"`, error);
    return { isError: true, content: [{ type: "text" as const, text: describeToolFailure(error, subject) }] };
  }
}
