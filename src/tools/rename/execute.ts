import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readDriveItemEtag, renameDriveItem } from "../../graph/rename.js";
import type { RenamePlanItem, StoredPlan } from "../../store/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { newPlanId } from "./ids.js";
import {
  MAX_PLAN_ITEMS_LISTED,
  type ExecuteRenamePlanOutput,
  type RenameItemOutcome,
  type RenameItemResult,
} from "./output.js";
import { executePlanText } from "./text.js";

export const EXECUTE_RENAME_PLAN_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Profile the plan was generated against, for example \"example\"."),
  planId: z
    .string()
    .min(1)
    .describe("Plan id returned by generate_rename_plan, for example \"rnm-2026-09-18-a1b2c3d4\"."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Set true to apply the plan for real, for example true. Leave false or omit for a dry run."),
} satisfies z.ZodRawShape;

const InputObject = z.object(EXECUTE_RENAME_PLAN_INPUT_SCHEMA);

function comparePaths(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * The inverse of a forward plan, ready before the first write.
 *
 * Each entry carries the forward item's PRE-rename etag, which is stale for the
 * inverse operation by construction: the rename it undoes has not happened yet,
 * and when it does it will change the etag. The executor overwrites each entry
 * as its rename lands. An entry that never gets overwritten keeps the stale
 * value and is refused on replay, which is the safe direction: a stale
 * precondition declines to act, where an absent one would rename whatever
 * happens to be sitting at that path.
 */
function reversalItemsFor(items: readonly RenamePlanItem[]): RenamePlanItem[] {
  return items.map((item) => ({
    path: item.targetPath,
    currentName: item.targetName,
    targetName: item.currentName,
    targetPath: item.path,
    etag: item.etag,
    client: item.client,
  }));
}

/**
 * Applies a rename plan, or previews it.
 *
 * There is one loop, not two. A dry run walks the same items in the same order
 * and makes the same per-item decision about what to send; the PATCH is the
 * only thing it does not do. A separately implemented preview would be a second
 * executor, and the two would disagree exactly when it mattered.
 */
export async function runExecuteRenamePlan(
  input: unknown,
  context: ToolContext,
  // Injected only by tests. Production always generates a fresh id.
  makeReversalPlanId: () => string = () => newPlanId("rev", context.now()),
): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "execute_rename_plan", profileId: args.profileId };

  try {
    const profile = context.profiles.get(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    const plan = await context.store.getPlan(args.profileId, args.planId);
    if (plan === undefined || plan.profileId !== args.profileId) {
      // The second half of that condition cannot fire through a partitioned
      // read today. It is checked anyway, because the alternative to a refusal
      // here is applying one profile's plan against another profile's library.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `No plan "${args.planId}" is stored for profile "${args.profileId}". Generate one with ` +
              "generate_rename_plan and pass the id it returns. Nothing was changed.",
          },
        ],
      };
    }

    const sorted = [...plan.items].sort(comparePaths);
    const results: RenameItemResult[] = [];
    let graphRequests = 0;
    let reversalEntriesNotRefreshed = 0;
    let reversalPlanId: string | undefined;

    if (!args.confirm) {
      for (const item of sorted) results.push(resultFor(item, "would_rename"));
    } else {
      const reversal: StoredPlan = {
        planId: makeReversalPlanId(),
        profileId: args.profileId,
        kind: "rename",
        driveId: plan.driveId,
        createdAt: context.now().toISOString(),
        items: reversalItemsFor(sorted),
        excluded: [],
        reverses: plan.planId,
      };
      // Written before the first rename, so a crash mid-apply still leaves
      // something to roll back with. It necessarily over-covers at this point,
      // listing inverses for renames that have not happened; replaying one of
      // those finds nothing at the source path and reports it, which is how the
      // over-coverage corrects itself through the same machinery.
      await context.store.savePlan(args.profileId, reversal);
      reversalPlanId = reversal.planId;

      for (const [index, item] of sorted.entries()) {
        let outcome: RenameItemOutcome;
        try {
          const renamed = await renameDriveItem(context.graph, {
            driveId: plan.driveId,
            path: item.path,
            newName: item.targetName,
            etag: item.etag,
          });
          graphRequests += 1;

          if (renamed.kind === "precondition_failed") {
            outcome = "changed_since_plan";
          } else if (renamed.kind === "not_found") {
            outcome = "not_found";
          } else {
            outcome = "renamed";
            let fresh = renamed.etag;
            if (fresh === undefined) {
              // Graph's documented PATCH response is the updated item, so this
              // branch should not run. It exists because "should" is not
              // "does", and this project has paid once for designing against
              // an API surface nobody had called.
              const lookup = await readDriveItemEtag(context.graph, {
                driveId: plan.driveId,
                path: item.targetPath,
              });
              graphRequests += 1;
              fresh = lookup.kind === "found" ? lookup.etag : undefined;
            }
            if (fresh === undefined) {
              reversalEntriesNotRefreshed += 1;
            } else {
              const entry = reversal.items[index];
              if (entry !== undefined) reversal.items[index] = { ...entry, etag: fresh };
              // Saved per item rather than once at the end. A single save at
              // the end would lose every correction to a crash, which is the
              // failure the early write exists to survive.
              await context.store.savePlan(args.profileId, reversal);
            }
          }
        } catch (error) {
          // Recorded and continued rather than rethrown. Rethrowing would
          // discard the report, which is the operator's only account of which
          // renames already applied; the reversal log alone does not say which
          // of its entries are live.
          console.error(`execute_rename_plan could not rename "${item.path}" under plan "${plan.planId}"`, error);
          graphRequests += 1;
          outcome = "failed";
        }
        results.push(resultFor(item, outcome));
      }
    }

    const excluded = [...plan.excluded].sort(comparePaths);
    const output: ExecuteRenamePlanOutput = {
      planId: plan.planId,
      profileId: plan.profileId,
      library: profile.identity.library,
      dryRun: !args.confirm,
      results: results.slice(0, MAX_PLAN_ITEMS_LISTED),
      resultCount: results.length,
      resultsOmitted: Math.max(0, results.length - MAX_PLAN_ITEMS_LISTED),
      counts: {
        renamed: countOf(results, "renamed"),
        wouldRename: countOf(results, "would_rename"),
        changedSincePlan: countOf(results, "changed_since_plan"),
        notFound: countOf(results, "not_found"),
        failed: countOf(results, "failed"),
      },
      excluded: excluded.slice(0, MAX_PLAN_ITEMS_LISTED),
      excludedCount: excluded.length,
      excludedOmitted: Math.max(0, excluded.length - MAX_PLAN_ITEMS_LISTED),
      ...(reversalPlanId === undefined ? {} : { reversalPlanId }),
      reversalEntriesNotRefreshed,
      graphRequests,
    };

    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [{ type: "text" as const, text: executePlanText(output).join("\n") }],
    };
  } catch (error) {
    console.error(`execute_rename_plan failed for profile "${args.profileId}" and plan "${args.planId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}

function resultFor(item: RenamePlanItem, outcome: RenameItemOutcome): RenameItemResult {
  return {
    path: item.path,
    currentName: item.currentName,
    targetName: item.targetName,
    targetPath: item.targetPath,
    client: item.client,
    outcome,
  };
}

function countOf(results: readonly RenameItemResult[], outcome: RenameItemOutcome): number {
  return results.filter((result) => result.outcome === outcome).length;
}
