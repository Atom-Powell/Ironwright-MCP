import type { GraphClient } from "../../graph/client.js";
import { readDriveItem } from "../../graph/items.js";
import { odataString, queryListItems } from "../../graph/lists.js";
import { joinWorkspacePath, renderWorkspaceTemplate, sanitizeFolderName } from "../../domain/assessment/templates.js";
import { recordFromFields, rootPathUnavailable, type AssessmentRecord, type AssessmentState } from "../../domain/assessment/state.js";
import type { AssessmentContext } from "./context.js";

export interface WorkspacePaths {
  root: string;
  subfolders: string[];
  artifacts: Record<string, string>;
}

export function workspacePaths(ac: AssessmentContext, record: { vendorTitle: string; vendorFolder: string; assessmentId: string }): WorkspacePaths {
  const values = { vendor: record.vendorTitle, vendorFolder: record.vendorFolder, assessmentId: record.assessmentId };
  const root = joinWorkspacePath(renderWorkspaceTemplate(ac.profile.workspace.root, values));
  const subfolders = ac.profile.workspace.subfolders.map((template) => joinWorkspacePath(root, renderWorkspaceTemplate(template, values)));
  const artifacts: Record<string, string> = {};
  for (const [kind, template] of Object.entries(ac.profile.workspace.artifacts)) {
    artifacts[kind] = joinWorkspacePath(root, renderWorkspaceTemplate(template, values));
  }
  return { root, subfolders, artifacts };
}

/**
 * The paths for an item read from the list, or undefined when the item lacks a
 * field the templates need: an item an interrupted open left behind has no id,
 * and a path rendered from a missing value would name a file nobody wrote.
 */
export function recordWorkspacePaths(ac: AssessmentContext, record: AssessmentRecord): WorkspacePaths | undefined {
  if (record.assessmentId === undefined || record.vendorFolder === undefined || record.vendorTitle === undefined) return undefined;
  return workspacePaths(ac, { vendorTitle: record.vendorTitle, vendorFolder: record.vendorFolder, assessmentId: record.assessmentId });
}

export interface VendorLookup {
  /** True when the Vendors list holds an item with this Title. */
  found: boolean;
  /**
   * The Title as the list stores it, when found. The lookup can match a
   * spelling that differs from the caller's, and the stored one is the name
   * every path and every later lookup is built from.
   */
  title: string | undefined;
  /** The folder name the vendor's items are filed under: the stored one when set, otherwise the sanitized name. */
  folder: string;
}

/**
 * The stored folder name wins over recomputation, so a convention set once
 * sticks and every tool files and finds a vendor under the same name. Title
 * is not unique in a SharePoint list; the first item Graph returns is used
 * and any other is left as it is.
 */
export async function findVendor(graph: Pick<GraphClient, "get">, ac: AssessmentContext, vendor: string): Promise<VendorLookup> {
  const vendors = ac.profile.lists.vendors;
  const items = await queryListItems(graph, { siteId: ac.siteId, listName: vendors.name, filter: `fields/Title eq ${odataString(vendor)}` });
  const stored = items[0]?.fields[vendors.columns.folderName];
  const title = items[0]?.fields.Title;
  return {
    found: items.length > 0,
    title: typeof title === "string" && title.length > 0 ? title : undefined,
    folder: typeof stored === "string" && stored.length > 0 ? stored : sanitizeFolderName(vendor),
  };
}

/**
 * The vendor record already filing under a folder name, if any. Assessments
 * are found by folder name, so two records sharing one would share their
 * assessments; open_assessment asks this before it creates a record.
 */
export async function findVendorByFolder(graph: Pick<GraphClient, "get">, ac: AssessmentContext, folder: string): Promise<{ itemId: string; title: string | undefined } | undefined> {
  const vendors = ac.profile.lists.vendors;
  const items = await queryListItems(graph, { siteId: ac.siteId, listName: vendors.name, filter: `fields/${vendors.columns.folderName} eq ${odataString(folder)}` });
  const item = items[0];
  if (item === undefined) return undefined;
  const title = item.fields.Title;
  return { itemId: item.id, title: typeof title === "string" && title.length > 0 ? title : undefined };
}

function assessmentsList(ac: AssessmentContext): { siteId: string; listName: string } {
  return { siteId: ac.siteId, listName: ac.profile.lists.assessments.name };
}

export async function findAssessmentById(graph: Pick<GraphClient, "get">, ac: AssessmentContext, assessmentId: string): Promise<AssessmentRecord | undefined> {
  const columns = ac.profile.lists.assessments.columns;
  const items = await queryListItems(graph, { ...assessmentsList(ac), filter: `fields/${columns.assessmentId} eq ${odataString(assessmentId)}` });
  if (items.length > 1) {
    throw new Error(`${items.length} items in list "${ac.profile.lists.assessments.name}" carry the assessment id "${assessmentId}"; the server will not choose between them.`);
  }
  const item = items[0];
  return item === undefined ? undefined : recordFromFields(item.fields, item.id, item.eTag, columns);
}

export async function findInProgressAssessment(
  graph: Pick<GraphClient, "get">,
  ac: AssessmentContext,
  vendorFolder: string,
  scope: string,
): Promise<AssessmentRecord | undefined> {
  const columns = ac.profile.lists.assessments.columns;
  const filter =
    `fields/${columns.vendorFolder} eq ${odataString(vendorFolder)} and ` +
    `fields/${columns.scope} eq ${odataString(scope)} and ` +
    `fields/${columns.status} eq ${odataString(ac.profile.lifecycle.status.inProgress)}`;
  const items = await queryListItems(graph, { ...assessmentsList(ac), filter });
  // The oldest open one is picked because it is the one a retry meant. A newer duplicate is not
  // reported here; it stays in the list for an operator to see.
  const sorted = [...items].sort((a, b) => Number(a.id) - Number(b.id));
  const item = sorted[0];
  return item === undefined ? undefined : recordFromFields(item.fields, item.id, item.eTag, columns);
}

/** Reads the drive side of the state for a record whose id and folder are known. */
export async function readAssessmentState(graph: Pick<GraphClient, "get">, ac: AssessmentContext, record: AssessmentRecord | undefined): Promise<AssessmentState> {
  const unavailable = rootPathUnavailable(record);
  if (record === undefined || record.assessmentId === undefined || record.vendorFolder === undefined || record.vendorTitle === undefined) {
    return { record, rootPath: undefined, rootPathUnavailable: unavailable, rootPresent: false, artifacts: [] };
  }
  const paths = workspacePaths(ac, { vendorTitle: record.vendorTitle, vendorFolder: record.vendorFolder, assessmentId: record.assessmentId });
  const root = await readDriveItem(graph, { driveId: ac.driveId, path: paths.root });
  const artifacts = [];
  for (const [kind, path] of Object.entries(paths.artifacts)) {
    const lookup = await readDriveItem(graph, { driveId: ac.driveId, path });
    // SharePoint answers a path case insensitively, so a file named differently only by case comes
    // back from the lookup. It is not the file the template names, and the 9c-era campaign showed a
    // misnamed publication completing an assessment on that reading. The name must match exactly.
    const expectedName = path.slice(path.lastIndexOf("/") + 1);
    const found = lookup.kind === "found" ? lookup.item : undefined;
    const present = found !== undefined && !found.isFolder && found.name === expectedName;
    artifacts.push({
      kind,
      path,
      present,
      // The ETag and size describe the artifact, so they are carried only for it. Whatever else the
      // lookup answered is named as the occupant, so no caller has to infer what it was.
      eTag: present ? found?.eTag : undefined,
      size: present ? found?.size : undefined,
      ...(found !== undefined && !present ? { occupant: { name: found.name, isFolder: found.isFolder } } : {}),
    });
  }
  return { record, rootPath: paths.root, rootPresent: root.kind === "found" && root.item.isFolder, artifacts };
}
