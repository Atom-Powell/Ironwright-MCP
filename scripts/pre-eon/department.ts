// scripts/pre-eon/department.ts
/**
 * What the sitting runner needs to stand a department's workflow up on its own
 * site and run it: a grant for the server application there, the three lists
 * the profile names, and one case taken through every stage the profile
 * defines. A provider whose departments each keep a SharePoint site is a
 * profile per site, and this is how a sitting proves each one live.
 *
 * Every function takes its Graph client or its tool caller as an argument, so
 * each decision is tested against scripted answers or the simulated tenant.
 * Only the sitting runner hands them real ones.
 */
import type { GraphClient } from "../../src/graph/client.js";
import { siteLookupPath } from "../../src/graph/drive.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import type { StepResult } from "./sitting-lib.js";

// ---------------------------------------------------------------- the grant

interface PermissionEntry {
  id?: unknown;
  roles?: unknown;
  grantedToIdentitiesV2?: unknown;
  grantedToIdentities?: unknown;
}

// Graph's current shape is grantedToIdentitiesV2; the deprecated field is read as a fallback,
// since a response can echo the shape the grant was sent in.
function applicationIds(entry: PermissionEntry): string[] {
  const identities = Array.isArray(entry.grantedToIdentitiesV2) ? entry.grantedToIdentitiesV2 : Array.isArray(entry.grantedToIdentities) ? entry.grantedToIdentities : [];
  return identities.flatMap((identity: unknown) => {
    const application = typeof identity === "object" && identity !== null ? (identity as { application?: { id?: unknown } }).application : undefined;
    return typeof application?.id === "string" ? [application.id] : [];
  });
}

function rolesOf(entry: PermissionEntry): string {
  return Array.isArray(entry.roles) ? entry.roles.map(String).join(",") : "(no roles field)";
}

export interface SiteGrant {
  siteUrl: string;
  siteId: string;
  permissionId: string;
  /** The roles the entry held before this call, or undefined when this call created it. */
  before: string | undefined;
  /** The roles Graph answered after this call's write. */
  now: string;
}

/**
 * Gives the server application write on a site: creates its permission entry,
 * with the request the setup command sends, or widens the one it has. Refuses
 * to choose when more than one entry names the application. Under the grant
 * issuer's token. Measured live on 2026-11-17 by the two site probe.
 */
export async function grantWrite(issuer: Pick<GraphClient, "get" | "post" | "patch">, siteUrl: string, clientId: string): Promise<SiteGrant> {
  const site = await issuer.get<{ id?: unknown }>(`${siteLookupPath(siteUrl)}?$select=id`);
  if (typeof site.id !== "string" || site.id.length === 0) throw new Error(`resolving ${siteUrl} returned no site id`);
  const siteId = site.id;

  const matches: Array<{ id: string; roles: string }> = [];
  const requested = new Set<string>();
  let next: string | undefined = `/sites/${siteId}/permissions`;
  while (next !== undefined) {
    if (requested.has(next)) throw new Error("the permissions listing repeated a page it had already requested");
    requested.add(next);
    const page: { value?: unknown; "@odata.nextLink"?: unknown } = await issuer.get(next);
    for (const entry of Array.isArray(page.value) ? (page.value as PermissionEntry[]) : []) {
      if (typeof entry.id === "string" && applicationIds(entry).includes(clientId)) matches.push({ id: entry.id, roles: rolesOf(entry) });
    }
    next = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
  }
  if (matches.length > 1) throw new Error(`${matches.length} permission entries on ${siteUrl} name the server application; nothing was changed`);

  const existing = matches[0];
  if (existing !== undefined) {
    const updated = await issuer.patch<PermissionEntry>(`/sites/${siteId}/permissions/${existing.id}`, { roles: ["write"] });
    return { siteUrl, siteId, permissionId: existing.id, before: existing.roles, now: rolesOf(updated) };
  }
  const created = await issuer.post<PermissionEntry>(`/sites/${siteId}/permissions`, {
    roles: ["write"],
    grantedToIdentities: [{ application: { id: clientId, displayName: "Ironwright MCP server application" } }],
  });
  // The grant exists by now. Without its id nothing here can restore it, and the caller has no
  // record of it either, so the error itself has to carry the warning into the summary.
  if (typeof created.id !== "string") {
    throw new Error(`A GRANT MAY NOW STAND AT WRITE on ${siteUrl}: Graph accepted the grant and answered no permission id, so this run cannot put it back to read.`);
  }
  return { siteUrl, siteId, permissionId: created.id, before: undefined, now: rolesOf(created) };
}

/** Puts a grant back to read, and answers the roles Graph says it now holds. */
export async function restoreRead(issuer: Pick<GraphClient, "patch">, grant: SiteGrant): Promise<string> {
  const updated = await issuer.patch<PermissionEntry>(`/sites/${grant.siteId}/permissions/${grant.permissionId}`, { roles: ["read"] });
  return rolesOf(updated);
}

// ---------------------------------------------------------------- the lists

/** The parts of an assessment profile this file reads. */
export interface WorkflowProfile {
  profileId: string;
  sites: Array<{ siteUrl: string; library: string }>;
  lists: {
    vendors: { name: string; columns: { folderName: string } };
    assessments: { name: string; columns: Record<"assessmentId" | "vendorFolder" | "scope" | "status" | "state" | "disposition" | "risk" | "summary", string> };
    findings: { name: string; columns: Record<"assessmentId" | "findingKey" | "observation" | "risk" | "recommendation", string> };
  };
  lifecycle: {
    status: { inProgress: string; completed: string; provisional: string };
    dispositions: string[];
    risks: string[];
    gates: { findings: string[]; provisional: string[]; completed: string[] };
    external: string[];
  };
}

export interface ListDefinition {
  displayName: string;
  body: unknown;
}

/**
 * The three lists a profile names, with the columns it maps, as Graph creates
 * a list. Every column is text; the three that hold prose take several lines,
 * since the module compares what it sent with what Graph answers exactly
 * (measured 2026-11-08). Title is SharePoint's own and is not created.
 */
export function listDefinitionsFor(profile: WorkflowProfile): ListDefinition[] {
  const text = (name: string, multiline = false): unknown => (multiline ? { name, text: { allowMultipleLines: true } } : { name, text: {} });
  const list = (displayName: string, columns: unknown[]): ListDefinition => ({ displayName, body: { displayName, list: { template: "genericList" }, columns } });
  const a = profile.lists.assessments.columns;
  const f = profile.lists.findings.columns;
  return [
    list(profile.lists.vendors.name, [text(profile.lists.vendors.columns.folderName)]),
    list(profile.lists.assessments.name, [text(a.assessmentId), text(a.vendorFolder), text(a.scope), text(a.status), text(a.state), text(a.disposition), text(a.risk), text(a.summary, true)]),
    list(profile.lists.findings.name, [text(f.assessmentId), text(f.findingKey), text(f.observation, true), text(f.risk), text(f.recommendation, true)]),
  ];
}

/**
 * Creates each list that is not there, under the grant issuer's token, as the
 * probe's seed does: creating a list is setup, and the server's own grant is
 * for items. A list that already exists is left exactly as it is, columns
 * included, so this never changes a list someone has shaped by hand.
 */
export async function ensureLists(issuer: Pick<GraphClient, "get" | "post">, siteId: string, definitions: readonly ListDefinition[]): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const definition of definitions) {
    try {
      await issuer.get<unknown>(`/sites/${siteId}/lists/${encodeURIComponent(definition.displayName)}?$select=id`);
      existing.push(definition.displayName);
    } catch (error) {
      if (!(error instanceof GraphRequestError && error.status === 404)) throw error;
      await issuer.post<unknown>(`/sites/${siteId}/lists`, definition.body);
      created.push(definition.displayName);
    }
    // Read back, for a list just created as for one found. SharePoint can give a column another
    // internal name than the one asked for when that name is taken, and a list shaped by hand can
    // simply lack one. Either way the tools would write to a column that is not there.
    const wanted = (definition.body as { columns: Array<{ name: string }> }).columns.map((column) => column.name);
    const listing = await issuer.get<{ value?: unknown }>(`/sites/${siteId}/lists/${encodeURIComponent(definition.displayName)}/columns?$select=name`);
    const have = (Array.isArray(listing.value) ? listing.value : []).flatMap((column) => (typeof (column as { name?: unknown }).name === "string" ? [(column as { name: string }).name] : []));
    const lacking = wanted.filter((name) => !have.includes(name));
    if (lacking.length > 0) {
      const before = created.filter((name) => name !== definition.displayName);
      throw new Error(
        `The list "${definition.displayName}" has no column named ${lacking.join(", ")}, which the profile maps. Its columns are ${have.join(", ")}.` +
          (before.length === 0 ? "" : ` Created before this: ${before.join(", ")}.`),
      );
    }
  }
  return { created, existing };
}

// ---------------------------------------------------------------- the workflow

export interface ToolAnswer {
  isError: boolean;
  text: string;
  sc: Record<string, unknown>;
}

export interface WorkflowDeps {
  call(name: string, args: Record<string, unknown>): Promise<ToolAnswer>;
  /** Puts a file at a library path as someone other than the server's tools would: the publisher, or a person. */
  upload(path: string, bytes: Uint8Array): Promise<void>;
  tag: string;
}

/**
 * One case through every stage the profile defines, by the profile's own
 * gates: open, save each kind the server writes, record a finding, park it as
 * provisional, see completion refused while an external kind is missing,
 * upload that kind as someone else would, and complete it from provisional.
 * Nothing here knows a kind's name. A pass is the profile's whole workflow
 * running through the seven tools against whatever answers `call`.
 */
export async function runProfileWorkflow(profile: WorkflowProfile, deps: WorkflowDeps): Promise<StepResult> {
  const step = `department workflow ${profile.profileId}`;
  const fail = (at: string, answer: ToolAnswer | string): StepResult => ({ step, verdict: "fail", detail: `${at}: ${typeof answer === "string" ? answer : answer.text.slice(0, 300)}` });
  const base = { profileId: profile.profileId };
  const { gates, external, dispositions, risks, status } = profile.lifecycle;
  const disposition = dispositions[0]!;
  const risk = risks[0]!;

  const opened = await deps.call("open_assessment", { ...base, vendor: `Pilot Check ${deps.tag}`, scope: "Pilot" });
  const id = opened.sc.assessmentId;
  if (opened.isError || typeof id !== "string") return fail("open_assessment", opened);

  const written: string[] = [];
  const save = async (kind: string): Promise<ToolAnswer | undefined> => {
    if (written.includes(kind) || external.includes(kind)) return undefined;
    const answer = await deps.call("save_assessment_artifact", { ...base, assessmentId: id, kind, content: `# ${kind}\n\nWritten by the sitting runner for ${profile.profileId}.\n` });
    if (answer.isError) return answer;
    written.push(kind);
    return undefined;
  };
  // Hoisted so the findings gate can use it: a gate may wait on a kind produced elsewhere.
  const uploadExternal = async (kind: string): Promise<StepResult | undefined> => {
    const before = await deps.call("verify_publication", { ...base, assessmentId: id, kind });
    if (before.isError || typeof before.sc.path !== "string") return fail(`verify_publication ${kind}`, before);
    if (before.sc.present === true) return undefined;
    await deps.upload(before.sc.path, new TextEncoder().encode(`Placed by the sitting runner as the ${kind} for ${id}.\n`));
    const after = await deps.call("verify_publication", { ...base, assessmentId: id, kind });
    return after.isError || after.sc.present !== true ? fail(`verify_publication ${kind} after its upload`, after) : undefined;
  };
  const uploaded: string[] = [];
  /** Makes a gate's kinds present: saved when the server writes the kind, uploaded when it is produced elsewhere. */
  const satisfy = async (kinds: readonly string[]): Promise<StepResult | undefined> => {
    for (const kind of kinds) {
      if (external.includes(kind)) {
        if (uploaded.includes(kind)) continue;
        const failed = await uploadExternal(kind);
        if (failed !== undefined) return failed;
        uploaded.push(kind);
      } else {
        const refused = await save(kind);
        if (refused !== undefined) return fail(`save_assessment_artifact ${kind}`, refused);
      }
    }
    return undefined;
  };

  const beforeFindings = await satisfy(gates.findings);
  if (beforeFindings !== undefined) return beforeFindings;
  const recorded = await deps.call("record_findings", {
    ...base,
    assessmentId: id,
    summary: "One finding, written by the sitting runner.",
    findings: [{ key: "P-1", observation: "A first line.\n\nA second paragraph.", risk, recommendation: "None needed." }],
  });
  if (recorded.isError) return fail("record_findings", recorded);

  // A save is refused once the case is parked, so every kind the server writes goes in first,
  // the completed gate's included. What the completed gate waits on from elsewhere is left absent.
  const beforeParking = (await satisfy(gates.provisional)) ?? (await satisfy(gates.completed.filter((kind) => !external.includes(kind))));
  if (beforeParking !== undefined) return beforeParking;

  const parked = await deps.call("transition_assessment", { ...base, assessmentId: id, target: "provisional", disposition, risk });
  if (parked.isError || parked.sc.status !== status.provisional) return fail("transition_assessment to provisional", parked);

  const waiting = gates.completed.filter((kind) => external.includes(kind) && !uploaded.includes(kind));
  if (waiting.length > 0) {
    const early = await deps.call("transition_assessment", { ...base, assessmentId: id, target: "completed", disposition, risk });
    if (!early.isError) return fail("transition_assessment to completed", `it was not refused while ${waiting.join(", ")} was absent`);
    // Refused is not enough: it has to be refused for the kind that is missing, or the pass
    // below would claim a gate held that this call never saw hold.
    if (!waiting.some((kind) => early.text.includes(`the ${kind} present`))) {
      return fail("transition_assessment to completed", `it was refused, and not for the absent ${waiting.join(", ")}: ${early.text.slice(0, 300)}`);
    }
  }
  const afterParking = await satisfy(waiting);
  if (afterParking !== undefined) return afterParking;

  const done = await deps.call("transition_assessment", { ...base, assessmentId: id, target: "completed", disposition, risk });
  if (done.isError || done.sc.status !== status.completed || done.sc.previousStatus !== status.provisional) return fail("transition_assessment to completed", done);

  const refusedFirst = waiting.length > 0 ? `completion refused until ${waiting.join(", ")} was uploaded, then ` : "";
  return {
    step,
    verdict: "pass",
    detail: `${id}: opened, saved ${written.join(", ")}, one finding recorded, parked as ${status.provisional}, ${refusedFirst}completed from ${status.provisional} as ${status.completed}`,
  };
}
