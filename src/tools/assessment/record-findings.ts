import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { createListItem, odataString, queryListItems, updateListItemFields, type ListItemRecord } from "../../graph/lists.js";
import { isAssessmentProfile } from "../../domain/profile/library.js";
import { allOf, fieldsFor, requireArtifact, requireInProgress, requireRecord } from "../../domain/assessment/state.js";
import { resolveAssessmentContext } from "./context.js";
import { findAssessmentById, readAssessmentState } from "./read-state.js";
import { appendJournal } from "./journal.js";
import { refusalResult } from "./refusal.js";

export const RECORD_INPUT_CONSTRAINTS = "Every finding's risk is one of the profile's risk labels, and no two findings share a key.";

export const FINDING_SCHEMA = z.object({
  key: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .describe('Stable key within the assessment, for example "F-1" or "access-control". A retry with the same key updates rather than duplicates.'),
  observation: z.string().min(1).max(20000).describe('What was found, for example "SOC 2 Type II report dated 2025-03 covers only the hosting subsidiary."'),
  risk: z.string().min(1).describe('One of the profile\'s risk labels, for example "High".'),
  recommendation: z.string().min(1).max(20000).describe('What to do, for example "Request the parent company report before contract signature."'),
});

export const RECORD_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('For example "vendor-assessments".'),
  assessmentId: z.string().min(1).describe('For example "ASM-2026-00002".'),
  findings: z.array(FINDING_SCHEMA).min(1).max(100).describe("One entry per finding, for example a list of three."),
  summary: z.string().min(1).max(20000).describe('The assessment summary written to the assessment item, for example "Three findings, one high."'),
} satisfies z.ZodRawShape;

export const RECORD_OUTPUT_SCHEMA = {
  assessmentId: z.string().describe('For example "ASM-2026-00002".'),
  created: z.number().int().describe("Findings created as new list items, for example 2."),
  updated: z.number().int().describe("Existing findings whose values were rewritten, for example 1."),
  unchanged: z.number().int().describe("Existing findings that already held the values sent and were not written, for example 0."),
  findings: z
    .array(
      z.object({
        key: z.string().describe('The finding key, for example "F-1".'),
        itemId: z.string().describe('The Findings list item id, for example "11".'),
        outcome: z.enum(["created", "updated", "unchanged"]).describe('What happened to the finding, for example "created".'),
      }),
    )
    .describe('One entry per finding sent, in the order sent, for example [{"key": "F-1", "itemId": "11", "outcome": "created"}].'),
  correlationId: z.string().describe('For example "6f1c...".'),
  graphRequests: z.number().int().describe("Graph requests this call issued, for example 11."),
} satisfies z.ZodRawShape;

const InputObject = z.object(RECORD_INPUT_SCHEMA);
const TOOL = "record_findings";
const STAGE = "FINDINGS";

type Outcome = "created" | "updated" | "unchanged";

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/** The first column whose answered value differs from what was sent, described, or undefined when all agree. */
export function firstMismatch(sent: Record<string, string>, answered: Record<string, unknown>): string | undefined {
  for (const [column, value] of Object.entries(sent)) {
    if (answered[column] !== value) return `${column} read ${JSON.stringify(answered[column] ?? null)}, not ${JSON.stringify(value)}`;
  }
  return undefined;
}

/**
 * Checked from the registry before any Graph request, so a label or key the
 * call cannot use costs nothing. Undefined for a profile that is not an
 * assessment profile, which resolveAssessmentContext then reports in its own words.
 */
function inputProblem(context: ToolContext, args: z.infer<typeof InputObject>): string | undefined {
  const profile = context.profiles.getAny(args.profileId);
  if (!isAssessmentProfile(profile)) return undefined;
  const risks = profile.lifecycle.risks;
  for (const finding of args.findings) {
    if (!risks.includes(finding.risk)) {
      return `${RECORD_INPUT_CONSTRAINTS} Finding "${finding.key}" has risk "${finding.risk}"; the risk labels are ${risks.join(", ")}. Nothing was read or written.`;
    }
  }
  const seen = new Set<string>();
  for (const finding of args.findings) {
    if (seen.has(finding.key)) return `${RECORD_INPUT_CONSTRAINTS} The key "${finding.key}" is given more than once. Nothing was read or written.`;
    seen.add(finding.key);
  }
  return undefined;
}

export async function runRecordFindings(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: TOOL, profileId: args.profileId };
  const before = context.graph.requests();

  try {
    const problem = inputProblem(context, args);
    if (problem !== undefined) return failure(problem);

    const ac = await resolveAssessmentContext(context, args.profileId);
    subject.siteUrl = ac.profile.identity.siteUrl;
    subject.library = ac.profile.identity.library;
    const assessments = ac.profile.lists.assessments;
    const findingsList = ac.profile.lists.findings;
    const fc = findingsList.columns;

    const record = await findAssessmentById(context.graph, ac, args.assessmentId);
    const state = await readAssessmentState(context.graph, ac, record);
    const check = allOf(
      requireRecord(state, `${assessments.name} where ${assessments.columns.assessmentId} is "${args.assessmentId}"`),
      requireInProgress(state, ac.profile.lifecycle.status),
      requireArtifact(state, "dossier"),
    );
    if (!check.ok) return refusalResult(TOOL, STAGE, args.assessmentId, check);
    const item = record!;

    const existing = await queryListItems(context.graph, {
      siteId: ac.siteId,
      listName: findingsList.name,
      filter: `fields/${fc.assessmentId} eq ${odataString(args.assessmentId)}`,
    });
    const byKey = new Map<string, ListItemRecord[]>();
    for (const row of existing) {
      const key = row.fields[fc.findingKey];
      if (typeof key !== "string") continue;
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    for (const [key, rows] of byKey) {
      if (rows.length > 1) {
        return failure(
          `${rows.length} items in list "${findingsList.name}" carry the finding key "${key}" for ${args.assessmentId} (items ${rows.map((row) => row.id).join(", ")}); ` +
            "the server will not choose between them. Nothing was written.",
        );
      }
    }

    const outcomes: { key: string; itemId: string; outcome: Outcome }[] = [];
    for (const finding of args.findings) {
      const values = { [fc.observation]: finding.observation, [fc.risk]: finding.risk, [fc.recommendation]: finding.recommendation };
      const prior = byKey.get(finding.key)?.[0];
      if (prior !== undefined && firstMismatch(values, prior.fields) === undefined) {
        outcomes.push({ key: finding.key, itemId: prior.id, outcome: "unchanged" });
        continue;
      }
      let itemId: string;
      let sent: Record<string, string>;
      let answered: Record<string, unknown>;
      if (prior !== undefined) {
        sent = values;
        itemId = prior.id;
        answered = await updateListItemFields(context.graph, { siteId: ac.siteId, listName: findingsList.name, itemId, fields: sent });
        await appendJournal(context, ac, args.assessmentId, {
          stage: STAGE,
          operation: "list_item_updated",
          target: `${findingsList.name}/${itemId}`,
          ...(prior.eTag !== undefined ? { etagBefore: prior.eTag } : {}),
        });
        outcomes.push({ key: finding.key, itemId, outcome: "updated" });
      } else {
        sent = { Title: finding.key, [fc.assessmentId]: args.assessmentId, [fc.findingKey]: finding.key, ...values };
        const created = await createListItem(context.graph, { siteId: ac.siteId, listName: findingsList.name, fields: sent });
        itemId = created.id;
        answered = created.fields;
        await appendJournal(context, ac, args.assessmentId, {
          stage: STAGE,
          operation: "list_item_created",
          target: `${findingsList.name}/${itemId}`,
          ...(created.eTag !== undefined ? { etagAfter: created.eTag } : {}),
        });
        outcomes.push({ key: finding.key, itemId, outcome: "created" });
      }
      // Graph answers both writes with the item's fields after the write (L2a, L2b), which is the
      // read back. A disagreement stops the call before anything else is written; the journal entry
      // for the write stays, because Graph's 2xx said the write happened.
      const mismatch = firstMismatch(sent, answered);
      if (mismatch !== undefined) {
        return failure(
          `Graph accepted the write to ${findingsList.name} item ${itemId} for finding "${finding.key}", but its answer disagrees with what was sent: ${mismatch}. ` +
            "The journal records the write; nothing after it was written.",
        );
      }
    }

    const counts = {
      created: outcomes.filter((entry) => entry.outcome === "created").length,
      updated: outcomes.filter((entry) => entry.outcome === "updated").length,
      unchanged: outcomes.filter((entry) => entry.outcome === "unchanged").length,
    };
    const tally = `${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged`;

    // A retry whose summary and stage were already recorded is reported rather than written again.
    let closing: string;
    if (item.summary === args.summary && item.state === STAGE) {
      closing =
        counts.created + counts.updated === 0
          ? `Every finding already held the values sent, and ${assessments.name} item ${item.itemId} already held this summary and stage ${STAGE}. Nothing was written.`
          : `${assessments.name} item ${item.itemId} already held this summary and stage ${STAGE}, so it was not written.`;
    } else {
      const sent = fieldsFor(assessments.columns, { summary: args.summary, state: STAGE });
      const answered = await updateListItemFields(context.graph, { siteId: ac.siteId, listName: assessments.name, itemId: item.itemId, fields: sent });
      await appendJournal(context, ac, args.assessmentId, {
        stage: STAGE,
        operation: "list_item_updated",
        target: `${assessments.name}/${item.itemId}`,
        ...(item.etag !== undefined ? { etagBefore: item.etag } : {}),
      });
      const mismatch = firstMismatch(sent, answered);
      if (mismatch !== undefined) {
        return failure(
          `Findings recorded (${tally}), but Graph's answer to the summary update on ${assessments.name} item ${item.itemId} disagrees with what was sent: ${mismatch}. ` +
            "The journal records what was written.",
        );
      }
      closing = `The summary and stage ${STAGE} were recorded on ${assessments.name} item ${item.itemId}, and Graph's answer matched what was sent.`;
    }

    const output = {
      assessmentId: args.assessmentId,
      ...counts,
      findings: outcomes,
      correlationId: ac.correlationId,
      graphRequests: context.graph.requests() - before,
    };
    const written = counts.created + counts.updated > 0 ? " Each finding written was answered with the values sent." : "";
    const text = `Findings for ${args.assessmentId}: ${tally}.${written} ${closing}`;
    return { structuredContent: output, content: [{ type: "text" as const, text }] };
  } catch (error) {
    console.error(`${TOOL} failed for profile "${args.profileId}"`, error);
    return { isError: true, content: [{ type: "text" as const, text: describeToolFailure(error, subject) }] };
  }
}
