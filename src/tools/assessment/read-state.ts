import type { GraphClient } from "../../graph/client.js";
import { readDriveItem, type DriveItemFacts, type DriveItemLookup } from "../../graph/items.js";
import { odataString, queryListItems } from "../../graph/lists.js";
import { fileNameOf, joinWorkspacePath, renderWorkspaceTemplate, sanitizeFolderName } from "../../domain/assessment/templates.js";
import { recordFromFields, rootPathUnavailable, type AssessmentRecord, type AssessmentState, type IdentifiedAssessmentRecord } from "../../domain/assessment/state.js";
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
  /** The folder name the vendor's items are filed under: the stored one when set, otherwise the sanitized stored Title, or the sanitized name when no record was found. */
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
  const raw = items[0]?.fields.Title;
  const title = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  return {
    found: items.length > 0,
    title,
    // From the stored Title when there is one: the lookup can match another spelling, and the
    // folder on the drive was named from the stored one.
    folder: typeof stored === "string" && stored.length > 0 ? stored : sanitizeFolderName(title ?? vendor),
  };
}

/**
 * The vendor record already filing under a folder name, if any. Assessments
 * are found by folder name, so two records sharing one would share their
 * assessments; open_assessment asks this before it creates a record.
 *
 * A record files under its stored folder name, or under its sanitized Title
 * when that column is empty, and a filter on the column cannot see the second
 * kind. `titleToo` asks for a record whose Title is the folder name itself and
 * whose column is empty, the likeliest of them: "Acme Inc", entered by hand,
 * when the caller says "Acme Inc.". A Title that only sanitizes to the folder
 * name, "Acme Inc?", is not found by either query; no filter can express it.
 */
export async function findVendorByFolder(
  graph: Pick<GraphClient, "get">,
  ac: AssessmentContext,
  folder: string,
  titleToo: boolean,
): Promise<{ itemId: string; title: string | undefined } | undefined> {
  const vendors = ac.profile.lists.vendors;
  const titleOf = (fields: Record<string, unknown>): string | undefined => (typeof fields.Title === "string" && fields.Title.length > 0 ? fields.Title : undefined);
  const byColumn = await queryListItems(graph, { siteId: ac.siteId, listName: vendors.name, filter: `fields/${vendors.columns.folderName} eq ${odataString(folder)}` });
  if (byColumn[0] !== undefined) return { itemId: byColumn[0].id, title: titleOf(byColumn[0].fields) };
  if (!titleToo) return undefined;
  const byTitle = await queryListItems(graph, { siteId: ac.siteId, listName: vendors.name, filter: `fields/Title eq ${odataString(folder)}` });
  const unfiled = byTitle.find((item) => {
    const stored = item.fields[vendors.columns.folderName];
    return !(typeof stored === "string" && stored.length > 0);
  });
  return unfiled === undefined ? undefined : { itemId: unfiled.id, title: titleOf(unfiled.fields) };
}

function assessmentsList(ac: AssessmentContext): { siteId: string; listName: string } {
  return { siteId: ac.siteId, listName: ac.profile.lists.assessments.name };
}

/**
 * The record carries the id as the list stores it, which the lookup can match
 * in another case than the caller's. Every journal key, output and sentence
 * after this uses the stored one.
 */
export async function findAssessmentById(graph: Pick<GraphClient, "get">, ac: AssessmentContext, assessmentId: string): Promise<IdentifiedAssessmentRecord | undefined> {
  const columns = ac.profile.lists.assessments.columns;
  const items = await queryListItems(graph, { ...assessmentsList(ac), filter: `fields/${columns.assessmentId} eq ${odataString(assessmentId)}` });
  if (items.length > 1) {
    throw new Error(`${items.length} items in list "${ac.profile.lists.assessments.name}" carry the assessment id "${assessmentId}"; the server will not choose between them.`);
  }
  const item = items[0];
  if (item === undefined) return undefined;
  const record = recordFromFields(item.fields, item.id, item.eTag, columns);
  // The filter matched on the id column, so the item holds one; the fallback only satisfies the type.
  return { ...record, assessmentId: record.assessmentId ?? assessmentId };
}

/**
 * The vendor's open assessment for a scope: the one in progress, or failing
 * that one parked as provisional. Ruled 2026-11-17: provisional is not an end
 * state, so an assessment waiting there is returned, not duplicated.
 *
 * Two queries and not one filter with `or`. Each is the three clause shape
 * the 2026-11-07 probe and every sitting since have sent; an `or` across a
 * column has not been sent to this list, and the second query costs one
 * request only on the way to creating an assessment.
 */
export async function findOpenAssessment(
  graph: Pick<GraphClient, "get">,
  ac: AssessmentContext,
  vendorFolder: string,
  scope: string,
): Promise<AssessmentRecord | undefined> {
  const columns = ac.profile.lists.assessments.columns;
  const labels = ac.profile.lifecycle.status;
  for (const status of [labels.inProgress, labels.provisional]) {
    const filter =
      `fields/${columns.vendorFolder} eq ${odataString(vendorFolder)} and ` +
      `fields/${columns.scope} eq ${odataString(scope)} and ` +
      `fields/${columns.status} eq ${odataString(status)}`;
    const items = await queryListItems(graph, { ...assessmentsList(ac), filter });
    // The oldest one is picked because it is the one a retry meant. A newer duplicate is not
    // reported here; it stays in the list for an operator to see.
    const sorted = [...items].sort((a, b) => Number(a.id) - Number(b.id));
    const item = sorted[0];
    if (item !== undefined) return recordFromFields(item.fields, item.id, item.eTag, columns);
  }
  return undefined;
}

export type ArtifactLookup = { present: true; item: DriveItemFacts } | { present: false; occupant?: { name: string; isFolder: boolean } };

/**
 * Whether a path lookup answered the artifact the path names. SharePoint
 * answers a path case insensitively, so a file named differently only by case
 * comes back from the lookup. It is not the file the template names, and the
 * 9c-era campaign showed a misnamed publication completing an assessment on
 * that reading: the name must match exactly. Whatever else the lookup answered
 * is named as the occupant, so no caller has to infer what it was.
 *
 * Every tool that looks for an artifact asks this. read_assessment_artifact
 * once did its own lookup and returned a file the lifecycle tools refused to
 * recognize.
 */
export function artifactAt(lookup: DriveItemLookup, path: string): ArtifactLookup {
  if (lookup.kind !== "found") return { present: false };
  const item = lookup.item;
  if (!item.isFolder && item.name === fileNameOf(path)) return { present: true, item };
  return { present: false, occupant: { name: item.name, isFolder: item.isFolder } };
}

/** Reads the drive side of the state for a record whose id and folder are known. */
export async function readAssessmentState(graph: Pick<GraphClient, "get">, ac: AssessmentContext, record: AssessmentRecord | undefined): Promise<AssessmentState> {
  const unavailable = rootPathUnavailable(record);
  if (record === undefined || record.assessmentId === undefined || record.vendorFolder === undefined || record.vendorTitle === undefined) {
    return { record, rootPath: undefined, rootPathUnavailable: unavailable, rootPresent: false, artifacts: [] };
  }
  const paths = workspacePaths(ac, { vendorTitle: record.vendorTitle, vendorFolder: record.vendorFolder, assessmentId: record.assessmentId });
  // The root and every artifact path are read together. They are independent reads of one moment,
  // every lifecycle call pays for all of them, and one after another they were most of each call's
  // wait. Each read is issued in the profile's order and the answers are kept in that order.
  const entries = Object.entries(paths.artifacts);
  const [root, ...lookups] = await Promise.all([
    readDriveItem(graph, { driveId: ac.driveId, path: paths.root }),
    ...entries.map(([, path]) => readDriveItem(graph, { driveId: ac.driveId, path })),
  ]);
  const artifacts = entries.map(([kind, path], index) => {
    const at = artifactAt(lookups[index]!, path);
    // The ETag and size describe the artifact, so they are carried only for it.
    return at.present
      ? { kind, path, present: true, eTag: at.item.eTag, size: at.item.size }
      : { kind, path, present: false, eTag: undefined, size: undefined, ...(at.occupant === undefined ? {} : { occupant: at.occupant }) };
  });
  return { record, rootPath: paths.root, rootPresent: root.kind === "found" && root.item.isFolder, artifacts };
}
