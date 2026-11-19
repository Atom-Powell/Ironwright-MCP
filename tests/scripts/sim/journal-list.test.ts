import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSimDeployment } from "../../../scripts/sim/deployment.js";
import { simState } from "../../../scripts/sim/app.js";
import { createMemoryStateStore } from "../../../src/store/memory.js";
import { createScanCoordinator } from "../../../src/scan/coordinator.js";
import { runGetAssessment } from "../../../src/tools/assessment/get.js";
import { runOpenAssessment } from "../../../src/tools/assessment/open.js";
import { runSaveAssessmentArtifact } from "../../../src/tools/assessment/save-artifact.js";
import type { ToolContext } from "../../../src/tools/context.js";

const JOURNAL = {
  name: "Journal",
  columns: {
    assessmentId: "AssessmentId", at: "At", correlationId: "CorrelationId", stage: "Stage", operation: "Operation", target: "Target",
    etagBefore: "EtagBefore", etagAfter: "EtagAfter", contentHash: "ContentHash", priorContentHash: "PriorContentHash", versionId: "VersionId",
  },
};

// What the design exists for: the night of 2026-11-18 a restart lost the record of who opened a
// case. With the journal in a list, a server that starts again with an empty store still reads it.
describe("a journal kept in a list on the simulated tenant", () => {
  it("survives a restart: a fresh store still reads every entry the earlier run wrote", async () => {
    const folder = mkdtempSync(join(tmpdir(), "iw-journal-"));
    try {
      const profile = JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8")) as { lists: Record<string, unknown> };
      profile.lists.journal = JOURNAL;
      const path = join(folder, "profile.json");
      writeFileSync(path, JSON.stringify(profile));
      const d = createSimDeployment({ profilePath: path, now: () => new Date("2026-11-18T20:00:00.000Z") });

      const opened = await runOpenAssessment({ profileId: "vendor-assessments", vendor: "Acme Corp", scope: "Security" }, d.context);
      const assessmentId = (opened.structuredContent as { assessmentId: string }).assessmentId;
      const saved = await runSaveAssessmentArtifact({ profileId: "vendor-assessments", assessmentId, kind: "dossier", content: "# Dossier\n" }, d.context);
      expect(saved.isError).toBeUndefined();

      // The store held nothing: every entry went to the list.
      expect(await d.context.store.listJournal("vendor-assessments", assessmentId)).toEqual([]);
      const journalItems = d.sim.listItems("Journal");
      expect(journalItems.length).toBeGreaterThan(0);

      // A restart: the same tenant, a store that has never seen this assessment.
      const store = createMemoryStateStore();
      const restarted: ToolContext = { ...d.context, store, scans: createScanCoordinator({ client: d.sim.graph, store, now: d.context.now }) };
      const read = await runGetAssessment({ profileId: "vendor-assessments", assessmentId, include: ["journal"] }, restarted);

      const journal = (read.structuredContent as { journalEntries?: Array<{ stage: string; operation: string }> }).journalEntries ?? [];
      // The clock here is frozen, so every entry carries one time and the read orders by correlation
      // id; the same entries, whatever their order, is what a restart must not lose.
      expect(journal.map((entry) => `${entry.stage} ${entry.operation}`).sort()).toEqual(
        journalItems.filter((item) => item.fields.AssessmentId === assessmentId).map((item) => `${String(item.fields.Stage)} ${String(item.fields.Operation)}`).sort(),
      );
      expect(journal.length).toBeGreaterThan(1);
      expect(journal.some((entry) => entry.stage === "DOSSIER" && entry.operation === "file_created")).toBe(true);

      // The simulator's own view of the tenant shows the journal list and the entries in it.
      const state = await simState({ ...d, context: restarted });
      expect(Object.keys(state.lists as object)).toContain("Journal");
      expect(((state.journal as Record<string, unknown[]>)[assessmentId] ?? []).length).toBe(journal.length);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
