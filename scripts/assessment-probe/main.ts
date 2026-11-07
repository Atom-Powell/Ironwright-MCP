// scripts/assessment-probe/main.ts
/**
 * Runs the assessment domain's Graph probes. See plan.ts for the steps and
 * docs/superpowers/plans/2026-11-06-phase-9a-assessment-probes.md for why.
 *
 *   npm run probe:assessment -- --out=docs/superpowers/specs/evidence/2026-11-07-assessment-probe
 *
 * Reads IW_TENANT_ID, IW_CLIENT_ID, IW_CLIENT_SECRET (the server application),
 * IW_SITE_URL, IW_PROBE_LIBRARY (default "Shared Documents") and
 * IW_PROBE_LIST_PREFIX (default "IW Probe").
 *
 * The raw recording, which carries real ids, goes under .superpowers/ and is
 * never committed. The redacted recording and the report go to --out.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GRAPH_BASE } from "../../src/graph/client.js";
import { clientCredentialsTokenProvider, requireExactRoles, SERVER_TOKEN_ROLES } from "../../src/graph/token.js";
import { probeSteps, redact, reportMarkdown, type ProbeContext, type ProbeRecord, type ProbeRequest, type ProbeResponse } from "./plan.js";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function send(token: string, req: ProbeRequest): Promise<ProbeResponse> {
  const response = await fetch(req.url, {
    method: req.method,
    headers: { ...(req.headers ?? {}), authorization: `Bearer ${token}` },
    ...(req.body === undefined ? {} : { body: req.body }),
    redirect: "follow",
  });
  const body = await response.text();
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "etag", "location", "retry-after", "request-id"]) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { status: response.status, headers, body };
}

async function main(): Promise<void> {
  const out = argValue("out");
  if (out === undefined) throw new Error("--out=<dir> is required: where the redacted recording and report go");

  const tokenProvider = requireExactRoles(
    clientCredentialsTokenProvider({ tenantId: env("IW_TENANT_ID"), clientId: env("IW_CLIENT_ID"), clientSecret: env("IW_CLIENT_SECRET") }),
    SERVER_TOKEN_ROLES,
  );

  const ctx: ProbeContext = {
    graphBase: GRAPH_BASE,
    siteUrl: env("IW_SITE_URL"),
    library: process.env.IW_PROBE_LIBRARY?.trim() || "Shared Documents",
    listPrefix: process.env.IW_PROBE_LIST_PREFIX?.trim() || "IW Probe",
    runId: new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""),
  };

  const raw: ProbeRecord[] = [];
  // The files are written in finally so a fetch that throws mid-run still
  // leaves its records behind: a half run is evidence of where the chain
  // broke, and the thrown error still reaches the top-level handler.
  try {
    for (const step of probeSteps()) {
      let req: ProbeRequest;
      try {
        req = step.request(ctx);
      } catch (error) {
        // A step that cannot be built is missing a capture from an earlier step.
        // The loop stops here rather than skipping on, and the files are still
        // written, so the report shows exactly where the chain broke instead of
        // a run of failures that share one cause.
        const because = `not sent: ${error instanceof Error ? error.message : String(error)}`;
        raw.push({
          id: step.id,
          assumption: step.assumption,
          expected: step.expected,
          request: { method: "GET", url: "(not sent)" },
          response: { status: 0, headers: {}, body: "" },
          verdict: { kind: "fail", because },
        });
        console.error(`${step.id.padEnd(4)} 0  FAIL ${because}`);
        break;
      }
      const token = await tokenProvider.getToken();
      const res = await send(token, req);
      const verdict = step.judge(res, ctx);
      step.capture?.(res, ctx);
      raw.push({ id: step.id, assumption: step.assumption, expected: step.expected, request: req, response: res, verdict });
      const label = verdict.kind === "pass" ? "pass" : verdict.kind === "fail" ? `FAIL ${verdict.because}` : `observed ${verdict.note}`;
      console.error(`${step.id.padEnd(4)} ${res.status}  ${label}`);
    }
  } finally {
    await writeOutputs(raw, ctx, out);
  }
}

async function writeOutputs(raw: ProbeRecord[], ctx: ProbeContext, out: string): Promise<void> {
  const rawDir = join(".superpowers", "assessment-probe");
  await mkdir(rawDir, { recursive: true });
  await writeFile(join(rawDir, `${ctx.runId}.raw.jsonl`), raw.map((r) => JSON.stringify(r)).join("\n") + "\n");

  // A run that sent nothing (for example the token roles check threw) must not
  // overwrite an earlier run's evidence with a report of an empty run.
  if (!raw.some((r) => r.response.status !== 0)) {
    console.error(`no request was sent, so ${out} was left untouched`);
    return;
  }

  // One map for the whole run so etag tokens are numbered per run, not per record.
  const etags = new Map<string, string>();
  const redacted = raw.map((r) => redact(r, ctx, etags));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "recordings.jsonl"), redacted.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await writeFile(join(out, "report.md"), reportMarkdown(redacted, ctx.runId, SERVER_TOKEN_ROLES));
  console.error(`wrote ${out}/recordings.jsonl and ${out}/report.md`);

  // Named from the recorded responses, not from captures: a 201 without an
  // eTag creates the thing and captures nothing.
  const answered201 = (id: string): boolean => raw.some((r) => r.id === id && r.response.status === 201);
  const created: string[] = [];
  if (answered201("F0")) created.push("the root folder IW-Probe");
  if (answered201("L2a")) {
    created.push(`a list item in the Assessments list ${ctx.itemId !== undefined ? `with id ${ctx.itemId}` : "whose id was not captured"}`);
  }
  if (answered201("F1a")) created.push(`the folder IW-Probe/probe ${ctx.runId}`);
  if (answered201("F2a")) created.push(`the file IW-Probe/probe ${ctx.runId}/dossier.md`);
  if (answered201("F3c")) created.push(`the file IW-Probe/probe ${ctx.runId}/absent.md`);
  console.error(
    created.length === 0
      ? "cleanup: no create step answered 201, so nothing is known to have been created"
      : `cleanup: this run created ${created.join(", ")}; they were left in place for the operator to remove or keep`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
