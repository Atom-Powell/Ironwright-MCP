// scripts/assessment-probe/journal.ts
/**
 * The probe the journal-in-a-list design waits on
 * (docs/superpowers/specs/2026-11-18-journal-in-a-sharepoint-list-design.md).
 * Four things this project has not measured: a list with the journal's columns
 * created through Graph, a column created with `indexed: true` and filtered on
 * without the non-indexed header, a multi line text value past 255 characters,
 * and a filter on one id across more than one page. Every item is created by
 * the server application, so the probe also shows it can write the list.
 *
 *   npx tsx scripts/assessment-probe/journal.ts --site=<site url>
 *
 * Reads IW_TENANT_ID, IW_CLIENT_ID, IW_CLIENT_SECRET (the server application,
 * which must hold write on the site) and IW_BOOTSTRAP_CLIENT_ID and
 * IW_BOOTSTRAP_CLIENT_SECRET (the grant issuer, which creates the list).
 * write-session.ps1 runs it with those set, after raising the site to write.
 *
 * The list it creates is left behind, named for the probe and the time, so it
 * cannot be taken for a real journal. The clients are passed in, so every
 * decision here is tested against scripted answers.
 */
import type { GraphClient } from "../../src/graph/client.js";
import { siteLookupPath } from "../../src/graph/drive.js";
import { GraphRequestError } from "../../src/graph/errors.js";

export const JOURNAL_COLUMNS = [
  "AssessmentId",
  "At",
  "CorrelationId",
  "Stage",
  "Operation",
  "Target",
  "EtagBefore",
  "EtagAfter",
  "ContentHash",
  "PriorContentHash",
  "VersionId",
] as const;

export interface ProbeStep {
  step: string;
  verdict: "pass" | "observed" | "fail";
  detail: string;
}

export interface JournalProbeInputs {
  issuer: Pick<GraphClient, "get" | "post">;
  server: Pick<GraphClient, "get" | "post">;
  siteUrl: string;
  stamp: string;
  /** How many entries J4 writes for its first id. More than one page of 50, so paging is exercised. */
  manyEntries?: number;
}

/** The list definition the design specifies: the assessment id indexed, the target multi line, the rest single line text. */
export function journalListBody(displayName: string): unknown {
  return {
    displayName,
    list: { template: "genericList" },
    columns: JOURNAL_COLUMNS.map((name) =>
      name === "AssessmentId" ? { name, indexed: true, text: {} } : name === "Target" ? { name, text: { allowMultipleLines: true } } : { name, text: {} },
    ),
  };
}

function describe(error: unknown): string {
  if (error instanceof GraphRequestError) return `${error.status}${error.code === undefined ? "" : ` ${error.code}`}`;
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number | undefined {
  return error instanceof GraphRequestError ? error.status : undefined;
}

export async function probeJournalList(inputs: JournalProbeInputs): Promise<ProbeStep[]> {
  const steps: ProbeStep[] = [];
  const add = (step: string, verdict: ProbeStep["verdict"], detail: string): void => {
    steps.push({ step, verdict, detail });
  };
  const listName = `IW Probe Journal ${inputs.stamp}`;
  const many = inputs.manyEntries ?? 60;

  const site = await inputs.issuer.get<{ id?: unknown }>(`${siteLookupPath(inputs.siteUrl)}?$select=id`);
  if (typeof site.id !== "string") throw new Error(`resolving ${inputs.siteUrl} returned no site id`);
  const siteId = site.id;
  const listPath = `/sites/${siteId}/lists/${encodeURIComponent(listName)}`;

  // J1: the list, created by the grant issuer from the design's definition, its columns read back.
  try {
    await inputs.issuer.post(`/sites/${siteId}/lists`, journalListBody(listName));
  } catch (error) {
    add("J1 create the journal list", "fail", `the create answered ${describe(error)}; nothing further was run`);
    return steps;
  }
  const columns = await inputs.issuer.get<{ value?: Array<{ name?: unknown; indexed?: unknown; text?: { allowMultipleLines?: unknown } }> }>(
    `${listPath}/columns?$select=name,indexed,text`,
  );
  const byName = new Map((columns.value ?? []).map((column) => [String(column.name), column]));
  const missing = JOURNAL_COLUMNS.filter((name) => !byName.has(name));
  add(
    "J1 create the journal list",
    missing.length === 0 ? "pass" : "fail",
    missing.length === 0 ? `"${listName}" created; all ${JOURNAL_COLUMNS.length} columns read back` : `created, but columns missing on read back: ${missing.join(", ")}`,
  );
  if (missing.length > 0) return steps;

  // J2: was the index honored, and does a filter on it need the non-indexed header.
  const indexed = byName.get("AssessmentId")?.indexed === true;
  const multiline = byName.get("Target")?.text?.allowMultipleLines === true;
  add("J2a AssessmentId created indexed", indexed ? "pass" : "fail", `the column reads back indexed ${String(byName.get("AssessmentId")?.indexed)}`);
  add("J2b Target created multi line", multiline ? "pass" : "fail", `the column reads back allowMultipleLines ${String(byName.get("Target")?.text?.allowMultipleLines)}`);

  // J3: one entry from the server application, with a target past 255 characters, read back whole.
  const longTarget = `Incidents/${"Long Client Name ".repeat(24)}/INC-PROBE/Record/target.md`.slice(0, 400);
  let created: { id?: unknown; fields?: Record<string, unknown> };
  try {
    created = await inputs.server.post(`${listPath}/items`, {
      fields: { Title: "PROBE J3", AssessmentId: "PROBE-B", At: new Date(0).toISOString(), CorrelationId: "j3", Stage: "PROBE", Operation: "file_created", Target: longTarget },
    });
  } catch (error) {
    add("J3 the server application creates an entry", "fail", `the create answered ${describe(error)}; the server application cannot write this list, so nothing further was run`);
    return steps;
  }
  const back = await inputs.server.get<{ fields?: Record<string, unknown> }>(`${listPath}/items/${String(created.id)}?$expand=fields`);
  const target = back.fields?.Target;
  add(
    "J3 the server application creates an entry",
    target === longTarget ? "pass" : "fail",
    target === longTarget ? `created, and the ${longTarget.length} character target read back whole` : `created, but the target read back as ${typeof target === "string" ? `${target.length} characters` : JSON.stringify(target)}, not ${longTarget.length}`,
  );

  // J4: many entries for one id and a few for another; a filtered read of the first, across pages.
  for (let n = 1; n <= many; n += 1) {
    await inputs.server.post(`${listPath}/items`, {
      fields: { Title: `PROBE J4 ${n}`, AssessmentId: "PROBE-A", At: new Date(n * 1000).toISOString(), CorrelationId: "j4", Stage: "PROBE", Operation: "list_item_created", Target: "Probe/target" },
    });
  }
  for (let n = 1; n <= 2; n += 1) {
    await inputs.server.post(`${listPath}/items`, {
      fields: { Title: `PROBE J4 other ${n}`, AssessmentId: "PROBE-B", At: new Date(n * 1000).toISOString(), CorrelationId: "j4", Stage: "PROBE", Operation: "list_item_created", Target: "Probe/target" },
    });
  }

  // No Prefer header: the question J2 asks is whether the index makes it unnecessary.
  const filter = encodeURIComponent("fields/AssessmentId eq 'PROBE-A'");
  let url: string | undefined = `${listPath}/items?$expand=fields&$top=50&$filter=${filter}`;
  let count = 0;
  let pages = 0;
  let others = 0;
  try {
    while (url !== undefined && pages < 10) {
      pages += 1;
      const page: { value?: Array<{ fields?: Record<string, unknown> }>; "@odata.nextLink"?: unknown } = await inputs.server.get(url);
      for (const item of page.value ?? []) {
        if (item.fields?.AssessmentId === "PROBE-A") count += 1;
        else others += 1;
      }
      url = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
    }
    add("J2c filter on AssessmentId without the non-indexed header", "pass", `answered 200 over ${pages} page${pages === 1 ? "" : "s"}`);
    add(
      "J4 one id's entries, across pages",
      count === many && others === 0 ? "pass" : "fail",
      `${count} of ${many} entries for PROBE-A over ${pages} page${pages === 1 ? "" : "s"}, and ${others} for any other id`,
    );
  } catch (error) {
    add(
      "J2c filter on AssessmentId without the non-indexed header",
      statusOf(error) === 400 ? "observed" : "fail",
      `answered ${describe(error)}${statusOf(error) === 400 ? ": the index does not stand in for the header, so the journal read sends it as the other reads do" : ""}`,
    );
  }

  add("J5 left behind", "observed", `the list "${listName}" holds ${many + 3} probe entries and is left for inspection; delete it when done`);
  return steps;
}

// ---------------------------------------------------------------- the command

async function main(): Promise<void> {
  const { createGraphClient } = await import("../../src/graph/client.js");
  const { clientCredentialsTokenProvider } = await import("../../src/graph/token.js");
  const env = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const site = process.argv.slice(2).find((argument) => argument.startsWith("--site="))?.slice("--site=".length);
  if (!site) throw new Error("--site=<site url> is required");
  const tenantId = env("IW_TENANT_ID");
  const issuer = createGraphClient({ tokenProvider: clientCredentialsTokenProvider({ tenantId, clientId: env("IW_BOOTSTRAP_CLIENT_ID"), clientSecret: env("IW_BOOTSTRAP_CLIENT_SECRET") }) });
  const server = createGraphClient({ tokenProvider: clientCredentialsTokenProvider({ tenantId, clientId: env("IW_CLIENT_ID"), clientSecret: env("IW_CLIENT_SECRET") }) });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const steps = await probeJournalList({ issuer, server, siteUrl: site, stamp });
  for (const step of steps) console.log(`${step.verdict.toUpperCase().padEnd(8)} ${step.step}: ${step.detail}`);
  if (steps.some((step) => step.verdict === "fail")) process.exitCode = 1;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/assessment-probe/journal.ts") === true) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
