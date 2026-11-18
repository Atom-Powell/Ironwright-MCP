import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { getListItem, updateListItemFields, type ListItemRecord } from "../../graph/lists.js";
import { isAssessmentProfile } from "../../domain/profile/library.js";
import { fieldsFor, recordFromFields, transitionPrecondition } from "../../domain/assessment/state.js";
import { resolveAssessmentContext } from "./context.js";
import { findAssessmentById, readAssessmentState } from "./read-state.js";
import { appendJournal } from "./journal.js";
import { refusalResult } from "./refusal.js";
import { itemChangedRefusal, itemWithoutEtagText } from "./item-precondition.js";
import { withAssessmentLock } from "./keyed-lock.js";

export const TRANSITION_INPUT_CONSTRAINTS = "disposition is one of the profile's disposition labels and risk is one of its risk labels.";

export const TRANSITION_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('The assessment profile, for example "vendor-assessments".'),
  assessmentId: z.string().min(1).describe('The id open_assessment returned, for example "ASM-2026-00002".'),
  target: z
    .enum(["completed", "provisional"])
    .describe(
      'The status to move to, for example "completed", which is reached from in progress or from provisional and needs the artifacts the profile\'s completed gate names, by default the dossier and the publication, or "provisional", which is reached from in progress and needs those its provisional gate names, by default the dossier.',
    ),
  disposition: z.string().min(1).describe('One of the profile\'s disposition labels, for example "Approved with conditions".'),
  risk: z.string().min(1).describe('One of the profile\'s risk labels for the overall risk, for example "Medium".'),
} satisfies z.ZodRawShape;

export const TRANSITION_OUTPUT_SCHEMA = {
  assessmentId: z.string().describe('For example "ASM-2026-00002".'),
  previousStatus: z.string().optional().describe('The status the item held when this call read it, for example "In Progress". Absent when the item held none.'),
  status: z.string().optional().describe('The status as last read: read back after the update, or as found when nothing was written, for example "Completed".'),
  disposition: z.string().optional().describe('The disposition as last read, for example "Approved".'),
  risk: z.string().optional().describe('The overall risk as last read, for example "Low".'),
  transitioned: z.boolean().describe("True when this call wrote the transition, for example false when the item already held the target status and labels."),
  correlationId: z.string().describe('For example "6f1c...".'),
  graphRequests: z.number().int().describe("Graph requests this call issued, for example 8."),
} satisfies z.ZodRawShape;

const InputObject = z.object(TRANSITION_INPUT_SCHEMA);
const TOOL = "transition_assessment";
const STAGE = "LIFECYCLE";

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/**
 * Checked from the registry before any Graph request. Undefined for a profile
 * that is not an assessment profile, which resolveAssessmentContext then
 * reports in its own words.
 */
function labelProblem(context: ToolContext, args: z.infer<typeof InputObject>): string | undefined {
  const profile = context.profiles.getAny(args.profileId);
  if (!isAssessmentProfile(profile)) return undefined;
  const { dispositions, risks } = profile.lifecycle;
  if (!dispositions.includes(args.disposition)) {
    return `${TRANSITION_INPUT_CONSTRAINTS} The disposition "${args.disposition}" is not one; the disposition labels are ${dispositions.join(", ")}. Nothing was read or written.`;
  }
  if (!risks.includes(args.risk)) {
    return `${TRANSITION_INPUT_CONSTRAINTS} The risk "${args.risk}" is not one; the risk labels are ${risks.join(", ")}. Nothing was read or written.`;
  }
  return undefined;
}

export async function runTransitionAssessment(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  // Ordered with every other lifecycle write to this assessment; keyed-lock.ts says why.
  return withAssessmentLock(args.profileId, args.assessmentId, () => transitionAssessment(args, context));
}

async function transitionAssessment(args: z.infer<typeof InputObject>, context: ToolContext): Promise<CallToolResult> {
  const subject: FailureSubject = { tool: TOOL, profileId: args.profileId };
  const before = context.graph.requests();

  try {
    const problem = labelProblem(context, args);
    if (problem !== undefined) return failure(problem);

    const ac = await resolveAssessmentContext(context, args.profileId);
    subject.siteUrl = ac.profile.identity.siteUrl;
    subject.library = ac.profile.identity.library;
    const listName = ac.profile.lists.assessments.name;
    const columns = ac.profile.lists.assessments.columns;
    const label = ac.profile.lifecycle.status[args.target];

    const record = await findAssessmentById(context.graph, ac, args.assessmentId);
    const state = await readAssessmentState(context.graph, ac, record);
    // The id as the list stores it, which the journal is keyed by; the lookup can match another case.
    const assessmentId = record?.assessmentId ?? args.assessmentId;

    // A retry of a transition that already landed is reported rather than written again, and is
    // checked before the preconditions because a completed assessment is no longer in progress.
    if (record !== undefined && record.status === label && record.disposition === args.disposition && record.risk === args.risk) {
      const output = {
        assessmentId,
        previousStatus: record.status,
        status: record.status,
        disposition: record.disposition,
        risk: record.risk,
        transitioned: false,
        correlationId: ac.correlationId,
        graphRequests: context.graph.requests() - before,
      };
      const text =
        `${assessmentId} already reads status "${label}", disposition "${args.disposition}" and risk "${args.risk}" on ${listName} item ${record.itemId}. ` +
        "Nothing was written.";
      return { structuredContent: output, content: [{ type: "text" as const, text }] };
    }

    const check = transitionPrecondition(state, ac.profile.lifecycle, args.target, `${listName} where ${columns.assessmentId} is "${args.assessmentId}"`);
    if (!check.ok) return refusalResult(TOOL, STAGE, assessmentId, check);
    const item = record!;

    // The update is made only if the item is still the one the preconditions were read from. A
    // person can change its status in the browser while this call reads the drive, and a write
    // that landed anyway would record a transition decided on a state that no longer exists.
    if (item.etag === undefined) return failure(`${itemWithoutEtagText(listName, item.itemId)} Nothing was written.`);
    const updated = await updateListItemFields(context.graph, {
      siteId: ac.siteId,
      listName,
      itemId: item.itemId,
      fields: fieldsFor(columns, { status: label, disposition: args.disposition, risk: args.risk, state: STAGE }),
      etag: item.etag,
    });
    if (updated.kind === "precondition_failed") return refusalResult(TOOL, STAGE, assessmentId, itemChangedRefusal(listName, item.itemId, item.etag));

    // The journal entry waits for the read back only to carry its ETag: Graph's 2xx already said the
    // update happened, so a read back that fails or disagrees must not leave it unrecorded.
    let back: ListItemRecord | undefined;
    let readError: unknown;
    try {
      back = await getListItem(context.graph, { siteId: ac.siteId, listName, itemId: item.itemId });
    } catch (error) {
      readError = error;
    }
    await appendJournal(context, ac, assessmentId, {
      stage: STAGE,
      operation: "list_item_updated",
      target: `${listName}/${item.itemId}`,
      etagBefore: item.etag,
      // The read back's eTag when there is one, and otherwise the one the update itself answered.
      ...((back?.eTag ?? updated.eTag) !== undefined ? { etagAfter: back?.eTag ?? updated.eTag } : {}),
    });
    if (readError !== undefined) throw readError;

    const wrote = `status "${label}", disposition "${args.disposition}", risk "${args.risk}" and ${columns.state} "${STAGE}"`;
    if (back === undefined) {
      return failure(`Graph accepted the update of ${listName} item ${item.itemId} to ${wrote}, but reading the item back answered 404. The journal records the update.`);
    }
    const read = recordFromFields(back.fields, back.id, back.eTag, columns);
    if (read.status !== label || read.disposition !== args.disposition || read.risk !== args.risk || read.state !== STAGE) {
      const found =
        `status ${JSON.stringify(read.status ?? null)}, disposition ${JSON.stringify(read.disposition ?? null)}, ` +
        `risk ${JSON.stringify(read.risk ?? null)} and ${columns.state} ${JSON.stringify(read.state ?? null)}`;
      return failure(`Graph accepted the update of ${listName} item ${item.itemId} to ${wrote}, but reading it back found ${found}. The journal records the update.`);
    }

    const output = {
      assessmentId,
      previousStatus: item.status,
      status: read.status,
      disposition: read.disposition,
      risk: read.risk,
      transitioned: true,
      correlationId: ac.correlationId,
      graphRequests: context.graph.requests() - before,
    };
    const text =
      `Moved ${assessmentId} from ${JSON.stringify(item.status ?? null)} to "${read.status}" with disposition "${read.disposition}", risk "${read.risk}" ` +
      `and ${columns.state} "${read.state}", as read back from ${listName} item ${item.itemId}.`;
    return { structuredContent: output, content: [{ type: "text" as const, text }] };
  } catch (error) {
    console.error(`${TOOL} failed for profile "${args.profileId}"`, error);
    return { isError: true, content: [{ type: "text" as const, text: describeToolFailure(error, subject) }] };
  }
}
