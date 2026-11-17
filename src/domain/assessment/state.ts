/**
 * What a lifecycle tool knows about one assessment after reading the lists
 * and the drive, and the preconditions it evaluates over that. Pure: the
 * reading is in src/tools/assessment/read-state.ts, the deciding is here, so
 * every refusal message can be tested against a state object with no tenant.
 *
 * A precondition failure carries evidence: what was read, from where, and
 * what it said. The agent and the operator see the same facts, which is what
 * the spec asks of a refusal.
 */
export interface AssessmentColumns {
  assessmentId: string; vendorFolder: string; scope: string; status: string;
  state: string; disposition: string; risk: string; summary: string;
}

export interface AssessmentRecord {
  itemId: string;
  etag: string | undefined;
  assessmentId: string | undefined;
  /** The list item's Title, which the module writes as the vendor's display name. */
  vendorTitle: string | undefined;
  vendorFolder: string | undefined;
  scope: string | undefined;
  status: string | undefined;
  state: string | undefined;
  disposition: string | undefined;
  risk: string | undefined;
  summary: string | undefined;
}

export interface ArtifactPresence {
  kind: string;
  path: string;
  /** True only for a file whose name is exactly the one the template renders. */
  present: boolean;
  /** Set only when present. */
  eTag: string | undefined;
  /** Set only when present. */
  size: number | undefined;
  /**
   * What the path lookup answered when it was not that file: a folder, or a
   * file under another name, which SharePoint returns for a path differing
   * only by case. Undefined when the path is empty or holds the file, so a
   * refusal can say what is there instead of calling the path not found.
   */
  occupant?: { name: string; isFolder: boolean };
}

export interface AssessmentState {
  record: AssessmentRecord | undefined;
  rootPath: string | undefined;
  /**
   * Why rootPath is undefined, for example "item 7 has no Title", set exactly
   * when it is. The drive was not read in that case, so a refusal must name
   * the missing field rather than report a folder as not found.
   */
  rootPathUnavailable?: string;
  rootPresent: boolean;
  artifacts: ArtifactPresence[];
}

export interface Evidence {
  source: "list" | "drive";
  target: string;
  found: string;
}

export type Precondition = { ok: true } | { ok: false; expected: string; observed: string; evidence: Evidence[] };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function recordFromFields(fields: Record<string, unknown>, itemId: string, etag: string | undefined, columns: AssessmentColumns): AssessmentRecord {
  return {
    itemId,
    etag,
    assessmentId: text(fields[columns.assessmentId]),
    vendorTitle: text(fields.Title),
    vendorFolder: text(fields[columns.vendorFolder]),
    scope: text(fields[columns.scope]),
    status: text(fields[columns.status]),
    state: text(fields[columns.state]),
    disposition: text(fields[columns.disposition]),
    risk: text(fields[columns.risk]),
    summary: text(fields[columns.summary]),
  };
}

/** Logical field values to the list's internal column names; only the keys given are written. */
export function fieldsFor(columns: AssessmentColumns, values: Partial<Record<keyof AssessmentColumns, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[columns[key as keyof AssessmentColumns]] = value;
  }
  return out;
}

export function requireRecord(state: AssessmentState, lookedUp: string): Precondition {
  if (state.record !== undefined) return { ok: true };
  return {
    ok: false,
    expected: "an assessment item matching the id given",
    observed: "no item matched",
    evidence: [{ source: "list", target: lookedUp, found: "no item" }],
  };
}

export function requireInProgress(state: AssessmentState, labels: { inProgress: string }): Precondition {
  const record = state.record;
  if (record === undefined) return requireRecord(state, "the assessments list");
  if (record.status === labels.inProgress) return { ok: true };
  return {
    ok: false,
    expected: `status "${labels.inProgress}"`,
    observed: record.status === undefined ? "no status value" : `status "${record.status}"`,
    evidence: [{ source: "list", target: `assessments item ${record.itemId}`, found: record.status ?? "(empty)" }],
  };
}

export function requireRoot(state: AssessmentState): Precondition {
  if (state.rootPresent) return { ok: true };
  if (state.rootPath === undefined) {
    const reason = state.rootPathUnavailable ?? "the state carries no root path";
    return {
      ok: false,
      expected: "the workspace root folder present",
      observed: `the root path could not be computed: ${reason}`,
      evidence: [{ source: "list", target: state.record === undefined ? "the assessments list" : `assessments item ${state.record.itemId}`, found: reason }],
    };
  }
  return {
    ok: false,
    expected: "the workspace root folder present",
    observed: "the folder was not found",
    evidence: [{ source: "drive", target: state.rootPath, found: "not found" }],
  };
}

export function requireArtifact(state: AssessmentState, kind: string): Precondition {
  const artifact = state.artifacts.find((entry) => entry.kind === kind);
  if (artifact === undefined) {
    // No root path means the drive was never read, so the state holds no artifact of any kind. That
    // is a refusal about the item, and must not reach the throw below, which blames the profile.
    if (state.record === undefined) return requireRecord(state, "the assessments list");
    if (state.rootPath === undefined) {
      const reason = state.rootPathUnavailable ?? "the state carries no root path";
      return {
        ok: false,
        expected: `the ${kind} present at its canonical path`,
        observed: `the ${kind} path could not be computed: ${reason}`,
        evidence: [{ source: "list", target: `assessments item ${state.record.itemId}`, found: reason }],
      };
    }
    throw new Error(`The state carries no artifact kind "${kind}"; the profile's artifacts decide which kinds exist.`);
  }
  if (artifact.present) return { ok: true };
  if (artifact.occupant !== undefined) {
    const expectedName = artifact.path.slice(artifact.path.lastIndexOf("/") + 1);
    const { name, isFolder } = artifact.occupant;
    return {
      ok: false,
      expected: `the ${kind} present at its canonical path`,
      observed: isFolder ? "not present: a folder is at the path" : `not present: the path answered a file named "${name}", not "${expectedName}"`,
      evidence: [{ source: "drive", target: artifact.path, found: `${isFolder ? "a folder" : "a file"} named "${name}"` }],
    };
  }
  return {
    ok: false,
    expected: `the ${kind} present at its canonical path`,
    observed: "not present",
    evidence: [{ source: "drive", target: artifact.path, found: "not found" }],
  };
}

export function allOf(...checks: Precondition[]): Precondition {
  return checks.find((check) => !check.ok) ?? { ok: true };
}

/**
 * Why the workspace paths cannot be rendered for this record, or undefined
 * when they can. Checked in the order the templates need the values, so the
 * reason names the first field missing.
 */
export function rootPathUnavailable(record: AssessmentRecord | undefined): string | undefined {
  if (record === undefined) return "no assessment item was found";
  if (record.assessmentId === undefined) return `item ${record.itemId} has no assessment id`;
  if (record.vendorTitle === undefined) return `item ${record.itemId} has no Title`;
  if (record.vendorFolder === undefined) return `item ${record.itemId} has no vendor folder`;
  return undefined;
}
