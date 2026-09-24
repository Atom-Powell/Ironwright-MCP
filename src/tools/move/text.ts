import type { GenerateMovePlanOutput } from "./output.js";

/** Every line states something the output carries, for the reason rename/text.ts gives. */
export function generateMovePlanText(output: GenerateMovePlanOutput): string[] {
  const lines = [
    `Plan ${output.planId} for profile "${output.profileId}", library "${output.library}".`,
    `${String(output.itemCount)} ${output.itemCount === 1 ? "move" : "moves"} planned, ${String(output.excludedCount)} excluded.`,
    `Based on a repository scan taken at ${output.scannedAt}.`,
  ];
  for (const item of output.items) lines.push(`  ${item.path} -> ${item.targetPath}`);
  if (output.itemsOmitted > 0) lines.push(`  ...and ${String(output.itemsOmitted)} more, all of them in the stored plan.`);
  for (const item of output.excluded) {
    lines.push(`  excluded: ${item.path} (${item.reason}${item.library === undefined ? "" : `, found in library "${item.library}"`})`);
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
  lines.push("Review this plan, then apply it with execute_move_plan. It runs as a dry run unless confirm is true.");
  return lines;
}
