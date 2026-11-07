import { NON_INDEXED_QUERY_HEADER } from "../../../src/graph/lists.js";
import { RESOLVE_DRIVE_SCRIPT, folderItem, listItem, page, type ScriptEntry } from "./fake-graph.js";

/** Script pieces for open_assessment's own tests, named for the step each one answers. */
export function assessmentFields(folder: string): Record<string, unknown> {
  return { Title: "Acme Corp", VendorFolder: folder, Scope: "Security", Status: "In Progress", State: "ID" };
}

export function vendorsQuery(items: unknown[]): ScriptEntry {
  return { method: "get", pathIncludes: ["/lists/Vendors/items?", "Title eq 'Acme Corp'"], headersInclude: NON_INDEXED_QUERY_HEADER, response: page(items) };
}

export function assessmentsQuery(folder: string, items: unknown[]): ScriptEntry {
  return {
    method: "get",
    pathIncludes: ["/lists/Assessments/items?", `VendorFolder eq '${folder}'`, "Scope eq 'Security'", "Status eq 'In Progress'"],
    headersInclude: NON_INDEXED_QUERY_HEADER,
    response: page(items),
  };
}

/** The id write back and its read back for item `itemId`; `readBackId` differs from `assessmentId` to script a lost write. */
export function idWriteBack(folder: string, itemId: string, assessmentId: string, readBackId = assessmentId): ScriptEntry[] {
  return [
    { method: "patch", pathIncludes: `/lists/Assessments/items/${itemId}/fields`, response: { ...assessmentFields(folder), AssessmentId: assessmentId } },
    {
      method: "get",
      pathIncludes: `/lists/Assessments/items/${itemId}?`,
      response: listItem(itemId, { ...assessmentFields(folder), AssessmentId: readBackId }, `"item-${itemId},2"`),
    },
  ];
}

/** The six folder creates, parent by parent, each answering created unless `conflict` names it. */
export function folderCreates(folder: string, assessmentId: string, conflict: string[] = []): ScriptEntry[] {
  const root = `Assessments/${folder}/${assessmentId}`;
  const steps: Array<[string, string]> = [
    ["/drives/drive-1/root/children", "Assessments"],
    ["/drives/drive-1/root:/Assessments:/children", folder],
    [`/drives/drive-1/root:/Assessments/${folder}:/children`, assessmentId],
    [`/drives/drive-1/root:/${root}:/children`, "Research"],
    [`/drives/drive-1/root:/${root}:/children`, "Evidence"],
    [`/drives/drive-1/root:/${root}:/children`, "Published"],
  ];
  return steps.map(([path, name]): ScriptEntry =>
    conflict.includes(name)
      ? { method: "post", pathIncludes: path, throws: { status: 409, code: "nameAlreadyExists" } }
      : { method: "post", pathIncludes: path, response: folderItem(name) },
  );
}

export function rootRead(folder: string, assessmentId: string): ScriptEntry {
  return { method: "get", pathIncludes: `/drives/drive-1/root:/Assessments/${folder}/${assessmentId}:?`, response: folderItem(assessmentId) };
}

/**
 * The retry path's live workspace reads: the root, then each subfolder, stopping at the first
 * absent one as open does. `absent` names the one that answers 404; omitted, all are present.
 */
export function workspaceReads(folder: string, assessmentId: string, absent?: string): ScriptEntry[] {
  const root = `/drives/drive-1/root:/Assessments/${folder}/${assessmentId}`;
  const reads: ScriptEntry[] = [];
  for (const name of ["(root)", "Research", "Evidence", "Published"]) {
    const path = name === "(root)" ? `${root}:?` : `${root}/${name}:?`;
    if (name === absent) {
      reads.push({ method: "get", pathIncludes: path, throws: { status: 404, code: "itemNotFound" } });
      break;
    }
    reads.push({ method: "get", pathIncludes: path, response: folderItem(name === "(root)" ? assessmentId : name) });
  }
  return reads;
}

export function firstOpenScript(conflict: string[] = []): ScriptEntry[] {
  return [
    ...RESOLVE_DRIVE_SCRIPT,
    vendorsQuery([]),
    { method: "post", pathIncludes: "/lists/Vendors/items", response: listItem("7", { Title: "Acme Corp", FolderName: "Acme Corp" }) },
    assessmentsQuery("Acme Corp", []),
    { method: "post", pathIncludes: "/lists/Assessments/items", response: listItem("2", assessmentFields("Acme Corp")) },
    ...idWriteBack("Acme Corp", "2", "ASM-2026-00002"),
    ...folderCreates("Acme Corp", "ASM-2026-00002", conflict),
    rootRead("Acme Corp", "ASM-2026-00002"),
  ];
}
