import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProfileRegistry } from "../../../src/profiles/registry.js";
import type { AssessmentProfile } from "../../../src/domain/profile/assessment.js";
import { appendJournal, JournalAppendError, readJournal } from "../../../src/tools/assessment/journal.js";
import type { AssessmentContext } from "../../../src/tools/assessment/context.js";
import { GraphRequestError } from "../../../src/graph/errors.js";
import { createFakeToolContext } from "../fake-context.js";
import { SITE_URL, createScriptedGraph, listItem } from "./fake-graph.js";

// The journal kept in a SharePoint list on the workflow's own site, when the profile names one
// (docs/superpowers/specs/2026-11-18-journal-in-a-sharepoint-list-design.md). Probed live on
// 2026-11-18: the list, the indexed id column and the paged filter behave as these fakes answer.

export const JOURNAL_LIST = {
  name: "Journal",
  columns: {
    assessmentId: "AssessmentId", at: "At", correlationId: "CorrelationId", stage: "Stage", operation: "Operation", target: "Target",
    etagBefore: "EtagBefore", etagAfter: "EtagAfter", contentHash: "ContentHash", priorContentHash: "PriorContentHash", versionId: "VersionId",
  },
};

function profileWith(journal: unknown | undefined): Record<string, unknown> {
  const base = JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8")) as { lists: Record<string, unknown> } & Record<string, unknown>;
  return journal === undefined ? base : { ...base, lists: { ...base.lists, journal } };
}

function setup(journal: unknown | undefined, script: Parameters<typeof createScriptedGraph>[0]) {
  const { graph, calls } = createScriptedGraph(script);
  const profiles = createProfileRegistry([{ source: "p.json", contents: profileWith(journal) }], SITE_URL);
  const context = createFakeToolContext({ profiles, graph, now: () => new Date("2026-11-18T20:00:00.000Z") });
  const profile = profiles.getAny("vendor-assessments") as AssessmentProfile;
  const ac: AssessmentContext = { profile, siteId: "site-1", driveId: "drive-1", correlationId: "corr-1", now: new Date("2026-11-18T20:00:00.000Z") };
  return { context, ac, calls };
}

const ENTRY = { stage: "DOSSIER", operation: "file_created" as const, target: "Assessments/Acme Corp/ASM-2026-00002/Research/Acme Corp_Research_Dossier.md", etagAfter: '"{A},1"', contentHash: "abc123" };

describe("the journal kept in a list", () => {
  it("writes an entry as one item in the profile's journal list, and nothing to the store", async () => {
    const { context, ac, calls } = setup(JOURNAL_LIST, [{ method: "post", pathIncludes: "/sites/site-1/lists/Journal/items", response: listItem("7", {}) }]);

    await appendJournal(context, ac, "ASM-2026-00002", ENTRY);

    expect(calls.filter((call) => call.method === "post").map((call) => call.body)).toEqual([
      {
        fields: {
          Title: "ASM-2026-00002 DOSSIER file_created",
          AssessmentId: "ASM-2026-00002",
          At: "2026-11-18T20:00:00.000Z",
          CorrelationId: "corr-1",
          Stage: "DOSSIER",
          Operation: "file_created",
          Target: ENTRY.target,
          EtagAfter: ENTRY.etagAfter,
          ContentHash: "abc123",
        },
      },
    ]);
    expect(await context.store.listJournal("vendor-assessments", "ASM-2026-00002")).toEqual([]);
  });

  it("keeps the journal in the store when the profile names no journal list", async () => {
    const { context, ac, calls } = setup(undefined, []);

    await appendJournal(context, ac, "ASM-2026-00002", ENTRY);

    expect(calls).toHaveLength(0);
    expect(await readJournal(context, ac, "ASM-2026-00002")).toMatchObject([{ stage: "DOSSIER", operation: "file_created", correlationId: "corr-1" }]);
  });

  it("names the confirmed write when the journal item cannot be created", async () => {
    const refused = new GraphRequestError({ method: "POST", path: "/lists/Journal/items", status: 503, body: "" });
    const { context, ac } = setup(JOURNAL_LIST, [{ method: "post", pathIncludes: "/lists/Journal/items", throws: refused }]);

    const failure = await appendJournal(context, ac, "ASM-2026-00002", ENTRY).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JournalAppendError);
    expect((failure as Error).message).toContain(`Graph confirmed file_created at ${ENTRY.target}`);
  });

  // A gateway status does not say whether the create landed, and the client retries a POST on one,
  // so the entry may be missing or may be there twice. The words cannot say which.
  it("says the journal may or may not show a write when its create ended on a gateway status", async () => {
    const gateway = new GraphRequestError({ method: "POST", path: "/lists/Journal/items", status: 504, body: "" });
    const { context, ac } = setup(JOURNAL_LIST, [{ method: "post", pathIncludes: "/lists/Journal/items", throws: gateway }]);

    const failure = (await appendJournal(context, ac, "ASM-2026-00002", ENTRY).catch((error: unknown) => error)) as Error;

    expect(failure).toBeInstanceOf(JournalAppendError);
    expect(failure.message).toContain("The write stands. Whether the journal for ASM-2026-00002 shows it is not known: the create ended on a gateway status, so the entry may be missing or may be there twice.");
    expect(failure.message).not.toContain("does not show it");
  });

  // SharePoint's eq on text ignores case, so another assessment whose id differs only in case can come back.
  it("leaves out an entry whose id is not exactly the one asked for", async () => {
    const row = (id: string, assessmentId: string) => listItem(id, { AssessmentId: assessmentId, At: "2026-11-18T20:00:01.000Z", CorrelationId: "c", Stage: "ID", Operation: "list_item_updated", Target: "x" });
    const { context, ac, calls } = setup(JOURNAL_LIST, [{ method: "get", pathIncludes: "/lists/Journal/items", response: { value: [row("1", "ASM-2026-00002"), row("2", "asm-2026-00002")] } }]);

    const entries = await readJournal(context, ac, "ASM-2026-00002");

    expect(entries).toHaveLength(1);
    // A long running case's journal is read in pages of 500, so the query's page cap is far off.
    expect(decodeURIComponent(calls[0]!.path)).toContain("$top=500");
  });

  it("reads one assessment's entries back from the list, ordered by time then correlation id", async () => {
    const row = (id: string, at: string, correlationId: string, stage: string) =>
      listItem(id, { AssessmentId: "ASM-2026-00002", At: at, CorrelationId: correlationId, Stage: stage, Operation: "list_item_updated", Target: "Assessments/2" });
    const { context, ac, calls } = setup(JOURNAL_LIST, [
      {
        method: "get",
        pathIncludes: "/sites/site-1/lists/Journal/items",
        response: { value: [row("3", "2026-11-18T20:00:02.000Z", "b", "FINDINGS"), row("1", "2026-11-18T20:00:01.000Z", "z", "ID"), row("2", "2026-11-18T20:00:02.000Z", "a", "DOSSIER")] },
      },
    ]);

    const entries = await readJournal(context, ac, "ASM-2026-00002");

    expect(entries.map((entry) => entry.stage)).toEqual(["ID", "DOSSIER", "FINDINGS"]);
    expect(entries[0]).toEqual({ at: "2026-11-18T20:00:01.000Z", correlationId: "z", stage: "ID", operation: "list_item_updated", target: "Assessments/2" });
    expect(decodeURIComponent(calls[0]!.path)).toContain("fields/AssessmentId eq 'ASM-2026-00002'");
  });

  // A journal missing an entry reads as a complete record, so an entry that cannot be read is refused, not skipped.
  it("refuses a journal item it cannot read, naming the item", async () => {
    const { context, ac } = setup(JOURNAL_LIST, [
      { method: "get", pathIncludes: "/lists/Journal/items", response: { value: [listItem("9", { AssessmentId: "ASM-2026-00002", At: "2026-11-18T20:00:01.000Z", Stage: "ID", Operation: "renamed", Target: "x" })] } },
    ]);

    await expect(readJournal(context, ac, "ASM-2026-00002")).rejects.toThrow(/Journal item 9 in list "Journal" cannot be read/);
  });
});

describe("a profile's journal list", () => {
  it("is optional, and refused when it shares a name with another of the profile's lists", () => {
    expect(() => createProfileRegistry([{ source: "p.json", contents: profileWith(JOURNAL_LIST) }], SITE_URL)).not.toThrow();
    const findingsName = (profileWith(undefined).lists as { findings: { name: string } }).findings.name;
    expect(() => createProfileRegistry([{ source: "p.json", contents: profileWith({ ...JOURNAL_LIST, name: findingsName }) }], SITE_URL)).toThrow(/lists\.journal/);
  });
});
