import type { GenerateRenamePlanOutput } from "./output.js";

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
      `${String(output.scanGraphRequestsByThisCall)} for the scan, ` +
      `${String(output.etagLookupGraphRequests)} for the etag lookups.`,
  );
  lines.push(`Review this plan, then apply it with execute_rename_plan. It runs as a dry run unless confirm is true.`);

  return lines;
}
