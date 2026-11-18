import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { MAX_SMALL_UPLOAD_BYTES, UploadTooLargeError, createFile, createFolder, overwriteFile, readDriveItem, type DriveItemFacts } from "../../graph/items.js";
import { downloadDriveItem } from "../../graph/content.js";
import { updateListItemFields } from "../../graph/lists.js";
import { fieldsFor, savePrecondition } from "../../domain/assessment/state.js";
import { fileNameOf } from "../../domain/assessment/templates.js";
import { profileArtifactKinds, resolveAssessmentContext, unknownKindText } from "./context.js";
import { findAssessmentById, readAssessmentState } from "./read-state.js";
import { sha256Hex } from "./hash.js";
import { appendJournal } from "./journal.js";
import { refusalResult } from "./refusal.js";
import { itemChangedText, itemWithoutEtagText } from "./item-precondition.js";
import { withAssessmentLock } from "./keyed-lock.js";

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
      'The stage this save stands for, for example "DOSSIER", or "CORRECTION" when the dossier was overwritten. A save that wrote the file records it in the State column. On "unchanged" it is the kind\'s own stage and nothing is recorded, so the State column may read another stage.',
    ),
  bytes: z.number().int().describe('Bytes of the file as last read: read back after a write, or as downloaded on "unchanged", for example 2048.'),
  sha256: z.string().describe('sha256 of those bytes, equal to the hash of the content sent, for example "9f86d0...".'),
  eTag: z.string().optional().describe('The item\'s ETag as last read: after the write, or as found on "unchanged", for example "\\"{...},2\\"".'),
  foldersCreated: z
    .array(z.string())
    .optional()
    .describe(
      'Folders between the workspace root and the file that were absent and that this call created before writing the file, each journaled, for example ["Assessments/Acme Corp/ASM-2026-00002/Published"] after that folder was deleted. Absent when every folder was there.',
    ),
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

/** The folders strictly between the workspace root and a file under it, outermost first. */
export function foldersBetween(root: string | undefined, filePath: string): string[] {
  if (root === undefined || !filePath.startsWith(`${root}/`)) return [];
  const segments = filePath.slice(root.length + 1).split("/").slice(0, -1);
  return segments.map((_, index) => `${root}/${segments.slice(0, index + 1).join("/")}`);
}

export async function runSaveAssessmentArtifact(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  // Ordered with every other lifecycle write to this assessment; keyed-lock.ts says why.
  return withAssessmentLock(args.profileId, args.assessmentId, () => saveAssessmentArtifact(args, context));
}

async function saveAssessmentArtifact(args: z.infer<typeof InputObject>, context: ToolContext): Promise<CallToolResult> {
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
    const check = savePrecondition(state, ac.profile.lifecycle.status, `${listName} where ${columns.assessmentId} is "${args.assessmentId}"`);
    // The id as the list stores it once the item is found. The lookup can match a spelling that
    // differs by case, and the journal is keyed by the exact string, so keying it by what the caller
    // typed would split it.
    if (!check.ok) return refusalResult(TOOL, stageFor(args.kind, false), record?.assessmentId ?? args.assessmentId, check);
    const item = record!;
    const assessmentId = item.assessmentId;

    const artifact = state.artifacts.find((entry) => entry.kind === args.kind);
    if (artifact === undefined) throw new Error(`The state read carries no artifact kind "${args.kind}" although the profile names it.`);
    const path = artifact.path;
    // Something other than the artifact answered the path lookup. A create there would answer 409
    // and be misreported as a file that appeared between the read and the write.
    if (artifact.occupant !== undefined) {
      if (artifact.occupant.isFolder) return failure(`A folder, not a file, is at ${path}, where the profile puts the ${args.kind}. Nothing was written.`);
      const expectedName = fileNameOf(path);
      return failure(
        `The lookup of ${path} answered a file named "${artifact.occupant.name}", not "${expectedName}", the name the profile gives the ${args.kind}. ` +
          "The server writes only under that exact name. Nothing was written.",
      );
    }

    // Checked wherever a write is about to follow, and not before: a save that finds the content
    // already there writes nothing, and so needs no precondition to send.
    const itemEtag = item.etag;
    const noEtag = (): CallToolResult => failure(`${itemWithoutEtagText(listName, item.itemId)} Nothing was written.`);

    // Folders this call created on the way to the file. Named in every result after that point,
    // a failure included, because the journal holds them whatever happens next.
    const foldersCreated: string[] = [];
    const folderNote = (): string =>
      foldersCreated.map((folder) => ` The folder ${folder} was not there, so this call created it before writing the file; the journal records it.`).join("");

    // The State write and its journal entry, made after the file is written and read back. The
    // PATCH answers with the item's whole fields object after the update (L2b), which is the read
    // back for this write. Returns the failure text when the stage was not recorded as sent.
    //
    // It goes under the eTag the item was read with. The file is already written by then, so an
    // item that changed in between leaves a save whose file stands and whose stage is not recorded,
    // and the text says exactly that. Writing State first would refuse cleanly, and would leave
    // State naming a stage whose file a failed write never produced, which is worse: the drive is
    // what the tools trust, and State must never run ahead of it.
    const recordStage = async (stage: string, saved: string, etag: string): Promise<string | undefined> => {
      const updated = await updateListItemFields(context.graph, { siteId: ac.siteId, listName, itemId: item.itemId, fields: fieldsFor(columns, { state: stage }), etag });
      if (updated.kind === "precondition_failed") {
        return (
          `${saved}, but ${columns.state} was not recorded: ${itemChangedText(listName, item.itemId, etag)} ` +
          `The file and its journal entry stand, and ${columns.state} was left as it is. ` +
          "Saving the same content again will not record it: a save that writes no file records no stage."
        );
      }
      await appendJournal(context, ac, assessmentId, {
        stage,
        operation: "list_item_updated",
        target: `${listName}/${item.itemId}`,
        etagBefore: etag,
        ...(updated.eTag !== undefined ? { etagAfter: updated.eTag } : {}),
      });
      const fields = updated.fields;
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
      if (itemEtag === undefined) return noEtag();
      // A folder between the root and the file that is gone is created here, by its own request.
      // Measured 2026-11-09 (campaign s1): left alone, the content PUT recreates it and answers as
      // for any create, so nothing records that a folder came back. Ruled 2026-11-17: the save
      // stands and the journal says so. Creating it first, and not inferring it afterward from an
      // absence before the write and a presence after, puts the journal entry on a 201 this call
      // received; a folder someone else restored in between answers 409 and is not claimed.
      let above = true;
      for (const folder of foldersBetween(state.rootPath, path)) {
        if (above) {
          const lookup = await readDriveItem(context.graph, { driveId: ac.driveId, path: folder });
          if (lookup.kind === "found") {
            if (lookup.item.isFolder) continue;
            // Nothing has been created yet: a folder is created only below the first absent one.
            return failure(`A file, not a folder, is at ${folder}, above ${path} where the profile puts the ${args.kind}. Nothing was written.`);
          }
          // Everything below an absent folder is absent too, so the lookups stop here.
          above = false;
        }
        const cut = folder.lastIndexOf("/");
        const made = await createFolder(context.graph, { driveId: ac.driveId, parentPath: folder.slice(0, cut), name: folder.slice(cut + 1) });
        if (made.kind === "created") {
          await appendJournal(context, ac, assessmentId, {
            stage: stageFor(args.kind, false),
            operation: "folder_created",
            target: folder,
            ...(made.item.eTag !== undefined ? { etagAfter: made.item.eTag } : {}),
          });
          foldersCreated.push(folder);
        }
      }
      const outcome = await createFile(context.graph, target);
      if (outcome.kind === "name_conflict") {
        return failure(
          `The file at ${path} appeared between the read and the write, so Graph refused the create and nothing was replaced; call again and the server will overwrite it under its ETag.${folderNote()}`,
        );
      }
      written = outcome.item;
    } else {
      if (artifact.eTag === undefined) {
        return failure(`The file at ${path} was read without an ETag, so no If-Match precondition could be sent. Nothing was written.`);
      }
      const prior = await downloadDriveItem(context.graph, { driveId: ac.driveId, workbookPath: path });
      priorHash = sha256Hex(prior);
      // The file already holds exactly this content, so nothing is written, the State column
      // included. Ruled 2026-11-17: a save that writes no file records no stage. This branch once
      // set State to the kind's own stage whenever it read anything else, to finish a save whose
      // file write had landed and whose State write had not. It could not tell that case from a
      // retry of a dossier already corrected or already followed by findings, and it moved State
      // back to DOSSIER in both. The cost of the ruling is the case the branch was written for: a
      // State write that failed is no longer repaired by repeating the save. State is a marker
      // for people, the drive is what the tools read, and the next stage's write moves it on.
      if (priorHash === sent) {
        const stage = stageFor(args.kind, false);
        const output = {
          assessmentId,
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
        const text =
          item.state === stage
            ? `${held}, and ${columns.state} on ${listName} item ${item.itemId} already read ${stage}. Nothing was written.`
            : `${held}. ${columns.state} on ${listName} item ${item.itemId} reads ${JSON.stringify(item.state ?? null)} and was left as it is: a save that writes no file records no stage. Nothing was written.`;
        return { structuredContent: output, content: [{ type: "text" as const, text }] };
      }
      if (itemEtag === undefined) return noEtag();
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
    await appendJournal(context, ac, assessmentId, {
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
          `The assessment state was not advanced; the journal records the write with the hash of what was sent.${folderNote()}`,
      );
    }
    const back = await downloadDriveItem(context.graph, { driveId: ac.driveId, workbookPath: path });
    const hashBack = sha256Hex(back);
    if (hashBack !== sent) {
      return failure(
        `${path} was written but read back with a different hash: sent ${sent} (${bytes.byteLength} bytes), read back ${hashBack} (${back.byteLength} bytes). ` +
          `The assessment state was not advanced; the journal records the write with the hash of what was sent.${folderNote()}`,
      );
    }

    const mismatch = await recordStage(stage, `${path} was saved and read back with sha256 ${hashBack}`, itemEtag);
    if (mismatch !== undefined) return failure(`${mismatch}${folderNote()}`);

    const output = {
      assessmentId,
      kind: args.kind,
      path,
      operation: overwritten ? ("overwritten" as const) : ("created" as const),
      stage,
      bytes: back.byteLength,
      sha256: hashBack,
      eTag: after.item.eTag,
      ...(foldersCreated.length > 0 ? { foldersCreated } : {}),
      correlationId: ac.correlationId,
      graphRequests: context.graph.requests() - before,
    };
    const text =
      `${overwritten ? `Overwrote ${path} under If-Match ${artifact.eTag}` : `Created ${path}`}: read back ${output.bytes} bytes, sha256 ${hashBack.slice(0, 12)}, ` +
      `matching what was sent. Stage ${stage} recorded on ${listName} item ${item.itemId}.${folderNote()}`;
    return { structuredContent: output, content: [{ type: "text" as const, text }] };
  } catch (error) {
    console.error(`${TOOL} failed for profile "${args.profileId}"`, error);
    return { isError: true, content: [{ type: "text" as const, text: describeToolFailure(error, subject) }] };
  }
}
