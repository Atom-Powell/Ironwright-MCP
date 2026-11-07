import { NON_INDEXED_QUERY_HEADER } from "../../../src/graph/lists.js";
import { RESOLVE_DRIVE_SCRIPT, fileItem, folderItem, listItem, page, type ScriptEntry } from "./fake-graph.js";

/** Script pieces for the tools that act on one assessment already opened, found by its id. */
export const PROFILE = "vendor-assessments";
export const ID = "ASM-2026-00002";
export const ROOT = `Assessments/Acme Corp/${ID}`;
export const DOSSIER_PATH = `${ROOT}/Research/Acme Corp_Research_Dossier.md`;
export const SUMMARY_PATH = `${ROOT}/Published/${ID}_Executive_Summary.md`;
export const PUBLICATION_PATH = `${ROOT}/Published/Acme Corp_${ID}_Risk_Assessment.docx`;

export const NOT_FOUND = { status: 404, code: "itemNotFound" } as const;

export function stateFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { Title: "Acme Corp", AssessmentId: ID, VendorFolder: "Acme Corp", Scope: "Security", Status: "In Progress", State: "ID", ...overrides };
}

/** findAssessmentById's query; an empty `items` scripts an id no item carries. */
export function assessmentByIdQuery(items: unknown[]): ScriptEntry {
  return { method: "get", pathIncludes: ["/lists/Assessments/items?", `AssessmentId eq '${ID}'`], headersInclude: NON_INDEXED_QUERY_HEADER, response: page(items) };
}

/** A metadata read of one path: the item given, or 404 when `item` is undefined. */
export function itemRead(path: string, item: unknown): ScriptEntry {
  const entry: ScriptEntry = { method: "get", pathIncludes: `/drives/drive-1/root:/${path}:?` };
  return item === undefined ? { ...entry, throws: NOT_FOUND } : { ...entry, response: item };
}

/** A content download of one path, answering `bytes`. */
export function contentRead(path: string, bytes: Uint8Array): ScriptEntry {
  return { method: "getBytes", pathIncludes: `/drives/drive-1/root:/${path}:/content`, response: bytes };
}

export interface StateOptions {
  fields?: Record<string, unknown>;
  rootPresent?: boolean;
  /** Each artifact's item as the state read finds it; undefined answers 404. */
  dossier?: unknown;
  summary?: unknown;
  publication?: unknown;
}

/**
 * Resolve, find item 2 by its id, then readAssessmentState's reads: the root and each of the
 * profile's artifacts. Defaults to a found, in progress assessment with its root present and no
 * artifact saved yet.
 */
export function stateScript(options: StateOptions = {}): ScriptEntry[] {
  return [
    ...RESOLVE_DRIVE_SCRIPT,
    assessmentByIdQuery([listItem("2", stateFields(options.fields))]),
    itemRead(ROOT, options.rootPresent === false ? undefined : folderItem(ID)),
    itemRead(DOSSIER_PATH, options.dossier),
    itemRead(SUMMARY_PATH, options.summary),
    itemRead(PUBLICATION_PATH, options.publication),
  ];
}

export function dossierItem(eTag: string, size: number): Record<string, unknown> {
  return fileItem("Acme Corp_Research_Dossier.md", eTag, size);
}

/** The Findings query for this assessment's id, answering the items given. */
export function findingsQuery(items: unknown[]): ScriptEntry {
  return { method: "get", pathIncludes: ["/lists/Findings/items?", `AssessmentId eq '${ID}'`], headersInclude: NON_INDEXED_QUERY_HEADER, response: page(items) };
}

/** A Findings item as the list holds it, filed under this assessment's id. */
export function findingFields(key: string, observation: string, risk: string, recommendation: string): Record<string, unknown> {
  return { Title: key, AssessmentId: ID, FindingKey: key, Observation: observation, Risk: risk, Recommendation: recommendation };
}
