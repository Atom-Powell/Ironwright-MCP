import type { ExecuteRenamePlanOutput, GenerateRenamePlanOutput } from "./output.js";

/**
 * Every line states something the output actually carries. Nothing here infers
 * what will happen when the plan runs: the plan's preconditions are checked at
 * execution, and a line here promising success would be exactly the message
 * this project produced nine times, correct on its own and wrong about what
 * the program did.
 */
export function generatePlanText(output: GenerateRenamePlanOutput): string[] {
  const lines = [
    `Plan ${output.planId} for profile "${output.profileId}", library "${output.library}".`,
    `${String(output.itemCount)} ${output.itemCount === 1 ? "rename" : "renames"} planned, ` +
      `${String(output.excludedCount)} excluded.`,
    `Based on a repository scan taken at ${output.scannedAt}.`,
  ];

  for (const item of output.items) {
    lines.push(`  ${item.path} -> ${item.targetName}`);
  }
  if (output.itemsOmitted > 0) {
    lines.push(`  ...and ${String(output.itemsOmitted)} more, all of them in the stored plan.`);
  }

  for (const item of output.excluded) {
    lines.push(`  excluded: ${item.path} (${item.reason})`);
  }
  if (output.excludedOmitted > 0) {
    lines.push(`  ...and ${String(output.excludedOmitted)} more exclusions, all of them in the stored plan.`);
  }

  lines.push(
    `Graph requests: ${String(output.workbookReadGraphRequestsByThisCall)} for the workbook, ` +
      `${String(output.scanGraphRequestsByThisCall)} for the scan. ` +
      `${String(output.etagLookupsIssued)} etag lookups issued, not counted as Graph requests since a retried ` +
      "lookup can spend more than one.",
  );
  lines.push(`Review this plan, then apply it with execute_rename_plan. It runs as a dry run unless confirm is true.`);

  return lines;
}

/**
 * Says what happened and nothing more. In particular the dry-run line states
 * that no precondition was checked, because a dry run contacts Graph not at
 * all: a reader who took a clean preview as a guarantee that every rename will
 * apply would be reading an assertion this code never made.
 */
export function executePlanText(output: ExecuteRenamePlanOutput): string[] {
  const lines = output.dryRun
    ? [
        `Dry run of plan ${output.planId} against drive ${output.driveId}. Nothing was changed.`,
        `${String(output.counts.wouldRename)} ${output.counts.wouldRename === 1 ? "rename" : "renames"} would be attempted.`,
        "This preview contacted Graph not at all, so it did not check whether any file has changed since the plan " +
          "was generated. Those refusals can only appear in a confirmed run.",
      ]
    : [
        `Applied plan ${output.planId} against drive ${output.driveId}.`,
        `${String(output.counts.renamed)} renamed, ${String(output.counts.preconditionRefused)} refused because ` +
          `the item there is not the one the plan recorded, ${String(output.counts.targetNameTaken)} refused ` +
          `because another file already holds the target name, ${String(output.counts.notFound)} no longer at ` +
          `the planned path, ${String(output.counts.failed)} failed.`,
      ];

  // Stated before the item listing rather than beside the reversal line at the
  // end, because it changes what every line below it means: these renames undo
  // another plan's rather than apply new ones. Without it a rollback's report
  // reads exactly like a forward run's.
  if (output.reverses !== undefined) {
    lines.push(`This plan reverses plan ${output.reverses}.`);
  }

  for (const result of output.results) {
    lines.push(`  ${result.path} -> ${result.targetName} (${result.outcome})`);
  }
  if (output.resultsOmitted > 0) {
    lines.push(`  ...and ${String(output.resultsOmitted)} more, all of them counted above.`);
  }

  for (const item of output.excluded) {
    lines.push(`  excluded at plan time: ${item.path} (${item.reason})`);
  }
  if (output.excludedOmitted > 0) {
    lines.push(`  ...and ${String(output.excludedOmitted)} more exclusions, all of them counted above.`);
  }

  if (output.reversalPlanId !== undefined) {
    lines.push(`Reversal plan ${output.reversalPlanId}. Apply it with this same tool to roll this run back.`);
  }
  if (output.reversalEntriesNotRefreshed > 0) {
    lines.push(
      `${String(output.reversalEntriesNotRefreshed)} reversal ${output.reversalEntriesNotRefreshed === 1 ? "entry" : "entries"} ` +
        "could not be given the file's new ETag, so replaying the reversal will refuse those items rather than " +
        "undo them. Generate a fresh plan for those files.",
    );
  }
  lines.push(`Graph operations issued: ${String(output.graphOperationsIssued)}.`);

  return lines;
}
