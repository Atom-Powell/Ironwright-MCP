import { EmptyRelocationError, relocateDriveItem, type RelocateOutcome } from "../../graph/relocate.js";
import { readDriveItemEtag } from "../../graph/rename.js";
import type { RenamePlanItem, StoredPlan } from "../../store/types.js";
import type { ToolContext } from "../context.js";

export type AppliedOutcome = "applied" | "would_apply" | "precondition_refused" | "not_found" | "target_name_taken" | "failed";

export interface AppliedItem {
  item: RenamePlanItem;
  outcome: AppliedOutcome;
}

export interface ApplyPlanResult {
  results: AppliedItem[];
  graphOperationsIssued: number;
  reversalEntriesNotRefreshed: number;
  reversalPlanId?: string;
}

export function comparePaths(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * The inverse of a forward plan, ready before the first write.
 *
 * Each entry carries the forward item's PRE-write etag, which is stale for the
 * inverse operation by construction: the write it undoes has not happened yet,
 * and when it does it will change the etag. The executor overwrites each entry
 * as its write lands. An entry that never gets overwritten keeps the stale
 * value and is refused on replay, which is the safe direction: a stale
 * precondition declines to act, where an absent one would relocate whatever
 * happens to be sitting at that path.
 *
 * The swap is kind-independent: an item's `path` and `targetPath` are both full
 * paths, so swapping them undoes a rename, a move, or both at once.
 */
export function reversalItemsFor(items: readonly RenamePlanItem[]): RenamePlanItem[] {
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
 * What one item asks Graph to change, derived from the item rather than from
 * the plan's kind: a field is sent only when it differs. A rename item keeps
 * its folder, so it sends exactly `{ name }`, the body phase 6a verified live.
 */
function relocationFor(item: RenamePlanItem): { newName?: string; newParentPath?: string } {
  const from = parentOf(item.path);
  const to = parentOf(item.targetPath);
  return {
    ...(item.currentName === item.targetName ? {} : { newName: item.targetName }),
    ...(from === to ? {} : { newParentPath: to }),
  };
}

/**
 * Applies a stored plan of any kind, or previews it.
 *
 * One loop walks every item, whether this is a dry run or a confirmed run. Its
 * first statement is the dry-run branch, so a decision added to the confirmed
 * path later is added inside the same loop body a reviewer is already reading,
 * rather than inside a second, separately maintained preview implementation
 * that could omit it without anything failing.
 */
export async function applyPlan(
  plan: StoredPlan,
  options: { confirm: boolean; context: ToolContext; profileId: string; toolName: string; makeReversalPlanId: () => string },
): Promise<ApplyPlanResult> {
  const { confirm, context, profileId, toolName } = options;
  const sorted = [...plan.items].sort(comparePaths);
  const results: AppliedItem[] = [];
  let graphOperationsIssued = 0;
  let reversalEntriesNotRefreshed = 0;

  // Created and saved before the loop, but only when there is a run to
  // reverse: a dry run changes nothing, so it has nothing to roll back.
  // Written before the first write, so a crash mid-apply still leaves
  // something to roll back with. It necessarily over-covers at this point,
  // listing inverses for writes that have not happened. Such an entry keeps
  // the forward item's pre-write etag, so replaying it is refused on that
  // precondition: Graph checks If-Match before existence and answers 412
  // whether the path is empty or, as the 2026-09-24 sitting's step 6
  // measured, holds a different file. The refusal is reported as
  // precondition_refused, which is how the over-coverage corrects itself
  // through the same machinery without touching whatever sits there.
  let reversal: StoredPlan | undefined;
  if (confirm) {
    reversal = {
      planId: options.makeReversalPlanId(),
      profileId,
      kind: plan.kind,
      driveId: plan.driveId,
      createdAt: context.now().toISOString(),
      items: reversalItemsFor(sorted),
      excluded: [],
      reverses: plan.planId,
    };
    await context.store.savePlan(profileId, reversal);
  }

  for (const [index, item] of sorted.entries()) {
    if (!confirm) {
      results.push({ item, outcome: "would_apply" });
      continue;
    }
    if (reversal === undefined) {
      // Cannot happen: reversal is created above whenever confirm is true,
      // and this branch runs only when confirm is true too. The check exists
      // so the compiler agrees with that, not only this comment.
      continue;
    }

    // The PATCH gets its own error boundary. Once it answers, the outcome is
    // settled: nothing past this point may overwrite it. A prior version of
    // this function shared one try/catch for the PATCH and the bookkeeping
    // that follows a success, so a failure refreshing the reversal entry or
    // saving it overwrote an already-observed "renamed" with "failed", the
    // report contradicting what the function itself had just seen happen.
    //
    // An item that changes neither name nor folder is settled as failed
    // here, before the counter moves, rather than left for relocateDriveItem
    // to refuse: that refusal happens before any request, so counting it
    // would report a Graph operation this call never issued.
    let written: RelocateOutcome | "failed";
    const relocation = relocationFor(item);
    if (relocation.newName === undefined && relocation.newParentPath === undefined) {
      console.error(
        `${toolName} could not apply "${item.path}" under plan "${plan.planId}"`,
        new EmptyRelocationError(item.path),
      );
      written = "failed";
    } else {
      try {
        graphOperationsIssued += 1;
        written = await relocateDriveItem(context.graph, {
          driveId: plan.driveId,
          path: item.path,
          etag: item.etag,
          ...relocation,
        });
      } catch (error) {
        // Recorded and continued rather than rethrown. Rethrowing would
        // discard the report, which is the operator's only account of which
        // writes already applied; the reversal log alone does not say which
        // of its entries are live.
        console.error(`${toolName} could not apply "${item.path}" under plan "${plan.planId}"`, error);
        written = "failed";
      }
    }

    let outcome: AppliedOutcome;
    if (written === "failed") {
      outcome = "failed";
    } else if (written.kind === "precondition_failed") {
      outcome = "precondition_refused";
    } else if (written.kind === "not_found") {
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
    } else if (written.kind === "name_conflict") {
      // Another file held the target name when the write was attempted, and
      // Graph refused rather than replace it, so nothing was replaced and
      // this item is not in the reversal log's live set. When that file
      // arrived is not observable here: the plan-time scan may simply
      // predate it.
      outcome = "target_name_taken";
    } else {
      // The write is done. This outcome is final; the bookkeeping below has
      // its own error boundary specifically so it cannot change it.
      outcome = "applied";
      try {
        let fresh = written.etag;
        if (fresh === undefined) {
          // Graph's documented PATCH response is the updated item, so this
          // branch should not run. It exists because "should" is not
          // "does", and this project has paid once for designing against
          // an API surface nobody had called.
          graphOperationsIssued += 1;
          const lookup = await readDriveItemEtag(context.graph, { driveId: plan.driveId, path: item.targetPath });
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
          await context.store.savePlan(profileId, reversal);
        }
      } catch (error) {
        // The write already happened, so this failure is about the
        // reversal entry, not about whether the file was relocated. Reported
        // as an unrefreshed entry rather than rethrown or turned into
        // "failed", for the same reason the PATCH's own catch above does
        // not touch a settled outcome: a rollback that cannot undo this
        // item is a defect in the reversal log, not evidence the forward
        // write did not happen.
        console.error(
          `${toolName} applied "${item.path}" under plan "${plan.planId}" but could not refresh its reversal entry`,
          error,
        );
        reversalEntriesNotRefreshed += 1;
      }
    }
    results.push({ item, outcome });
  }

  return {
    results,
    graphOperationsIssued,
    reversalEntriesNotRefreshed,
    ...(reversal === undefined ? {} : { reversalPlanId: reversal.planId }),
  };
}
