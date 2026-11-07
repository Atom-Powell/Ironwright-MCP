import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { MAX_SMALL_UPLOAD_BYTES, UploadTooLargeError, createFile, overwriteFile, readDriveItem, type DriveItemFacts } from "../../graph/items.js";
import { downloadDriveItem } from "../../graph/content.js";
import { updateListItemFields } from "../../graph/lists.js";
import { allOf, fieldsFor, requireInProgress, requireRecord, requireRoot } from "../../domain/assessment/state.js";
import { profileArtifactKinds, resolveAssessmentContext, unknownKindText } from "./context.js";
import { findAssessmentById, readAssessmentState } from "./read-state.js";
import { sha256Hex } from "./hash.js";
import { appendJournal } from "./journal.js";
import { refusalResult } from "./refusal.js";

export const SAVE_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('The assessment profile, for example "vendor-assessments".'),
  assessmentId: z.string().min(1).describe('The id open_assessment returned, for example "ASM-2026-00002".'),
  kind: z
    .string()
    .min(1)
    .describe('An artifact kind the profile names, for example "dossier" or "executive_summary". "publication" is refused: the publisher writes it and verify_publication checks it.'),
  content: z.string().min(1).describe('The full text to persist, UTF-8, for example "# Acme Corp research dossier ...". Up to 4 MiB encoded.'),
} satisfies z.ZodRawShape;

export const SAVE_OUTPUT_SCHEMA = {
  assessmentId: z.string().describe('For example "ASM-2026-00002".'),
  kind: z.string().describe('For example "dossier".'),
  path: z.string().describe('Library-relative path saved to, for example "Assessments/Acme Corp/ASM-2026-00002/Research/Acme Corp_Research_Dossier.md".'),
  operation: z
    .enum(["created", "overwritten", "unchanged"])
    .describe('Which write happened, for example "created" on the first save, or "unchanged" when the file already held exactly this content and the file was not written.'),
  stage: z
    .string()
    .describe(
      'The stage this save stands for, which the State column holds when the call succeeds, for example "DOSSIER", or "CORRECTION" when the dossier was overwritten. On "unchanged" it is the kind\'s own stage, journaled only when the State column had to be set.',
    ),
  bytes: z.number().int().describe('Bytes of the file as last read: read back after a write, or as downloaded on "unchanged", for example 2048.'),
  sha256: z.string().describe('sha256 of those bytes, equal to the hash of the content sent, for example "9f86d0...".'),
  eTag: z.string().optional().describe('The item\'s ETag as last read: after the write, or as found on "unchanged", for example "\\"{...},2\\"".'),
  correlationId: z.string().describe('For example "6f1c...".'),
  graphRequests: z.number().int().describe("For example 9."),
} satisfies z.ZodRawShape;

const InputObject = z.object(SAVE_INPUT_SCHEMA);
const TOOL = "save_assessment_artifact";

export const PUBLICATION_REFUSAL = "The publication is written by the consumer's publisher at its canonical path; verify_publication checks it. Nothing was written.";

/** A second save of the dossier is a correction of research already recorded, so it is journaled as its own stage. */
export function stageFor(kind: string, overwritten: boolean): string {
  return kind === "dossier" && overwritten ? "CORRECTION" : kind.toUpperCase();
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

export async function runSaveAssessmentArtifact(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: TOOL, profileId: args.profileId };
  const before = context.graph.requests();

  // Checked here as well as inside createFile and overwriteFile, so content over the cap costs no Graph request at all.
  const bytes = new TextEncoder().encode(args.content);
  if (bytes.byteLength > MAX_SMALL_UPLOAD_BYTES) return failure(new UploadTooLargeError(bytes.byteLength).message);
  if (args.kind === "publication") return failure(PUBLICATION_REFUSAL);

  try {
    const kinds = profileArtifactKinds(context, args.profileId);
    if (kinds !== undefined && !kinds.includes(args.kind)) return failure(unknownKindText(args.profileId, args.kind, kinds));

    const ac = await resolveAssessmentContext(context, args.profileId);
    subject.siteUrl = ac.profile.identity.siteUrl;
    subject.library = ac.profile.identity.library;
    const listName = ac.profile.lists.assessments.name;
    const columns = ac.profile.lists.assessments.columns;

    const record = await findAssessmentById(context.graph, ac, args.assessmentId);
    const state = await readAssessmentState(context.graph, ac, record);
    const check = allOf(
      requireRecord(state, `${listName} where ${columns.assessmentId} is "${args.assessmentId}"`),
      requireInProgress(state, ac.profile.lifecycle.status),
      requireRoot(state),
    );
    if (!check.ok) return refusalResult(TOOL, stageFor(args.kind, false), args.assessmentId, check);
    const item = record!;

    const artifact = state.artifacts.find((entry) => entry.kind === args.kind);
    if (artifact === undefined) throw new Error(`The state read carries no artifact kind "${args.kind}" although the profile names it.`);
    const path = artifact.path;
    // readAssessmentState records an ETag for anything found, and present only for a file, so an
    // ETag without presence is a folder occupying the file's path. A create there would answer
    // 409 and be misreported as a file that appeared between the read and the write.
    if (!artifact.present && artifact.eTag !== undefined) {
      return failure(`A folder, not a file, is at ${path}, where the profile puts the ${args.kind}. Nothing was written.`);
    }

    // The State write and its journal entry, shared by a save that wrote the file and one that found
    // the content already there. The PATCH answers with the item's whole fields object after the
    // update (L2b), which is the read back for this write. Returns the failure text on a mismatch.
    const recordStage = async (stage: string, saved: string): Promise<string | undefined> => {
      const fields = await updateListItemFields(context.graph, { siteId: ac.siteId, listName, itemId: item.itemId, fields: fieldsFor(columns, { state: stage }) });
      await appendJournal(context, ac, args.assessmentId, {
        stage,
        operation: "list_item_updated",
        target: `${listName}/${item.itemId}`,
        ...(item.etag !== undefined ? { etagBefore: item.etag } : {}),
      });
      if (fields[columns.state] === stage) return undefined;
      return (
        `${saved}, but the ${columns.state} update on ${listName} item ${item.itemId} answered ${JSON.stringify(fields[columns.state] ?? null)}, not "${stage}". ` +
        "The journal records what was written."
      );
    };

    const contentType = path.endsWith(".md") ? "text/markdown" : "text/plain";
    const target = { driveId: ac.driveId, path, bytes, contentType };
    const sent = sha256Hex(bytes);
    let written: DriveItemFacts;
    let priorHash: string | undefined;
    if (!artifact.present) {
      const outcome = await createFile(context.graph, target);
      if (outcome.kind === "name_conflict") {
        return failure(`The file at ${path} appeared between the read and the write, so Graph refused the create and nothing was replaced; call again and the server will overwrite it under its ETag.`);
      }
      written = outcome.item;
    } else {
      if (artifact.eTag === undefined) {
        return failure(`The file at ${path} was read without an ETag, so no If-Match precondition could be sent. Nothing was written.`);
      }
      const prior = await downloadDriveItem(context.graph, { driveId: ac.driveId, workbookPath: path });
      priorHash = sha256Hex(prior);
      // The file already holds exactly this content, so the file is not written again. Its stage is
      // the kind's own, since nothing was corrected, and the State column read with the record is
      // compared with it: a save whose file write landed but whose State write did not is completed
      // here rather than left stranded.
      if (priorHash === sent) {
        const stage = stageFor(args.kind, false);
        const stateSet = item.state !== stage;
        if (stateSet) {
          const mismatch = await recordStage(stage, `The ${args.kind} at ${path} already held this content (sha256 ${priorHash})`);
          if (mismatch !== undefined) return failure(mismatch);
        }
        const output = {
          assessmentId: args.assessmentId,
          kind: args.kind,
          path,
          operation: "unchanged" as const,
          stage,
          bytes: prior.byteLength,
          sha256: priorHash,
          eTag: artifact.eTag,
          correlationId: ac.correlationId,
          graphRequests: context.graph.requests() - before,
        };
        const held = `The ${args.kind} at ${path} already held this content (${prior.byteLength} bytes, sha256 ${priorHash.slice(0, 12)}), so the file was not written`;
        const text = stateSet
          ? `${held}; ${columns.state} on ${listName} item ${item.itemId} read ${JSON.stringify(item.state ?? null)}, so it was set to ${stage}.`
          : `${held}, and ${columns.state} on ${listName} item ${item.itemId} already read ${stage}. Nothing was written.`;
        return { structuredContent: output, content: [{ type: "text" as const, text }] };
      }
      const outcome = await overwriteFile(context.graph, { ...target, etag: artifact.eTag });
      if (outcome.kind === "precondition_failed") {
        return failure(`The file at ${path} changed between the read and the write: Graph answered 412 to If-Match ${artifact.eTag}, so nothing was replaced; call again to save over the current version.`);
      }
      written = outcome.item;
    }
    const overwritten = artifact.present;
    const stage = stageFor(args.kind, overwritten);

    // Journaled on Graph's 2xx and before the read back: the write happened whatever the read back
    // finds, and a read back that fails or disagrees must not leave the write unrecorded.
    await appendJournal(context, ac, args.assessmentId, {
      stage,
      operation: overwritten ? "file_overwritten" : "file_created",
      target: path,
      ...(overwritten ? { etagBefore: artifact.eTag } : {}),
      ...(written.eTag !== undefined ? { etagAfter: written.eTag } : {}),
      contentHash: sent,
      ...(priorHash !== undefined ? { priorContentHash: priorHash } : {}),
    });

    const after = await readDriveItem(context.graph, { driveId: ac.driveId, path });
    if (after.kind !== "found" || after.item.isFolder) {
      return failure(
        `Graph accepted the write to ${path}, but reading it back ${after.kind === "found" ? "returned a folder" : "answered 404"}. ` +
          `The assessment state was not advanced; the journal records the write with the hash of what was sent.`,
      );
    }
    const back = await downloadDriveItem(context.graph, { driveId: ac.driveId, workbookPath: path });
    const hashBack = sha256Hex(back);
    if (hashBack !== sent) {
      return failure(
        `${path} was written but read back with a different hash: sent ${sent} (${bytes.byteLength} bytes), read back ${hashBack} (${back.byteLength} bytes). ` +
          `The assessment state was not advanced; the journal records the write with the hash of what was sent.`,
      );
    }

    const mismatch = await recordStage(stage, `${path} was saved and read back with sha256 ${hashBack}`);
    if (mismatch !== undefined) return failure(mismatch);

    const output = {
      assessmentId: args.assessmentId,
      kind: args.kind,
      path,
      operation: overwritten ? ("overwritten" as const) : ("created" as const),
      stage,
      bytes: back.byteLength,
      sha256: hashBack,
      eTag: after.item.eTag,
      correlationId: ac.correlationId,
      graphRequests: context.graph.requests() - before,
    };
    const text =
      `${overwritten ? `Overwrote ${path} under If-Match ${artifact.eTag}` : `Created ${path}`}: read back ${output.bytes} bytes, sha256 ${hashBack.slice(0, 12)}, ` +
      `matching what was sent. Stage ${stage} recorded on ${listName} item ${item.itemId}.`;
    return { structuredContent: output, content: [{ type: "text" as const, text }] };
  } catch (error) {
    console.error(`${TOOL} failed for profile "${args.profileId}"`, error);
    return { isError: true, content: [{ type: "text" as const, text: describeToolFailure(error, subject) }] };
  }
}
