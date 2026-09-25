import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { reconcile, type WorkbookSnapshot } from "../../domain/reconcile/index.js";
import { pairMisplacedArtifacts } from "../../domain/move/plan.js";
import type { Profile } from "../../domain/profile/schema.js";
import type { GraphClient } from "../../graph/client.js";
import { readWorkbookSnapshot } from "../../scan/workbook.js";
import type { ExcludedPlanItem, MoveExclusionReason, StoredPlan } from "../../store/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { comparePaths } from "../plans/apply.js";
import { fetchPlanEtags } from "../plans/etags.js";
import { periodFromDate } from "../reconciliation/run.js";
import { newPlanId } from "../rename/ids.js";
import { MAX_PLAN_ITEMS, MAX_PLAN_ITEMS_LISTED, type GenerateMovePlanOutput } from "./output.js";
import { generateMovePlanText } from "./text.js";

export const GENERATE_MOVE_PLAN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Configured profile to plan against, for example \"example\"."),
  clients: z
    .array(z.string().min(1))
    .optional()
    .describe("Limit the plan to these clients, for example [\"CLIENTA\"]. Omit to cover every client in the workbook."),
} satisfies z.ZodRawShape;

const InputObject = z.object(GENERATE_MOVE_PLAN_INPUT_SCHEMA);

type ReadWorkbook = (client: GraphClient, profile: Profile) => Promise<WorkbookSnapshot>;

/**
 * Generates a reviewable move plan and persists it. It runs the
 * reconciliation engine itself for the reason generate_rename_plan does:
 * reconcile is the single public entry for a compliance verdict, and two
 * tools deciding independently what misplaced means is what that rule
 * prevents.
 */
export async function runGenerateMovePlan(
  input: unknown,
  context: ToolContext,
  // Both injected only by tests. Production uses the real reader and real ids.
  readWorkbook: ReadWorkbook = readWorkbookSnapshot,
  makePlanId: () => string = () => newPlanId("mov", context.now()),
): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "generate_move_plan", profileId: args.profileId };

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

    // Paired over the whole report, then narrowed. The occupancy rule reads
    // paths belonging to clients a scoped call is excluding, and a plan that
    // moved a file onto a path another client's file holds would lose one of
    // them.
    const pairing = pairMisplacedArtifacts(report, scan.result.snapshot.folderPaths);
    const scope = args.clients === undefined ? undefined : new Set(args.clients);
    const candidates = scope === undefined ? pairing.candidates : pairing.candidates.filter((c) => scope.has(c.client));
    const exclusions = scope === undefined ? pairing.exclusions : pairing.exclusions.filter((e) => scope.has(e.client));

    if (candidates.length > MAX_PLAN_ITEMS) {
      // Refused before the fetch loop, so a plan that cannot be stored costs no
      // Graph requests at all.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `This would plan ${String(candidates.length)} moves, more than the ${String(MAX_PLAN_ITEMS)} one ` +
              "stored plan holds. Narrow it by naming clients in the clients argument and generate one plan per " +
              "group. Nothing was fetched and no plan was saved.",
          },
        ],
      };
    }

    const excluded: ExcludedPlanItem<MoveExclusionReason>[] = exclusions.map((e) => ({
      path: e.path,
      currentName: e.currentName,
      targetName: e.targetName,
      client: e.client,
      reason: e.reason,
      ...(e.library === undefined ? {} : { library: e.library }),
    }));

    const fetched = await fetchPlanEtags(context.graph, scan.result.driveId, candidates);
    const items = fetched.items;
    excluded.push(...fetched.excluded);

    const sortedExcluded = [...excluded].sort(comparePaths);
    const plan: StoredPlan = {
      planId: makePlanId(),
      profileId: args.profileId,
      kind: "move",
      driveId: scan.result.driveId,
      createdAt: context.now().toISOString(),
      items: [...items].sort(comparePaths),
      excluded: sortedExcluded,
    };
    await context.store.savePlan(args.profileId, plan);

    const output: GenerateMovePlanOutput = {
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
      content: [{ type: "text" as const, text: generateMovePlanText(output).join("\n") }],
    };
  } catch (error) {
    // Logged before it is described, because `describeToolFailure` tells the
    // operator the full Graph response is in the server log, and a message must
    // not promise what this function did not do.
    console.error(`generate_move_plan failed for profile "${args.profileId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}
