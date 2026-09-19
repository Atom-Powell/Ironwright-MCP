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
 * One loop walks every item, whether this is a dry run or a confirmed run. Its
 * first statement is the dry-run branch, so a decision added to the confirmed
 * path later is added inside the same loop body a reviewer is already reading,
 * rather than inside a second, separately maintained preview implementation
 * that could omit it without anything failing.
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
    let graphOperationsIssued = 0;
    let reversalEntriesNotRefreshed = 0;
    let reversalPlanId: string | undefined;

    // Created and saved before the loop, but only when there is a run to
    // reverse: a dry run changes nothing, so it has nothing to roll back.
    // Written before the first rename, so a crash mid-apply still leaves
    // something to roll back with. It necessarily over-covers at this point,
    // listing inverses for renames that have not happened; replaying one of
    // those finds nothing at the source path and reports it, which is how the
    // over-coverage corrects itself through the same machinery.
    let reversal: StoredPlan | undefined;
    if (args.confirm) {
      reversal = {
        planId: makeReversalPlanId(),
        profileId: args.profileId,
        kind: "rename",
        driveId: plan.driveId,
        createdAt: context.now().toISOString(),
        items: reversalItemsFor(sorted),
        excluded: [],
        reverses: plan.planId,
      };
      await context.store.savePlan(args.profileId, reversal);
      reversalPlanId = reversal.planId;
    }

    for (const [index, item] of sorted.entries()) {
      if (!args.confirm) {
        results.push(resultFor(item, "would_rename"));
        continue;
      }
      if (reversal === undefined) {
        // Cannot happen: reversal is created above whenever args.confirm is
        // true, and this branch runs only when args.confirm is true too. The
        // check exists so the compiler agrees with that, not only this
        // comment.
        continue;
      }

      // The PATCH gets its own error boundary. Once it answers, the outcome is
      // settled: nothing past this point may overwrite it. A prior version of
      // this function shared one try/catch for the PATCH and the bookkeeping
      // that follows a success, so a failure refreshing the reversal entry or
      // saving it overwrote an already-observed "renamed" with "failed", the
      // report contradicting what the function itself had just seen happen.
      let renameResult: Awaited<ReturnType<typeof renameDriveItem>> | "failed";
      try {
        graphOperationsIssued += 1;
        renameResult = await renameDriveItem(context.graph, {
          driveId: plan.driveId,
          path: item.path,
          newName: item.targetName,
          etag: item.etag,
        });
      } catch (error) {
        // Recorded and continued rather than rethrown. Rethrowing would
        // discard the report, which is the operator's only account of which
        // renames already applied; the reversal log alone does not say which
        // of its entries are live.
        console.error(`execute_rename_plan could not rename "${item.path}" under plan "${plan.planId}"`, error);
        renameResult = "failed";
      }

      let outcome: RenameItemOutcome;
      if (renameResult === "failed") {
        outcome = "failed";
      } else if (renameResult.kind === "precondition_failed") {
        outcome = "precondition_refused";
      } else if (renameResult.kind === "not_found") {
        // Unreachable while this executor always sends If-Match. The live probe
        // at .superpowers/live-sitting/probe-precondition.ts measured Graph
        // evaluating If-Match before existence: a stale precondition against a
        // path holding nothing answers 412, never 404. Kept rather than
        // removed, the same way src/domain/rename/plan.ts keeps its own
        // unreachable collision branches labeled instead of deleted: nothing
        // proves a negative, and removing a branch on a write path is the
        // worse risk. readDriveItemEtag's own 404 mapping is not affected by
        // this: that call is a GET carrying no precondition at all, so its 404
        // stays live and meaningful.
        outcome = "not_found";
      } else {
        // The rename is done. This outcome is final; the bookkeeping below has
        // its own error boundary specifically so it cannot change it.
        outcome = "renamed";
        try {
          let fresh = renameResult.etag;
          if (fresh === undefined) {
            // Graph's documented PATCH response is the updated item, so this
            // branch should not run. It exists because "should" is not
            // "does", and this project has paid once for designing against
            // an API surface nobody had called.
            graphOperationsIssued += 1;
            const lookup = await readDriveItemEtag(context.graph, {
              driveId: plan.driveId,
              path: item.targetPath,
            });
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
        } catch (error) {
          // The rename already happened, so this failure is about the
          // reversal entry, not about whether the file was renamed. Reported
          // as an unrefreshed entry rather than rethrown or turned into
          // "failed", for the same reason the PATCH's own catch above does
          // not touch a settled outcome: a rollback that cannot undo this
          // item is a defect in the reversal log, not evidence the forward
          // rename did not happen.
          console.error(
            `execute_rename_plan renamed "${item.path}" under plan "${plan.planId}" but could not refresh its ` +
              "reversal entry",
            error,
          );
          reversalEntriesNotRefreshed += 1;
        }
      }
      results.push(resultFor(item, outcome));
    }

    const excluded = [...plan.excluded].sort(comparePaths);
    const output: ExecuteRenamePlanOutput = {
      planId: plan.planId,
      profileId: plan.profileId,
      // The plan's drive, not the profile's library name. Every write above
      // addressed plan.driveId, and a profile whose identity.library changed
      // after this plan was generated would make that name describe a library
      // this call did not touch.
      driveId: plan.driveId,
      ...(plan.reverses === undefined ? {} : { reverses: plan.reverses }),
      dryRun: !args.confirm,
      results: results.slice(0, MAX_PLAN_ITEMS_LISTED),
      resultCount: results.length,
      resultsOmitted: Math.max(0, results.length - MAX_PLAN_ITEMS_LISTED),
      counts: {
        renamed: countOf(results, "renamed"),
        wouldRename: countOf(results, "would_rename"),
        preconditionRefused: countOf(results, "precondition_refused"),
        notFound: countOf(results, "not_found"),
        failed: countOf(results, "failed"),
      },
      excluded: excluded.slice(0, MAX_PLAN_ITEMS_LISTED),
      excludedCount: excluded.length,
      excludedOmitted: Math.max(0, excluded.length - MAX_PLAN_ITEMS_LISTED),
      ...(reversalPlanId === undefined ? {} : { reversalPlanId }),
      reversalEntriesNotRefreshed,
      graphOperationsIssued,
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
