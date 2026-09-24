import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { reconcile, type WorkbookSnapshot } from "../../domain/reconcile/index.js";
import { pairMisnamedArtifacts, type RenameCandidate } from "../../domain/rename/plan.js";
import type { Profile } from "../../domain/profile/schema.js";
import type { GraphClient } from "../../graph/client.js";
import { readDriveItemEtag } from "../../graph/rename.js";
import { readWorkbookSnapshot } from "../../scan/workbook.js";
import type { ExcludedPlanItem, PlanExclusionReason, RenamePlanItem, StoredPlan } from "../../store/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { periodFromDate } from "../reconciliation/run.js";
import { newPlanId } from "./ids.js";
import { MAX_PLAN_ITEMS, MAX_PLAN_ITEMS_LISTED, type GenerateRenamePlanOutput } from "./output.js";
import { generatePlanText } from "./text.js";

export const GENERATE_RENAME_PLAN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Configured profile to plan against, for example \"example\"."),
  clients: z
    .array(z.string().min(1))
    .optional()
    .describe("Limit the plan to these clients, for example [\"CLIENTA\"]. Omit to cover every client in the workbook."),
} satisfies z.ZodRawShape;

const InputObject = z.object(GENERATE_RENAME_PLAN_INPUT_SCHEMA);

type ReadWorkbook = (client: GraphClient, profile: Profile) => Promise<WorkbookSnapshot>;

function comparePaths(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Generates a reviewable rename plan and persists it.
 *
 * It runs the reconciliation engine itself rather than reading a stored report,
 * because phase 4b deliberately declined to persist reports and `reconcile` is
 * the single public entry for a compliance verdict. Two tools deciding
 * independently what "misnamed" means is what that rule exists to prevent.
 */
export async function runGenerateRenamePlan(
  input: unknown,
  context: ToolContext,
  // Both injected only by tests. Production uses the real reader and real ids.
  readWorkbook: ReadWorkbook = readWorkbookSnapshot,
  makePlanId: () => string = () => newPlanId("rnm", context.now()),
): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "generate_rename_plan", profileId: args.profileId };

  try {
    const profile = context.profiles.get(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    // Bracketed the way every other tool brackets this counter: it lives on the
    // per-process client, so reading it raw would answer what the process has
    // spent since it started rather than what this call paid.
    const requestsBeforeWorkbook = context.graph.requests();
    const workbook = await readWorkbook(context.graph, profile);
    const workbookReadGraphRequestsByThisCall = context.graph.requests() - requestsBeforeWorkbook;

    const scan = await context.scans.run(profile);
    const report = reconcile(profile, workbook, scan.result.snapshot, periodFromDate(context.now()));

    // Paired over the whole report, then narrowed. The collision rules read
    // paths belonging to clients a scoped call is excluding, and a plan that
    // renamed a file onto a path another client's file holds would lose one of
    // them.
    const pairing = pairMisnamedArtifacts(report);
    const scope = args.clients === undefined ? undefined : new Set(args.clients);
    const candidates = scope === undefined ? pairing.candidates : pairing.candidates.filter((c) => scope.has(c.client));
    const collisions = scope === undefined ? pairing.collisions : pairing.collisions.filter((c) => scope.has(c.client));

    if (candidates.length > MAX_PLAN_ITEMS) {
      // Refused before the fetch loop, so a plan that cannot be stored costs no
      // Graph requests at all.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `This would plan ${String(candidates.length)} renames, more than the ${String(MAX_PLAN_ITEMS)} one ` +
              "stored plan holds. Narrow it by naming clients in the clients argument and generate one plan per " +
              "group. Nothing was fetched and no plan was saved.",
          },
        ],
      };
    }

    const items: RenamePlanItem[] = [];
    const excluded: ExcludedPlanItem<PlanExclusionReason>[] = collisions.map((collision) => ({
      path: collision.path,
      currentName: collision.currentName,
      targetName: collision.targetName,
      client: collision.client,
      reason: collision.reason,
    }));

    for (const candidate of candidates) {
      // Fetched now rather than read from the inventory. The inventory's etag
      // comes from a delta snapshot that may be hours old and is recorded as
      // `item.eTag ?? ""`, so it can be empty; this fetch measures the window
      // that matters, generate to execute, and has no empty-string hole. The
      // same call confirms the file is still at that path under that name,
      // because path addressing puts the filename in the URL.
      const lookup = await readDriveItemEtag(context.graph, { driveId: scan.result.driveId, path: candidate.path });
      if (lookup.kind === "not_found") {
        excluded.push(excludedFrom(candidate, "file_not_found_at_plan_time"));
        continue;
      }
      if (lookup.etag === undefined) {
        excluded.push(excludedFrom(candidate, "no_etag_available"));
        continue;
      }
      items.push({ ...candidate, etag: lookup.etag });
    }

    const sortedExcluded = [...excluded].sort(comparePaths);
    const plan: StoredPlan = {
      planId: makePlanId(),
      profileId: args.profileId,
      kind: "rename",
      driveId: scan.result.driveId,
      createdAt: context.now().toISOString(),
      items: [...items].sort(comparePaths),
      excluded: sortedExcluded,
    };
    await context.store.savePlan(args.profileId, plan);

    const output: GenerateRenamePlanOutput = {
      planId: plan.planId,
      profileId: plan.profileId,
      library: profile.identity.library,
      driveId: plan.driveId,
      createdAt: plan.createdAt,
      scannedAt: report.provenance.scannedAt,
      items: plan.items.slice(0, MAX_PLAN_ITEMS_LISTED).map((item) => ({
        path: item.path,
        currentName: item.currentName,
        targetName: item.targetName,
        targetPath: item.targetPath,
        client: item.client,
      })),
      itemCount: plan.items.length,
      itemsOmitted: Math.max(0, plan.items.length - MAX_PLAN_ITEMS_LISTED),
      excluded: sortedExcluded.slice(0, MAX_PLAN_ITEMS_LISTED),
      excludedCount: sortedExcluded.length,
      excludedOmitted: Math.max(0, sortedExcluded.length - MAX_PLAN_ITEMS_LISTED),
      workbookReadGraphRequestsByThisCall,
      // Counted, not bracketed. The request counter lives on a process-level
      // client a concurrent call also moves, so a bracket around this loop
      // would attribute another call's requests to this one. One lookup is
      // issued per candidate, so the count is exact by construction; it is a
      // count of lookups, not of Graph requests, since a throttled lookup
      // retries and spends more than one request while still being one lookup.
      etagLookupsIssued: candidates.length,
      scanGraphRequestsByThisCall: scan.joined ? 0 : scan.result.graphRequests,
      scanSharedWithConcurrentCall: scan.joined,
    };

    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [{ type: "text" as const, text: generatePlanText(output).join("\n") }],
    };
  } catch (error) {
    // Logged before it is described, because `describeToolFailure` tells the
    // operator the full Graph response is in the server log, and a message must
    // not promise what this function did not do.
    console.error(`generate_rename_plan failed for profile "${args.profileId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}

function excludedFrom(candidate: RenameCandidate, reason: PlanExclusionReason): ExcludedPlanItem<PlanExclusionReason> {
  return {
    path: candidate.path,
    currentName: candidate.currentName,
    targetName: candidate.targetName,
    client: candidate.client,
    reason,
  };
}
