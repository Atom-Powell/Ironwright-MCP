// scripts/pre-eon/sitting-lib.ts
/**
 * The parts of the sitting runner that read text and decide a verdict. Pure, so
 * they are tested without a tenant: sitting.ts is the only file that starts a
 * process or sends a request.
 */

export type StepVerdict = "pass" | "fail" | "measured" | "observed" | "skipped";

export interface StepResult {
  step: string;
  verdict: StepVerdict;
  detail: string;
}

/**
 * Reads the grant issuer's id and secret out of what `--create-bootstrap`
 * printed, so the runner holds the secret in memory and the operator never
 * copies it anywhere.
 */
export function parseBootstrapOutput(text: string): { clientId: string; clientSecret: string } | undefined {
  const clientId = /^\s*IW_BOOTSTRAP_CLIENT_ID=(\S+)\s*$/m.exec(text)?.[1];
  const clientSecret = /^\s*IW_BOOTSTRAP_CLIENT_SECRET=(\S+)\s*$/m.exec(text)?.[1];
  return clientId === undefined || clientSecret === undefined ? undefined : { clientId, clientSecret };
}

const SECRET_LINE = /((?:IW_BOOTSTRAP_CLIENT_SECRET|IW_CLIENT_SECRET|AZURE_CLIENT_SECRET)=)\S+/g;

/**
 * Applied to every line the runner shows or logs. The assignment pattern
 * catches a secret the runner has not parsed yet, which is the line that
 * announces it; the list catches a known secret quoted anywhere else, such as
 * inside an error message.
 */
export function redactSecrets(line: string, secrets: readonly string[]): string {
  let out = line.replace(SECRET_LINE, "$1<kept in memory, not shown>");
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("<secret>");
  }
  return out;
}

/**
 * What the runner adds to its own environment for the server it starts. The
 * identity and the site are already in that environment by then.
 *
 * Inbound authentication is off, as it was in every earlier sitting, and the
 * second variable is the server's own requirement for saying so on purpose.
 * Mode none binds loopback only, and the runner's client is on the same
 * machine. Left out, the server refuses to start for want of a key, which is
 * how the first live run of this runner ended.
 */
export function serverEnvironment(mode: "live" | "sim", port: number): Record<string, string> {
  if (mode === "sim") return { SIM_PORT: String(port) };
  return { IW_PROFILE_DIR: "profiles", IW_ALLOW_WRITES: "true", PORT: String(port), IW_INBOUND_AUTH: "none", IW_ALLOW_ANONYMOUS: "1" };
}

export interface CampaignRow {
  key: string;
  verdict: string;
  summary: string;
}

/** Reads the table `npm run campaign` prints, one row per scenario. */
export function parseCampaignTable(text: string): CampaignRow[] {
  const rows: CampaignRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split("|").map((cell) => cell.trim());
    // "| s1 name | VERDICT | summary |" splits into an empty cell at each end.
    if (cells.length < 5) continue;
    const key = /^(s\d+)\b/.exec(cells[1] ?? "")?.[1];
    if (key === undefined) continue;
    rows.push({ key, verdict: cells[2] ?? "", summary: cells.slice(3, -1).join(" / ") });
  }
  return rows;
}

/** s1 and s6 record what happens for a person to rule on; the other six assert. */
const CAMPAIGN_EXPECTED: Readonly<Record<string, string>> = {
  s1: "MEASURED", s2: "PASS", s3: "PASS", s4: "PASS", s5: "PASS", s6: "MEASURED", s7: "PASS", s8: "PASS",
};

export function judgeCampaign(rows: readonly CampaignRow[]): StepResult {
  const wrong: string[] = [];
  for (const [key, expected] of Object.entries(CAMPAIGN_EXPECTED)) {
    const row = rows.find((candidate) => candidate.key === key);
    if (row === undefined) wrong.push(`${key} did not report`);
    else if (row.verdict.toUpperCase() !== expected) wrong.push(`${key} ${row.verdict} (expected ${expected}): ${row.summary}`);
  }
  return wrong.length === 0
    ? { step: "campaign", verdict: "pass", detail: "s2, s3, s4, s5, s7 and s8 pass; s1 and s6 measured as before" }
    : { step: "campaign", verdict: "fail", detail: wrong.join("; ") };
}

export interface ProbeLine {
  status: number;
  label: string;
}

/** Reads the line per step the probe writes, "L4a  412  pass". */
export function parseProbeLines(text: string): Record<string, ProbeLine> {
  const lines: Record<string, ProbeLine> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z]\d+[a-z]?)\s+(\d+)\s+(.*)$/.exec(line.trim());
    if (match === null) continue;
    lines[match[1]!] = { status: Number(match[2]), label: match[3]!.trim() };
  }
  return lines;
}

/**
 * What L4a to L4d say about a precondition on a list item write. Always
 * "observed" when the steps ran: either answer decides the design, and neither
 * is a defect in the probe.
 */
export function judgeListPrecondition(lines: Readonly<Record<string, ProbeLine>>): StepResult {
  const step = "If-Match probe on list items";
  const fields = lines["L4a"];
  const item = lines["L4d"];
  if (fields === undefined || item === undefined) {
    const last = Object.keys(lines).at(-1);
    return { step, verdict: "fail", detail: `the probe did not reach L4a${last === undefined ? "" : `; the last step that answered was ${last} with ${lines[last]!.status} ${lines[last]!.label}`}` };
  }
  const landed = lines["L4b"]?.label.includes("landed") === true ? " L4b confirms the stale write landed." : "";
  const raw = `L4a ${fields.status}, L4b ${lines["L4b"]?.status ?? "none"}, L4c ${lines["L4c"]?.status ?? "none"}, L4d ${item.status}.`;
  if (fields.status === 412) return { step, verdict: "observed", detail: `Graph enforced on the fields address, where the server already writes: the fix is one header. ${raw}` };
  if (fields.status === 200 && item.status === 412) return { step, verdict: "observed", detail: `Graph enforced on the item, not on its fields: the fix moves the write to the item.${landed} ${raw}` };
  if (fields.status === 200 && item.status === 200) return { step, verdict: "observed", detail: `Graph not enforced on either address: the remedy is a read after the write.${landed} ${raw}` };
  return { step, verdict: "observed", detail: `An answer the three expected readings do not cover. ${raw}` };
}

export interface SummaryMeta {
  startedAt: string;
  commit: string;
  mode: string;
  folder: string;
}

export function summaryMarkdown(meta: SummaryMeta, results: readonly StepResult[]): string {
  const failed = results.filter((result) => result.verdict === "fail").length;
  const lines = [
    "# Sitting summary",
    "",
    `Commit ${meta.commit}, mode ${meta.mode}, started ${meta.startedAt}.`,
    `Step logs are beside this file in ${meta.folder}.`,
    "",
    "| Step | Verdict | Detail |",
    "|---|---|---|",
    ...results.map((result) => `| ${result.step} | ${result.verdict} | ${result.detail.replace(/\r?\n/g, " ").replace(/\|/g, "/")} |`),
    "",
    failed === 0 ? `All ${results.length} steps answered as expected.` : `${failed} of ${results.length} steps failed.`,
    "",
  ];
  return lines.join("\n");
}
