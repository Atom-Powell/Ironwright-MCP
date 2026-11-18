// scripts/pre-eon/sitting.ts
/**
 * npm run sitting. One command for a whole live sitting on the developer
 * tenant, so the operator supplies only what no script can: two sign-ins as a
 * Global Administrator, the word yes, and the server application's secret.
 *
 * In order it reissues the grant issuer when its credentials are not already in
 * the environment, widens the site grant to write, runs the assessment probe
 * (for the list precondition steps L4a to L4d), starts the server with writes
 * enabled, runs the campaign, makes the calls that check the get_assessment
 * additions and a refusal through a client that has listed the tools, stops the
 * server under an open and retries it, and then, whatever happened, stops the
 * server and restores the grant to read.
 *
 *   npm run sitting                      the live sitting
 *   npm run sitting -- --sim             the same server steps over the simulated tenant, no credentials
 *   npm run sitting -- --interrupt-ms=800   how long an open runs before the server is stopped under it
 *
 * Reads IW_TENANT_ID, IW_CLIENT_ID, IW_CLIENT_SECRET and IW_SITE_URL when they
 * are set and asks for whichever is missing; the site comes from the profile.
 * The tenant id and client id are remembered in .superpowers/sitting/identity.json,
 * which is git-ignored and holds no secret. The grant issuer's secret is read
 * from the setup command's output into this process's memory and is never
 * shown, logged or written down, so the next sitting reissues it the same way.
 *
 * The server this script stops is the one it started. It refuses to run when
 * something already answers on the port, and it never stops a process it did
 * not start.
 *
 * Results: .superpowers/sitting/<stamp>/summary.md and one log per step.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { clientCredentialsTokenProvider, requireExactRoles, SERVER_TOKEN_ROLES } from "../../src/graph/token.js";
import { REFUSAL_META_KEY } from "../../src/tools/refusal.js";
import { runScript as runRepoScript, type ScriptRun } from "./run-script.js";
import {
  judgeCampaign,
  judgeListPrecondition,
  parseBootstrapOutput,
  parseCampaignTable,
  parseProbeLines,
  redactSecrets,
  serverEnvironment,
  summaryMarkdown,
  type StepResult,
} from "./sitting-lib.js";

const SIM = process.argv.includes("--sim");
const INTERRUPT_MS = Number(process.argv.find((a) => a.startsWith("--interrupt-ms="))?.slice("--interrupt-ms=".length) ?? (SIM ? "2" : "1200"));
const PORT = Number(process.env.PORT?.trim() || (SIM ? "3939" : "3000"));
const BASE = `http://127.0.0.1:${PORT}`;
const PROFILE_FILE = SIM ? "examples/profiles/assessment-example.json" : process.env.IW_SITTING_PROFILE_FILE?.trim() || "profiles/assessment-sitting.json";
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const TAG = STAMP.slice(4, 13);
const FOLDER = join(".superpowers", "sitting", STAMP);
const IDENTITY_FILE = join(".superpowers", "sitting", "identity.json");

const secrets: string[] = [];
const results: StepResult[] = [];
let server: ChildProcess | undefined;
let grantWidened = false;

function say(text: string): void {
  console.log(`[sitting] ${redactSecrets(text, secrets)}`);
}

function record(result: StepResult): void {
  results.push(result);
  say(`${result.verdict.toUpperCase().padEnd(8)} ${result.step}: ${result.detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads one line from the terminal. A hidden line is read without being echoed, so a secret is
 * neither shown nor left in the shell's history.
 */
function ask(question: string, hidden = false): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setEncoding("utf8");
  if (!stdin.isTTY) {
    if (hidden) return Promise.reject(new Error("A secret can only be asked for in a terminal. Set IW_CLIENT_SECRET in the environment and run again."));
    return new Promise((resolve) => {
      stdin.resume();
      stdin.once("data", (chunk: string) => {
        stdin.pause();
        resolve(chunk.trim());
      });
    });
  }
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value.trim());
          return;
        }
        if (character === "\u0003") {
          finish();
          reject(new Error("Cancelled at a prompt."));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0 && !hidden) process.stdout.write("\b \b");
          value = value.slice(0, -1);
        } else {
          value += character;
          if (!hidden) process.stdout.write(character);
        }
      }
    };
    stdin.on("data", onData);
  });
}

/** Runs one of the repo's own scripts, showing and logging each line with secrets removed. */
function runScript(label: string, script: string, args: string[], env: Record<string, string> = {}, echo = true): Promise<ScriptRun> {
  return runRepoScript({ folder: FOLDER, label, script, args, env, secrets, ...(echo ? { show: (line: string) => console.log(`  ${line}`) } : {}) });
}

async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer(): Promise<void> {
  const script = SIM ? "scripts/sim/main.ts" : "src/server/main.ts";
  const env = serverEnvironment(SIM ? "sim" : "live", PORT);
  const logFile = join(FOLDER, "server.log");
  const child = spawn(process.execPath, ["--import", "tsx", script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const log = (chunk: Buffer): void => appendFileSync(logFile, redactSecrets(chunk.toString("utf8"), secrets));
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  server = child;
  for (let waited = 0; waited < 60_000; waited += 500) {
    if (child.exitCode !== null) throw new Error(`The server exited with code ${child.exitCode} before it answered. Its words are in ${logFile}.`);
    if (await healthy()) return;
    await sleep(500);
  }
  throw new Error(`The server did not answer on ${BASE}/health within 60 seconds. Its words are in ${logFile}.`);
}

/** Stops the server this script started. An immediate stop, with no drain: that is what an interrupted call needs. */
async function stopServer(): Promise<void> {
  const child = server;
  server = undefined;
  if (child === undefined || child.exitCode !== null) return;
  const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await Promise.race([gone, sleep(10_000)]);
}

interface Answer {
  isError: boolean;
  text: string;
  sc: Record<string, unknown>;
  refusal: Record<string, unknown> | undefined;
  /** Set when the client itself threw, which is how a result that fails the tool's output schema arrives. */
  threw: string | undefined;
}

async function connect(): Promise<Client> {
  const client = new Client({ name: "iw-sitting", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  // Listed first, as an agent host does: the SDK client checks a result against a tool's output
  // schema only for tools it has listed.
  await client.listTools();
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Answer> {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    const refusal = (result._meta as Record<string, unknown> | undefined)?.[REFUSAL_META_KEY] as Record<string, unknown> | undefined;
    const answer: Answer = { isError: result.isError === true, text, sc: (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}, refusal, threw: undefined };
    appendFileSync(join(FOLDER, "calls.jsonl"), `${JSON.stringify({ name, args, isError: answer.isError, text, sc: answer.sc, refusal })}\n`);
    return answer;
  } catch (error) {
    const threw = error instanceof Error ? error.message : String(error);
    appendFileSync(join(FOLDER, "calls.jsonl"), `${JSON.stringify({ name, args, threw })}\n`);
    return { isError: true, text: threw, sc: {}, refusal: undefined, threw };
  }
}

interface ProfileFacts {
  profileId: string;
  siteUrl: string;
  disposition: string;
  risk: string;
  /** The profile's label for the provisional status. */
  provisional: string;
}

function readProfile(): ProfileFacts {
  const profile = JSON.parse(readFileSync(PROFILE_FILE, "utf8")) as {
    profileId: string;
    sites: Array<{ siteUrl: string }>;
    lifecycle: { dispositions: string[]; risks: string[]; status: { provisional: string } };
  };
  return {
    profileId: profile.profileId,
    siteUrl: profile.sites[0]!.siteUrl,
    disposition: profile.lifecycle.dispositions[0]!,
    risk: profile.lifecycle.risks[0]!,
    provisional: profile.lifecycle.status.provisional,
  };
}

async function gatherIdentity(profile: ProfileFacts): Promise<void> {
  const saved = existsSync(IDENTITY_FILE) ? (JSON.parse(readFileSync(IDENTITY_FILE, "utf8")) as { tenantId?: string; clientId?: string }) : {};
  const tenantId = process.env.IW_TENANT_ID?.trim() || saved.tenantId || (await ask("Tenant id of the developer tenant: "));
  const clientId = process.env.IW_CLIENT_ID?.trim() || saved.clientId || (await ask("Client id of the server application: "));
  if (tenantId.length === 0 || clientId.length === 0) throw new Error("The tenant id and the server application's client id are both needed.");
  process.env.IW_TENANT_ID = tenantId;
  process.env.IW_CLIENT_ID = clientId;
  process.env.IW_SITE_URL = process.env.IW_SITE_URL?.trim() || profile.siteUrl;

  const secret = process.env.IW_CLIENT_SECRET?.trim() || (await ask("Client secret of the server application (not shown): ", true));
  if (secret.length === 0) throw new Error("The server application's client secret is needed.");
  process.env.IW_CLIENT_SECRET = secret;
  secrets.push(secret);

  // Asked for here, before anything is changed, so a lapsed secret costs a second and not a sitting.
  try {
    await requireExactRoles(clientCredentialsTokenProvider({ tenantId, clientId, clientSecret: secret }), SERVER_TOKEN_ROLES).getToken();
  } catch (error) {
    throw new Error(
      `The server application could not get a token: ${error instanceof Error ? error.message : String(error)} ` +
        "If its secret has lapsed, add a new client secret to that application in Entra, under App registrations, and run this again. Nothing was changed.",
    );
  }
  // Remembered only now: a mistyped id that was saved would be offered back on every later run.
  mkdirSync(join(".superpowers", "sitting"), { recursive: true });
  writeFileSync(IDENTITY_FILE, `${JSON.stringify({ tenantId, clientId }, null, 2)}\n`);
  say("The server application's token carries exactly Sites.Selected.");
}

/** Makes sure this process holds working grant issuer credentials, reissuing them when it does not. */
async function ensureGrantIssuer(): Promise<void> {
  const tenant = process.env.IW_TENANT_ID!;
  if (process.env.IW_BOOTSTRAP_CLIENT_ID?.trim() && process.env.IW_BOOTSTRAP_CLIENT_SECRET?.trim()) {
    secrets.push(process.env.IW_BOOTSTRAP_CLIENT_SECRET.trim());
    const shown = await runScript("grant-show", "scripts/assessment-probe/grant.ts", []);
    if (shown.code === 0) return;
    say("The grant issuer credentials in the environment were refused, so they are being reissued.");
  }

  console.log("");
  console.log("  The grant issuer's secret has lapsed, so it is reissued now. That deletes and purges the");
  console.log(`  application named "Ironwright Grant Issuer" in tenant ${tenant} and creates a new one.`);
  console.log("  You will be asked to sign in twice, as a Global Administrator, with a device code.");
  const answer = await ask("  Type yes to go ahead: ");
  if (answer.toLowerCase() !== "yes") throw new Error("Stopped at the grant issuer, as asked. Nothing was changed.");

  // No dry run first: the typed yes above is the review, and the command itself refuses when more
  // than one application carries the name. A dry run would cost a third sign-in.
  const deleted = await runScript("grant-issuer-delete", "src/setup/main.ts", [`--tenant=${tenant}`, "--delete-bootstrap", "--confirm"]);
  if (deleted.code !== 0) say("The delete did not complete. Going on to create, which says so itself if an application of that name still exists.");

  const created = await runScript("grant-issuer-create", "src/setup/main.ts", [`--tenant=${tenant}`, "--create-bootstrap"]);
  const credentials = parseBootstrapOutput(created.text);
  if (created.code !== 0 || credentials === undefined) throw new Error("The grant issuer was not created, so the grant cannot be widened. The lines above say why. The grant is unchanged.");
  secrets.push(credentials.clientSecret);
  process.env.IW_BOOTSTRAP_CLIENT_ID = credentials.clientId;
  process.env.IW_BOOTSTRAP_CLIENT_SECRET = credentials.clientSecret;

  // An application seconds old is not always known to the token endpoint yet.
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const shown = await runScript("grant-show", "scripts/assessment-probe/grant.ts", [], {}, attempt === 9);
    if (shown.code === 0) {
      say(`The new grant issuer reads the site's grant: ${shown.text.trim().split("\n").at(-1) ?? ""}`);
      return;
    }
    say(`The new grant issuer is not accepted yet (attempt ${attempt} of 9). Waiting 10 seconds.`);
    await sleep(10_000);
  }
  throw new Error("The new grant issuer's token was still refused after 90 seconds. The grant is unchanged.");
}

async function runProbe(): Promise<void> {
  const out = `docs/superpowers/specs/evidence/${new Date().toISOString().slice(0, 10)}-list-if-match-probe`;
  const probe = await runScript("probe", "scripts/assessment-probe/main.ts", [`--out=${out}`], { IW_PROBE_LIBRARY: process.env.IW_PROBE_LIBRARY?.trim() || "Documents" });
  record(judgeListPrecondition(parseProbeLines(probe.text)));
}

async function runCampaign(): Promise<void> {
  const campaign = await runScript("campaign", "scripts/pre-eon/campaign.ts", [], { IW_SITTING_URL: `${BASE}/mcp` });
  record(judgeCampaign(parseCampaignTable(campaign.text)));
}

const DOSSIER = "# Sitting check dossier\n\nWritten by the sitting runner.\n";

/** The get_assessment additions, one refusal and two of the 2026-11-17 rulings, on an assessment this run opens for itself. */
async function runReadChecks(profile: ProfileFacts): Promise<void> {
  const client = await connect();
  const base = { profileId: profile.profileId };
  try {
    const opened = await call(client, "open_assessment", { ...base, vendor: `Sitting Check ${TAG}`, scope: "Security" });
    const id = opened.sc.assessmentId;
    if (opened.isError || typeof id !== "string") {
      record({ step: "read checks", verdict: "fail", detail: `open_assessment did not return an id: ${opened.text.slice(0, 300)}` });
      return;
    }
    const saved = await call(client, "save_assessment_artifact", { ...base, assessmentId: id, kind: "dossier", content: DOSSIER });
    const found = await call(client, "record_findings", {
      ...base,
      assessmentId: id,
      summary: "One finding, written by the sitting runner.",
      findings: [{ key: "F-1", observation: "A first line.\n\nA second paragraph.", risk: profile.risk, recommendation: "None needed." }],
    });
    if (saved.isError || found.isError) {
      record({ step: "read checks", verdict: "fail", detail: `the setup calls failed: ${(saved.isError ? saved : found).text.slice(0, 300)}` });
      return;
    }

    const listing = await call(client, "get_assessment", { ...base, status: "in_progress" });
    const listed = ((listing.sc.assessments as Array<{ assessmentId?: string }> | undefined) ?? []).some((entry) => entry.assessmentId === id);
    record({
      step: "get_assessment by status",
      verdict: !listing.isError && listed ? "pass" : "fail",
      detail: !listing.isError && listed ? `${id} is among ${(listing.sc.assessments as unknown[]).length} in progress` : `the listing did not carry ${id}: ${listing.text.slice(0, 300)}`,
    });

    const detail = await call(client, "get_assessment", { ...base, assessmentId: id, include: ["findings", "journal"] });
    const findings = (detail.sc.findings as unknown[] | undefined) ?? [];
    const entries = (detail.sc.journalEntries as unknown[] | undefined) ?? [];
    const readiness = (detail.sc.readiness as unknown[] | undefined) ?? [];
    const readback = !detail.isError && findings.length === 1 && entries.length > 0 && readiness.length > 0;
    record({
      step: "get_assessment readback and readiness",
      verdict: readback ? "pass" : "fail",
      detail: readback
        ? `1 finding, ${entries.length} journal entries, ${readiness.length} readiness lines`
        : `expected 1 finding, some journal entries and a readiness report; received ${findings.length}, ${entries.length} and ${readiness.length}: ${detail.text.slice(0, 300)}`,
    });

    const refused = await call(client, "transition_assessment", { ...base, assessmentId: id, target: "completed", disposition: profile.disposition, risk: profile.risk });
    const asRefusal = refused.threw === undefined && refused.isError && refused.refusal?.refused === true;
    record({
      step: "a refusal through a client that lists tools",
      verdict: asRefusal ? "pass" : "fail",
      detail: asRefusal
        ? `refused with its evidence: expected ${JSON.stringify(refused.refusal?.expected)}, observed ${JSON.stringify(refused.refusal?.observed)}`
        : refused.threw !== undefined
          ? `the client rejected the result: ${refused.threw}`
          : `not a refusal with evidence: ${refused.text.slice(0, 300)}`,
    });

    // Two of the rulings of 2026-11-17 that tool calls alone can show. The others need something
    // done to the site between calls, which is the campaign's work, or during one, which is not
    // producible from outside.
    const resaved = await call(client, "save_assessment_artifact", { ...base, assessmentId: id, kind: "dossier", content: DOSSIER });
    const afterResave = await call(client, "get_assessment", { ...base, assessmentId: id });
    const stateHeld = (afterResave.sc.assessment as { state?: string } | undefined)?.state;
    const leftAlone = !resaved.isError && resaved.sc.operation === "unchanged" && stateHeld === "FINDINGS";
    record({
      step: "an identical save leaves State alone",
      verdict: leftAlone ? "pass" : "fail",
      detail: leftAlone ? "the save answered unchanged and State still reads FINDINGS" : `the save answered ${JSON.stringify(resaved.sc.operation ?? resaved.text.slice(0, 200))} and State reads ${JSON.stringify(stateHeld ?? null)}`,
    });

    const parked = await call(client, "transition_assessment", { ...base, assessmentId: id, target: "provisional", disposition: profile.disposition, risk: profile.risk });
    const reopened = await call(client, "open_assessment", { ...base, vendor: `Sitting Check ${TAG}`, scope: "Security" });
    const returned = !parked.isError && !reopened.isError && reopened.sc.assessmentId === id && reopened.sc.created === false && reopened.sc.status === profile.provisional;
    record({
      step: "open returns a provisional assessment",
      verdict: returned ? "pass" : "fail",
      detail: returned
        ? `${id} was parked as ${profile.provisional}, and open answered it and created nothing`
        : `the transition ${parked.isError ? `failed: ${parked.text.slice(0, 200)}` : "landed"}; open answered ${JSON.stringify(reopened.sc.assessmentId ?? reopened.text.slice(0, 200))} with status ${JSON.stringify(reopened.sc.status ?? null)}, created ${JSON.stringify(reopened.sc.created ?? null)}`,
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Stops the server under an open, starts it again, repeats the open, and counts the vendor's assessments. */
async function runInterruptedOpen(profile: ProfileFacts): Promise<void> {
  const step = "interrupted open";
  let delay = INTERRUPT_MS;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const args = { profileId: profile.profileId, vendor: `Sitting Interrupt ${TAG} ${attempt}`, scope: "Security" };
    const first = await connect();
    let finished: Answer | undefined;
    const pending = call(first, "open_assessment", args).then((answer) => {
      finished = answer;
    });
    await sleep(delay);
    await stopServer();
    await Promise.race([pending, sleep(8000)]);
    await first.close().catch(() => undefined);
    const settled = finished as Answer | undefined;
    const interrupted = settled === undefined || settled.threw !== undefined;

    await startServer();
    const second = await connect();
    try {
      const retried = await call(second, "open_assessment", args);
      const byVendor = await call(second, "get_assessment", { profileId: profile.profileId, vendor: args.vendor });
      const count = ((byVendor.sc.assessments as unknown[] | undefined) ?? []).length;
      if (!interrupted) {
        say(`The open finished in under ${delay} ms, before the server stopped. Trying again with half the wait.`);
        delay = Math.max(1, Math.floor(delay / 2));
        continue;
      }
      const ok = !retried.isError && typeof retried.sc.assessmentId === "string" && count === 1;
      record({
        step,
        verdict: ok ? "pass" : "fail",
        detail: ok
          ? `stopped ${delay} ms into the open; the retry answered ${String(retried.sc.assessmentId)} (created ${String(retried.sc.created)}, resumed ${String(retried.sc.resumed)}) and the vendor has exactly one assessment`
          : `stopped ${delay} ms into the open; the retry ${retried.isError ? `failed: ${retried.text.slice(0, 300)}` : `answered ${String(retried.sc.assessmentId)}`} and the vendor has ${count} assessments`,
      });
      return;
    } finally {
      await second.close().catch(() => undefined);
    }
  }
  record({ step, verdict: "skipped", detail: `the open finished before the server stopped on all three tries; run again with --interrupt-ms set below ${delay}` });
}

async function cleanUp(): Promise<void> {
  await stopServer();
  if (grantWidened) {
    grantWidened = false;
    const restored = await runScript("grant-restore", "scripts/assessment-probe/grant.ts", ["--roles=read"]);
    const shown = await runScript("grant-show-after", "scripts/assessment-probe/grant.ts", []);
    const line = shown.text.trim().split("\n").at(-1) ?? "";
    const ok = restored.code === 0 && shown.code === 0 && /\bread\b/.test(line) && !/\bwrite\b/.test(line);
    record({ step: "grant restored to read", verdict: ok ? "pass" : "fail", detail: ok ? line : `THE GRANT MAY STILL BE AT WRITE. Run: npm run probe:assessment:grant -- --roles=read. Last answer: ${line}` });
  }
}

function writeSummary(): void {
  let commit = "unknown";
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    commit = dirty ? `${head} with uncommitted changes` : head;
  } catch {
    // Left as unknown: the summary is still worth writing.
  }
  const text = redactSecrets(summaryMarkdown({ startedAt: new Date(startedAt).toISOString(), commit, mode: SIM ? "simulated tenant" : "live", folder: FOLDER }, results), secrets);
  writeFileSync(join(FOLDER, "summary.md"), text);
  console.log("");
  console.log(text);
  console.log(`Written to ${join(FOLDER, "summary.md")}. Tell Claude: sitting done.`);
}

const startedAt = Date.now();

async function main(): Promise<void> {
  if (!existsSync("package.json") || !existsSync(PROFILE_FILE)) throw new Error(`Run this from the repository folder. ${PROFILE_FILE} was not found here.`);
  if (await healthy()) throw new Error(`Something already answers on ${BASE}. Stop it, or set PORT to a free port. This script does not stop a process it did not start.`);
  mkdirSync(FOLDER, { recursive: true });
  const profile = readProfile();

  if (!SIM) await gatherIdentity(profile);

  // Started before the sign-ins, not after: a server that will not start then costs the operator
  // nothing. The first live run learned that after two sign-ins and a new grant issuer.
  say(`Starting the server on ${BASE}.`);
  await startServer();
  say("The server answers.");

  if (!SIM) {
    await ensureGrantIssuer();
    const widened = await runScript("grant-widen", "scripts/assessment-probe/grant.ts", ["--roles=write"]);
    if (widened.code !== 0) throw new Error("The grant could not be widened to write, so nothing further was run.");
    grantWidened = true;
    await runProbe();
    await runCampaign();
  }
  await runReadChecks(profile);
  await runInterruptedOpen(profile);
}

let cleaning: Promise<void> | undefined;
function finish(): Promise<void> {
  cleaning ??= cleanUp()
    .catch((error: unknown) => record({ step: "clean up", verdict: "fail", detail: error instanceof Error ? error.message : String(error) }))
    .then(writeSummary);
  return cleaning;
}

process.on("SIGINT", () => {
  say("Interrupted. Stopping the server and restoring the grant before leaving.");
  void finish().finally(() => process.exit(130));
});

main()
  .catch((error: unknown) => {
    record({ step: "stopped early", verdict: "fail", detail: error instanceof Error ? error.message : String(error) });
  })
  .then(finish)
  .then(() => {
    process.exitCode = results.some((result) => result.verdict === "fail") ? 1 : 0;
    // The prompts leave stdin referenced; nothing more is read.
    process.stdin.pause();
  });
