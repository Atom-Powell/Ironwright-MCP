import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { createFolder, readDriveItem } from "../../graph/items.js";
import { createListItem, getListItem, odataString, queryListItems, updateListItemFields } from "../../graph/lists.js";
import { renderAssessmentId, sanitizeFolderName } from "../../domain/assessment/templates.js";
import { fieldsFor, recordFromFields } from "../../domain/assessment/state.js";
import { resolveAssessmentContext } from "./context.js";
import { findInProgressAssessment, readAssessmentState, workspacePaths } from "./read-state.js";
import { appendJournal } from "./journal.js";
import { ASSESSMENT_SUMMARY_SHAPE } from "./output.js";

export const OPEN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe('The assessment profile to open under, for example "vendor-assessments".'),
  vendor: z.string().min(1).max(200).describe('The vendor\'s display name, for example "Acme Corp". The server derives the folder name from it.'),
  scope: z.string().min(1).max(200).describe('What this assessment covers, for example "Security" or "Data processing agreement 2026".'),
} satisfies z.ZodRawShape;

export const OPEN_OUTPUT_SCHEMA = {
  ...ASSESSMENT_SUMMARY_SHAPE,
  workspaceRoot: z.string().describe('Library-relative root folder, for example "Assessments/Acme Corp/ASM-2026-00002".'),
  subfolders: z.array(z.string()).describe('Library-relative folders under the root, for example ["Assessments/Acme Corp/ASM-2026-00002/Research"].'),
  created: z.boolean().describe("True when this call created the assessment, false when it returned one already in progress, for example false on a retry."),
  resumed: z
    .boolean()
    .describe("True when the assessment already existed and this call wrote to complete it, its id or missing workspace folders, for example true after an open that died before the folders were created."),
  correlationId: z.string().describe('Shared by every journal entry this call wrote, for example "6f1c...".'),
  graphRequests: z.number().int().describe("Graph requests this call issued, for example 14."),
} satisfies z.ZodRawShape;

const InputObject = z.object(OPEN_INPUT_SCHEMA);
const STAGE = "ID";

export async function runOpenAssessment(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "open_assessment", profileId: args.profileId };
  const before = context.graph.requests();

  const vendorFolder = sanitizeFolderName(args.vendor);
  if (vendorFolder.length === 0) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `The vendor name "${args.vendor}" has no characters SharePoint allows in a folder name, so no folder could be named for it. Nothing was written.` }],
    };
  }

  try {
    const ac = await resolveAssessmentContext(context, args.profileId);
    subject.siteUrl = ac.profile.identity.siteUrl;
    subject.library = ac.profile.identity.library;
    const lists = ac.profile.lists;
    const columns = lists.assessments.columns;
    const labels = ac.profile.lifecycle.status;

    // The vendor record. Its stored folder name wins over recomputation, so a convention set once sticks.
    const vendors = await queryListItems(context.graph, { siteId: ac.siteId, listName: lists.vendors.name, filter: `fields/Title eq ${odataString(args.vendor)}` });
    let folder = vendorFolder;
    // What this call wrote, so the text says only what happened: created, resumed, or already open with nothing written.
    let vendorCreated = false;
    let wroteId = false;
    let foldersCreated = 0;
    if (vendors.length === 0) {
      const created = await createListItem(context.graph, { siteId: ac.siteId, listName: lists.vendors.name, fields: { Title: args.vendor, [lists.vendors.columns.folderName]: vendorFolder } });
      await appendJournal(context, ac, "(vendor)", { stage: STAGE, operation: "list_item_created", target: `${lists.vendors.name}/${created.id}`, etagAfter: created.eTag });
      vendorCreated = true;
    } else {
      const stored = vendors[0]!.fields[lists.vendors.columns.folderName];
      if (typeof stored === "string" && stored.length > 0) folder = stored;
    }

    // Retry rule: an assessment already in progress for this vendor and scope is returned, not duplicated.
    let record = await findInProgressAssessment(context.graph, ac, folder, args.scope);
    let created = false;
    if (record === undefined) {
      const item = await createListItem(context.graph, {
        siteId: ac.siteId,
        listName: lists.assessments.name,
        fields: { Title: args.vendor, ...fieldsFor(columns, { vendorFolder: folder, scope: args.scope, status: labels.inProgress, state: STAGE }) },
      });
      await appendJournal(context, ac, "(unassigned)", { stage: STAGE, operation: "list_item_created", target: `${lists.assessments.name}/${item.id}`, etagAfter: item.eTag });
      record = recordFromFields(item.fields, item.id, item.eTag, columns);
      created = true;
    }

    // The id is rendered from the item id and written back before any folder exists.
    if (record.assessmentId === undefined) {
      const rendered = renderAssessmentId(ac.profile.assessmentId.template, { prefix: ac.profile.assessmentId.prefix, itemId: Number(record.itemId), now: ac.now });
      await updateListItemFields(context.graph, { siteId: ac.siteId, listName: lists.assessments.name, itemId: record.itemId, fields: fieldsFor(columns, { assessmentId: rendered }) });
      await appendJournal(context, ac, rendered, { stage: STAGE, operation: "list_item_updated", target: `${lists.assessments.name}/${record.itemId}`, etagBefore: record.etag });
      const back = await getListItem(context.graph, { siteId: ac.siteId, listName: lists.assessments.name, itemId: record.itemId });
      const readBack = back === undefined ? undefined : recordFromFields(back.fields, back.id, back.eTag, columns);
      if (readBack?.assessmentId !== rendered) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `The assessment id "${rendered}" was written to ${lists.assessments.name} item ${record.itemId} but read back as ${JSON.stringify(readBack?.assessmentId)}. No folder was created. The item and the journal record what did happen.` }],
        };
      }
      record = readBack;
      wroteId = true;
    }

    const paths = workspacePaths(ac, { vendorTitle: record.vendorTitle ?? args.vendor, vendorFolder: record.vendorFolder ?? folder, assessmentId: record.assessmentId! });
    // An item this call created or completed needs its workspace. An item that was already whole is
    // checked live instead: a present root is the open's last step, so the folders are skipped and a
    // retry costs reads only; an absent root is a resume after a crash between the id write and the folders.
    let needsFolders = created || wroteId;
    if (!needsFolders) {
      const state = await readAssessmentState(context.graph, ac, record);
      needsFolders = !state.rootPresent;
    }

    if (needsFolders) {
      const toCreate = [paths.root, ...paths.subfolders];
      const ensured = new Set<string>();
      for (const target of toCreate) {
        const segments = target.split("/");
        for (let depth = 1; depth <= segments.length; depth += 1) {
          const path = segments.slice(0, depth).join("/");
          if (ensured.has(path)) continue;
          const outcome = await createFolder(context.graph, { driveId: ac.driveId, parentPath: segments.slice(0, depth - 1).join("/"), name: segments[depth - 1]! });
          if (outcome.kind === "created") {
            await appendJournal(context, ac, record.assessmentId!, { stage: STAGE, operation: "folder_created", target: path, etagAfter: outcome.item.eTag });
            foldersCreated += 1;
          }
          ensured.add(path);
        }
      }

      const root = await readDriveItem(context.graph, { driveId: ac.driveId, path: paths.root });
      if (root.kind !== "found" || !root.item.isFolder) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `The workspace root "${paths.root}" was created or found present, but reading it back ${root.kind === "found" ? "returned a file, not a folder" : "answered 404"}. The journal records what was created.` }],
        };
      }
    }

    const writes: string[] = [];
    if (vendorCreated) writes.push(`created the vendor record in ${lists.vendors.name}`);
    if (wroteId) writes.push(`wrote the assessment id to item ${record.itemId}`);
    if (foldersCreated > 0) writes.push(`created ${foldersCreated} ${foldersCreated === 1 ? "folder" : "folders"}`);
    const resumed = !created && writes.length > 0;

    const output = {
      assessmentId: record.assessmentId!,
      itemId: record.itemId,
      vendor: record.vendorTitle ?? args.vendor,
      vendorFolder: record.vendorFolder ?? folder,
      scope: record.scope ?? args.scope,
      status: record.status ?? labels.inProgress,
      state: record.state,
      disposition: record.disposition,
      risk: record.risk,
      workspaceRoot: paths.root,
      subfolders: paths.subfolders,
      created,
      resumed,
      correlationId: ac.correlationId,
      graphRequests: context.graph.requests() - before,
    };
    const text = created
      ? `Opened ${output.assessmentId} for ${output.vendor} (${output.scope}): item ${output.itemId} in ${lists.assessments.name}, workspace ${paths.root} with ${paths.subfolders.length} subfolders, all read back.`
      : resumed
        ? `Resumed ${output.assessmentId} for ${output.vendor} (${output.scope}), which was already in progress: this call ${writes.join(" and ")}. Workspace ${paths.root} read back.`
        : `${output.assessmentId} for ${output.vendor} (${output.scope}) is already open; nothing was written. Workspace ${paths.root} is present.`;
    return { structuredContent: output, content: [{ type: "text" as const, text }] };
  } catch (error) {
    console.error(`open_assessment failed for profile "${args.profileId}"`, error);
    return { isError: true, content: [{ type: "text" as const, text: describeToolFailure(error, subject) }] };
  }
}
